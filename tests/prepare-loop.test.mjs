// prepare_print_project's loop (src/tuning/prepare.ts) against a fake slicer: the slice function is injected and answers from a script, everything else
// is real (the writer builds and re-opens every candidate 3MF, the engine and the fact collector run, the report is built). Proves the order of the
// slices, the ladder stepping, the stops, best-so-far, the verdict rules, and that the source is never touched and the output never overwrites.
// The real Bambu Studio CLI is tests/prepare-e2e.test.mjs.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import JSZip from "jszip";
import { fileURLToPath } from "node:url";
import { getTuning } from "../dist/tuning/loader.js";
import { prepareProject } from "../dist/tuning/prepare.js";
import { studioRetargeter } from "../dist/tuning/retarget.js";
import { parsePrepareArgs, PREPARE_TOOLS } from "../dist/tuning/prepare-tool.js";

const SERVER = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "dist", "index.js");
const X2D = "Bambu Lab X2D 0.4 nozzle";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const CROSS = "gcode.unprotected_travel_crossing_count";

// ---------------------------------------------------------------- a project for the X2D, and the actions the script plays with
const variants = ["Direct Drive Standard", "Direct Drive High Flow", "Bowden Standard"];
const baseConfig = (extra = {}) => ({
  printer_settings_id: X2D, print_settings_id: "0.20mm Standard @BBL X2D", printer_model: "Bambu Lab X2D",
  filament_settings_id: ["Bambu PLA Basic @BBL X2D 0.4 nozzle"], filament_type: ["PLA"], nozzle_diameter: ["0.4", "0.4"],
  print_extruder_variant: variants, print_extruder_id: ["1", "1", "2"], printer_extruder_variant: variants, printer_extruder_id: ["1", "1", "2"],
  sparse_infill_pattern: "grid", wall_loops: "2", top_shell_layers: "3", seam_position: "aligned", detect_overhang_wall: "1", layer_height: "0.2",
  different_settings_to_system: ["", "", ""], ...extra,
});
const MODEL_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="Part"/>
    <metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part"><metadata key="name" value="Part"/></part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance>
  </plate>
</config>
`;
const SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?><config><header><header_item key="X-BBL-Client-Version" value="02.08.04.57"/></header></config>`;
/** A model with one cube object (id 2) of `size` mm per side, the object model_settings.config puts on plate 1. */
const cubeModel = size => `<?xml version="1.0"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="2" type="model"><mesh><vertices>${[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(v => `<vertex x="${v[0] * size}" y="${v[1] * size}" z="${v[2] * size}"/>`).join("")}</vertices><triangles>${[[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]].map(t => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join("")}</triangles></mesh></object></resources><build><item objectid="2"/></build></model>`;
async function writeSource(file, config = baseConfig(), model = "<model/>") {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("3D/3dmodel.model", model);
  zip.file("Metadata/project_settings.config", JSON.stringify(config, null, 4));
  zip.file("Metadata/model_settings.config", MODEL_SETTINGS);
  zip.file("Metadata/slice_info.config", SLICE_INFO);
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
}
const readCfg = async file => JSON.parse(await (await JSZip.loadAsync(await fs.readFile(file))).file("Metadata/project_settings.config").async("string"));

const meta = { rules: ["bambu.travel.unprotected-travel"], topic: "bambu.travel.unprotected-travel-bug", rationale: "test", src: ["guide:1-2"], printers: [], applies_to: null, when_text: "", title: "t" };
/** A ladder: steps = [[key, value, confidence?]]; the trigger is fact > 0. */
const ladder = (id, fact, steps, extra = {}) => ({
  ...meta, id, title: id, kind: "ladder", phase: "post-slice", scope: "process", when: { all: [] }, confidence: "hipotese", risk: "low", priority: 10, relax: false,
  trigger: { all: [{ fact, op: "gt", value: "0" }] },
  steps: steps.map(([key, value, confidence = "oficial"]) => ({ set: { [key]: value }, why: `step ${key}=${value}`, cost: "tempo", expect: "fewer", confidence, src: ["guide:3-4"] })),
  exhausted: `EXHAUSTED ${id}`, ...extra,
});
const definite = (id, set, confidence = "preset", extra = {}) => ({ ...meta, id, title: id, phase: "pre-slice", scope: "process", when: { all: [] }, confidence, risk: "low", priority: 5, mode: "set", set, ...extra });

// ---------------------------------------------------------------- the fake slicer
function outcome({ time = 3600, weight = 20, facts = {}, block, warnings = [] } = {}) {
  const all = { "gcode.layer_count": 100, ...facts };
  return {
    gcode: { facts: all, evidence: Object.fromEntries(Object.keys(all).map(k => [k, { source: "fake", method: "scripted", approx: false, notes: "" }])), complete: true, blind: [], stats: { lines: 1, bytes: 1, ms: 1 }, details: { header: {} } },
    slice: { sliceInfo: { plate: { metadata: [{ key: "index", value: "1" }, { key: "prediction", value: String(time) }, { key: "weight", value: String(weight) }], filament: { id: "1", type: "PLA", used_g: String(weight), used_m: "5" }, ...(warnings.length ? { warning: warnings.map(msg => ({ msg, level: "1", error_code: "1" })) } : {}) } } },
    block, ms: 10,
  };
}
const crossing = (n, extra) => outcome({ facts: { [CROSS]: n }, ...extra });

async function setup(t, { config, model } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prepare-loop-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "part.3mf");
  await writeSource(source, config, model);
  return { dir, source, out: path.join(dir, "out") };
}
/** script: one entry per slice call (an outcome, an Error to throw, or a function(call) returning either); the last entry repeats. */
function harness({ dir, source, out }, { actions, script, noAction = [], preflight, open, now, retarget, input = {} }) {
  const calls = [];
  const opened = [];
  const slice = async (file, signal) => {
    const call = { n: calls.length, file: path.basename(file), cfg: await readCfg(file), signal };
    calls.push(call);
    let step = script[Math.min(call.n, script.length - 1)];
    if (typeof step === "function") step = await step(call);
    if (step instanceof Error) throw step;
    return step;
  };
  const deps = {
    tuning: { actions, noAction }, printerPreset: X2D, tempDir: path.join(dir, "tmp"), slice, installedStudio: async () => "02.08.04.57",
    preflight: preflight ?? (async () => ({ findings: [] })), openInStudio: open ?? (async file => { opened.push(file); return { opened: true, file_path: file }; }), ...(now ? { now } : {}), ...(retarget ? { retarget } : {}),
  };
  const args = { path: source, plateIndex: 0, model: "x2d", maxSlices: 12, maxMinutes: 20, outputDir: out, openInStudio: false, apply: "recommended", dryRun: false, ...input };
  return { calls, opened, run: () => prepareProject(args, deps) };
}
const history = r => r.history.map(h => h.round);
const changedKeys = r => r.diff.tuning.map(c => c.key).sort();
async function assertSourceUntouched(source, before, report) {
  assert.equal(sha(await fs.readFile(source)), before);
  assert.equal(report.source.unchanged, true);
}

// ---------------------------------------------------------------- order, ladders, verdicts
test("the baseline is sliced first and untouched, round 0 is the tuned candidate; a pre-slice change is PREDICTED ONLY and the verdict says so", async t => {
  const env = await setup(t);
  const before = sha(await fs.readFile(env.source));
  const h = harness(env, { actions: [definite("tune.def", { top_shell_layers: "5" }), ladder("tune.travel", CROSS, [["sparse_infill_pattern", "gyroid"]])], script: [crossing(0, { time: 3600 }), crossing(0, { time: 3700 })] });
  const r = await h.run();
  assert.equal(h.calls.length, 2, "baseline + round 0, then the engine reads round 0 and is done");
  assert.equal(h.calls[0].file, "p0.3mf");
  assert.equal(h.calls[0].cfg.top_shell_layers, "3", "the baseline is the untuned project");
  assert.equal(h.calls[1].file, "round-0.3mf");
  assert.equal(h.calls[1].cfg.top_shell_layers, "5", "round 0 carries the pre-slice tuning");
  assert.equal(r.stop.reason, "done");
  assert.deepEqual(history(r), [0]);
  assert.deepEqual(r.stop.slices_used, { loop: 2, retarget: 0, total: 2, max: 12 });
  assert.equal(r.delivered.round, 0);
  assert.equal(r.delivered.sliced, false);
  const cfg = await readCfg(r.delivered.path);
  assert.equal(cfg.top_shell_layers, "5");
  assert.match(cfg.different_settings_to_system[0], /top_shell_layers/);
  assert.equal(cfg.sparse_infill_pattern, "grid", "no ladder step was needed");
  const change = r.diff.tuning[0];
  assert.deepEqual([change.key, change.from, change.to, change.scope, change.action, change.confidence, change.round], ["top_shell_layers", "3", "5", "process", "tune.def", "preset", 0]);
  assert.equal(change.verified, false);
  assert.equal(change.verification.status, "predicted_only");
  assert.deepEqual(r.predicted_only.map(p => p.key), ["top_shell_layers"]);
  assert.equal(r.verdict, "ready_with_caveats");
  assert.ok(r.caveats.some(c => c.code === "predicted_only_applied"));
  assert.deepEqual(r.metrics.rows.find(m => m.fact === "plate.time_s"), { fact: "plate.time_s", label: r.metrics.rows[0].label, before: 3600, after: 3700, delta: 100 });
  await assertSourceUntouched(env.source, before, r);
  assert.match(r.resumo, /PRONTO COM RESSALVAS/);
  assert.match(r.resumo, /SÓ PREVISTO/);
});

test("a ladder steps one level per round until the measured trigger clears; every change is VERIFIED by the fact and the verdict is ready", async t => {
  const env = await setup(t);
  const h = harness(env, {
    actions: [ladder("tune.travel", CROSS, [["sparse_infill_pattern", "gyroid"], ["wall_loops", "3"], ["wall_loops", "4"]])],
    script: [crossing(40), crossing(25), crossing(10), crossing(0)],
  });
  const r = await h.run();
  assert.deepEqual(h.calls.map(c => c.file), ["p0.3mf", "round-1.3mf", "round-2.3mf", "round-3.3mf"], "round 0 changed nothing, so the baseline's measurements stand for it");
  assert.deepEqual(h.calls.map(c => [c.cfg.sparse_infill_pattern, c.cfg.wall_loops]), [["grid", "2"], ["gyroid", "2"], ["gyroid", "3"], ["gyroid", "4"]]);
  assert.equal(r.stop.reason, "done");
  assert.deepEqual(history(r), [0, 1, 2, 3]);
  assert.equal(r.history[0].slice.reused_from, "baseline");
  assert.deepEqual(r.history.map(x => x.triggers.true.length), [1, 1, 1, 0]);
  assert.deepEqual(r.history.map(x => x.advanced.length), [0, 1, 1, 1]);
  assert.equal(r.delivered.round, 3);
  assert.deepEqual(changedKeys(r), ["sparse_infill_pattern", "wall_loops"]);
  for (const c of r.diff.tuning) {
    assert.equal(c.verified, true);
    assert.equal(c.verification.outcome, "cleared");
    assert.equal(c.verification.by[0].fact, CROSS);
    assert.equal(c.verification.by[0].after, 0);
  }
  const infill = r.diff.tuning.find(c => c.key === "sparse_infill_pattern");
  assert.equal(infill.verification.by[0].before, 40, "the value measured before the first step");
  assert.equal(infill.first_round, 1);
  assert.equal(r.diff.tuning.find(c => c.key === "wall_loops").round, 3);
  assert.equal(r.diff.tuning.find(c => c.key === "wall_loops").first_round, 2);
  assert.deepEqual(r.predicted_only, []);
  assert.deepEqual(r.metrics.rows.find(m => m.fact === CROSS).delta, -40);
  assert.equal(r.verdict, "ready");
  assert.deepEqual(r.caveats, []);
  assert.deepEqual(r.not_ready_reasons, []);
  assert.doesNotMatch(r.resumo, /Nada ficou sem verificar/, "a ready headline must not claim everything was checked");
  assert.match(r.resumo, /UNSEEN/);
});

test("a weak ladder step that a measured trigger checks is applied and reported as a caveat", async t => {
  const env = await setup(t);
  const h = harness(env, { actions: [ladder("tune.travel", CROSS, [["sparse_infill_pattern", "gyroid", "hipotese"]])], script: [crossing(9), crossing(0)] });
  const r = await h.run();
  assert.equal(r.stop.reason, "done");
  assert.equal(r.diff.tuning[0].confidence, "hipotese");
  assert.equal(r.diff.tuning[0].verified, true);
  assert.equal(r.verdict, "ready_with_caveats");
  assert.deepEqual(r.caveats.map(c => c.code), ["weak_steps_applied"]);
});

test("an exhausted ladder delivers the best round with the guide's text and a caveat verdict", async t => {
  const env = await setup(t);
  const h = harness(env, { actions: [ladder("tune.travel", CROSS, [["sparse_infill_pattern", "gyroid"], ["wall_loops", "3"]])], script: [crossing(30)] });
  const r = await h.run();
  assert.equal(h.calls.length, 3);
  assert.equal(r.stop.reason, "exhausted");
  assert.equal(r.ladders.exhausted[0].action, "tune.travel");
  assert.equal(r.ladders.exhausted[0].text, "EXHAUSTED tune.travel");
  assert.equal(r.verdict, "ready_with_caveats");
  assert.ok(r.caveats.some(c => c.code === "exhausted_ladders"));
  assert.equal(r.diff.tuning.every(c => c.verification.outcome === "not_cleared"), true, "tried and measured, the problem is still there");
  assert.equal(r.delivered.round, 2, "equal on triggers, blockers and time: the later round has more of the tuning");
});

test("the exhausted ladder's text and caveat survive when an earlier, faster round is the one delivered", async t => {
  const env = await setup(t);
  const h = harness(env, { actions: [ladder("tune.travel", CROSS, [["sparse_infill_pattern", "gyroid"], ["wall_loops", "3"]])], script: [crossing(30, { time: 1000 }), crossing(30, { time: 900 }), crossing(30, { time: 2000 })] });
  const r = await h.run();
  assert.equal(r.stop.reason, "exhausted");
  assert.equal(r.delivered.round, 1, "the shortest print time among equals, not the exhausted last round");
  assert.equal(r.ladders.exhausted[0].text, "EXHAUSTED tune.travel");
  assert.deepEqual(r.ladders.unresolved, []);
  assert.ok(r.caveats.some(c => c.code === "exhausted_ladders"));
  assert.ok(r.caveats.some(c => c.code === "earlier_round_delivered"));
  assert.equal(r.verdict, "ready_with_caveats");
});

test("a choice is PREDICTED ONLY even under a benign slice: the engine does not compare its evaluating facts with a target", async t => {
  const env = await setup(t);
  const choice = { ...meta, id: "tune.choice", title: "tune.choice", kind: "choice", phase: "pre-slice", scope: "process", when: { all: [] }, confidence: "relato", risk: "low", priority: 5,
    key: "wall_loops", candidates: ["3", "4"], start: 0, evaluated_by: [CROSS], evaluated_note: "NOTE o efeito real não se mede em arquivo" };
  const r = await harness(env, { actions: [choice], script: [crossing(0)] }).run();
  assert.equal(r.stop.reason, "done");
  const c = r.diff.tuning.find(x => x.key === "wall_loops");
  assert.equal(c.kind, "choice");
  assert.equal(c.verified, false);
  assert.equal(c.verification.status, "predicted_only");
  assert.match(c.verification.note, /NOTE o efeito real/);
  assert.deepEqual(r.predicted_only.map(p => p.key), ["wall_loops"]);
  assert.equal(r.verdict, "ready_with_caveats");
  assert.ok(r.caveats.some(x => x.code === "predicted_only_applied"));
  assert.doesNotMatch(r.resumo, /Nada ficou sem verificar/);
});

test("the slice budget stops the loop with the next step planned but not run", async t => {
  const env = await setup(t);
  const h = harness(env, { actions: [ladder("tune.travel", CROSS, [["sparse_infill_pattern", "gyroid"], ["wall_loops", "3"], ["wall_loops", "4"]])], script: [crossing(30)], input: { maxSlices: 3 } });
  const r = await h.run();
  assert.equal(h.calls.length, 3, "baseline + rounds 1 and 2");
  assert.equal(r.stop.reason, "budget_slices");
  assert.deepEqual(r.stop.slices_used, { loop: 3, retarget: 0, total: 3, max: 3 });
  assert.deepEqual(r.pending_next_round.map(p => p.key), ["wall_loops"]);
  assert.equal(r.verdict, "ready_with_caveats");
  assert.ok(r.caveats.some(c => c.code === "budget"));
  assert.ok(r.delivered, "the best measured round is still delivered");
});

test("the time budget is checked before each slice, counting the last slice's duration", async t => {
  const env = await setup(t);
  let clock = 0;
  const minute = 60_000;
  const h = harness(env, {
    actions: [definite("tune.def", { top_shell_layers: "5" }), ladder("tune.travel", CROSS, [["sparse_infill_pattern", "gyroid"]])],
    script: [() => { clock += 6 * minute; return crossing(30); }],
    now: () => clock, input: { maxMinutes: 13 },
  });
  const r = await h.run();
  assert.deepEqual(h.calls.map(c => c.file), ["p0.3mf", "round-0.3mf"], "after 12 minutes another 6 would pass 13");
  assert.equal(r.stop.reason, "budget_minutes");
  assert.equal(r.stop.minutes_used, 12);
  assert.equal(r.verdict, "ready_with_caveats");
  assert.ok(r.caveats.some(c => c.code === "budget"));
});

test("a step that would repeat an earlier round's settings is a cycle, caught before it is sliced", async t => {
  const env = await setup(t);
  const h = harness(env, { actions: [ladder("tune.travel", CROSS, [["sparse_infill_pattern", "gyroid"], ["sparse_infill_pattern", "honeycomb"], ["sparse_infill_pattern", "gyroid"]])], script: [crossing(30)] });
  const r = await h.run();
  assert.equal(h.calls.length, 3);
  assert.equal(r.stop.reason, "cycle");
  assert.match(r.stop.detail, /repetiria/);
  assert.equal(r.verdict, "ready_with_caveats");
  assert.ok(r.caveats.some(c => c.code === "not_converged"));
});

test("a trigger that depends on a fact nobody declared stalls the loop instead of calling the part done", async t => {
  const env = await setup(t);
  const h = harness(env, { actions: [ladder("tune.mystery", "object.is_large_part", [["sparse_infill_pattern", "gyroid"]])], script: [crossing(0)] });
  const r = await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(r.stop.reason, "stalled");
  assert.match(r.stop.detail, /object\.is_large_part/);
  assert.equal(r.verdict, "ready_with_caveats");
  assert.deepEqual(r.history[0].triggers.unknown, ["tune.mystery"]);
});

test("a trigger fact no analyzer can give is blind: it does not hold the loop back, but it is a caveat and listed as unseen", async t => {
  const env = await setup(t);
  const r = await harness(env, { actions: [ladder("tune.mystery", "gcode.never_measured", [["sparse_infill_pattern", "gyroid"]])], script: [crossing(0)] }).run();
  assert.equal(r.stop.reason, "done");
  assert.equal(r.verdict, "ready_with_caveats");
  assert.deepEqual(r.caveats.map(c => c.code), ["blind_facts"]);
  assert.deepEqual(r.unseen.blind_facts.map(b => b.fact), ["gcode.never_measured"]);
});

test("a failing slice stops the loop, delivers the last good round and says why", async t => {
  const env = await setup(t);
  const h = harness(env, {
    actions: [ladder("tune.travel", CROSS, [["sparse_infill_pattern", "gyroid"], ["wall_loops", "3"], ["wall_loops", "4"]])],
    script: [crossing(40), crossing(30), new Error("Slicer failed: the slicer crashed with SIGSEGV")],
  });
  const r = await h.run();
  assert.equal(r.stop.reason, "error");
  assert.match(r.stop.detail, /SIGSEGV/);
  assert.equal(r.delivered.round, 1);
  assert.equal((await readCfg(r.delivered.path)).wall_loops, "2", "round 2's step is not in the delivered project");
  assert.equal(r.history.at(-1).slice.measured, false);
  assert.match(r.history.at(-1).slice.error, /SIGSEGV/);
  assert.equal(r.verdict, "not_ready");
  assert.ok(r.not_ready_reasons.some(x => x.code === "failed_slice"));
});

test("best-so-far: a later round that is worse on triggers is not delivered, and the report says why", async t => {
  const env = await setup(t);
  const h = harness(env, {
    actions: [ladder("tune.a", "gcode.fact_a", [["sparse_infill_pattern", "gyroid"], ["seam_position", "nearest"]]), ladder("tune.b", "gcode.fact_b", [["wall_loops", "3"], ["wall_loops", "4"]])],
    script: [outcome({ facts: { "gcode.fact_a": 5, "gcode.fact_b": 5 } }), outcome({ facts: { "gcode.fact_a": 0, "gcode.fact_b": 5 } }), outcome({ facts: { "gcode.fact_a": 5, "gcode.fact_b": 5 } })],
    input: { maxSlices: 3 },
  });
  const r = await h.run();
  assert.deepEqual(r.history.map(x => x.triggers.true.length), [2, 1, 2]);
  assert.equal(r.delivered.round, 1);
  assert.match(r.delivered.why_this_round, /menos gatilhos verdadeiros/);
  assert.ok(r.caveats.some(c => c.code === "earlier_round_delivered"));
  const cfg = await readCfg(r.delivered.path);
  assert.deepEqual([cfg.sparse_infill_pattern, cfg.wall_loops, cfg.seam_position], ["gyroid", "3", "aligned"], "round 1's settings, not round 2's");
  assert.equal(r.history[1].delivered, true);
});

test("a blocker rule that the G-code decides counts against a round and makes the verdict not_ready", async t => {
  const env = await setup(t);
  const h = harness(env, { actions: [definite("tune.def", { top_shell_layers: "5" })], script: [outcome(), outcome({ facts: { "gcode.tool_xy_outside_area_count": 4 } })] });
  const r = await h.run();
  assert.deepEqual(r.blockers.gcode.map(b => b.rule), ["bambu.x2d.aux-nozzle-reach-limits"]);
  assert.equal(r.verdict, "not_ready");
  assert.ok(r.not_ready_reasons.some(x => x.code === "blocker"));
  assert.deepEqual(r.history[0].blockers, ["bambu.x2d.aux-nozzle-reach-limits"]);
});

test("a part larger than the printer's volume is a blocker the run judges itself: preflight_check cannot read mesh.size_* from a 3MF", async t => {
  const env = await setup(t, { model: cubeModel(300) });
  const r = await harness(env, { actions: [], script: [crossing(0)] }).run();
  assert.equal(r.part.mesh.size_x_mm, 300);
  assert.deepEqual(r.blockers.gcode.map(b => b.rule), ["bambu.x2d.main-volume-exceeded"]);
  assert.equal(r.blockers.gcode[0].evidence["mesh.size_x_mm"], 300);
  assert.equal(r.verdict, "not_ready");
  assert.ok(r.not_ready_reasons.some(x => x.code === "blocker" && /main-volume-exceeded/.test(x.text)));

  const fits = await harness(await setup(t, { model: cubeModel(50) }), { actions: [], script: [crossing(0)] }).run();
  assert.deepEqual(fits.blockers.gcode, []);
  assert.ok(fits.verified.measured.gcode_blockers_checked_and_clear.includes("bambu.x2d.main-volume-exceeded"), "judged and clear, not skipped");
  assert.ok(fits.unseen.gcode_blockers_not_decidable.some(b => b.rule === "bambu.cut.exceeds-build-volume"), "a blocker the facts cannot decide is listed as unseen");
});

test("the slicer's own warnings are a caveat, never a clean ready, and their text is in the report", async t => {
  const warning = "bed_temperature_too_high_than_filament";
  const r = await harness(await setup(t), { actions: [], script: [outcome({ warnings: [warning] })] }).run();
  assert.equal(r.stop.reason, "done");
  assert.equal(r.verdict, "ready_with_caveats");
  assert.ok(r.caveats.some(c => c.code === "slicer_warnings" && c.text.includes(warning)));
  assert.deepEqual(r.verified.measured.slicer_warnings, [warning]);
  assert.match(r.resumo, new RegExp(warning));

  const clean = await harness(await setup(t), { actions: [], script: [crossing(0)] }).run();
  assert.equal(clean.verdict, "ready");
  assert.deepEqual(clean.verified.measured.slicer_warnings, []);
});

test("a deliverable that cannot be written ends the run as an error with the report intact, not as a thrown call", async t => {
  const env = await setup(t);
  const file = path.join(env.dir, "not-a-folder");
  await fs.writeFile(file, "x");
  const h = harness(env, { actions: [definite("tune.def", { top_shell_layers: "5" })], script: [crossing(0)], input: { outputDir: path.join(file, "sub"), openInStudio: true } });
  const r = await h.run();
  assert.equal(h.calls.length, 2, "baseline and round 0 were sliced and are not thrown away");
  assert.equal(r.stop.reason, "error");
  assert.match(r.stop.detail, /Não foi possível gravar o projeto entregue/);
  assert.equal(r.delivered, null);
  assert.equal(r.verdict, "not_ready");
  assert.ok(r.not_ready_reasons.some(x => x.code === "failed_slice" && /Não foi possível gravar/.test(x.text)));
  assert.ok(r.warnings.some(w => /Não foi possível gravar/.test(w)));
  assert.deepEqual(r.history.map(x => x.round), [0]);
  assert.deepEqual(changedKeys(r), ["top_shell_layers"], "the diff survives");
  assert.deepEqual(h.opened, []);
});

test("the retarget's real slices count against max_slices", async t => {
  const env = await setup(t, { config: baseConfig({ printer_settings_id: "Bambu Lab H2D 0.4 nozzle" }) });
  const donor = path.join(env.dir, "donor.3mf");
  await writeSource(donor);
  const archive = await fs.readFile(donor);
  const retarget = async () => ({ archive, report: null, edited: [], slices: 1 });
  const h = harness(env, { actions: [definite("tune.def", { top_shell_layers: "5" })], script: [crossing(0)], retarget, input: { maxSlices: 2 } });
  const r = await h.run();
  assert.deepEqual(h.calls.map(c => c.file), ["p0.3mf"], "the retarget slice and the baseline use the budget; round 0 is not sliced");
  assert.equal(r.stop.reason, "budget_slices");
  assert.deepEqual(r.stop.slices_used, { loop: 1, retarget: 1, total: 2, max: 2 });
});

test("preflight_check judges the deliverable: its blockers make the verdict not_ready, an error makes it a caveat", async t => {
  const env = await setup(t);
  let checked;
  const blocker = { rule_id: "bambu.x2d.main-volume-exceeded", severity: "blocker", title: "Peça maior que o volume", problem: "p", confidence: "preset", evidence: { "mesh.size_x_mm": 300 }, fix: { message: "m" } };
  const h = harness(env, { actions: [], script: [crossing(0)], preflight: async args => { checked = args; return { findings: [blocker] }; } });
  const r = await h.run();
  assert.equal(path.basename(checked.file_path), "part_tuned.3mf", "the deliverable, not the source");
  assert.deepEqual([checked.bambu_model, checked.min_severity, checked.plate_index], ["x2d", "blocker", 0]);
  assert.equal(r.verdict, "not_ready");
  assert.equal(r.blockers.preflight[0].rule_id, "bambu.x2d.main-volume-exceeded");

  const env2 = await setup(t);
  const r2 = await harness(env2, { actions: [], script: [crossing(0)], preflight: async () => { throw new Error("boom"); } }).run();
  assert.equal(r2.verdict, "ready_with_caveats");
  assert.ok(r2.caveats.some(c => c.code === "preflight_unavailable"));
  assert.ok(r2.warnings.some(w => /boom/.test(w)));
});

test("a project with nothing to change reuses the baseline's measurements and is ready after one slice", async t => {
  const env = await setup(t);
  const h = harness(env, { actions: [ladder("tune.travel", CROSS, [["sparse_infill_pattern", "gyroid"]])], script: [crossing(0)] });
  const r = await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(r.stop.reason, "done");
  assert.deepEqual(r.diff.tuning, []);
  assert.equal(r.history[0].slice.reused_from, "baseline");
  assert.equal(r.verdict, "ready");
});

// ---------------------------------------------------------------- cancellation, dry run, files
test("cancelling during a slice ends the loop as cancelled: not_ready, nothing delivered, nothing opened", async t => {
  const env = await setup(t);
  const controller = new AbortController();
  const h = harness(env, {
    actions: [ladder("tune.travel", CROSS, [["sparse_infill_pattern", "gyroid"], ["wall_loops", "3"]])],
    script: [crossing(30), crossing(30), () => { controller.abort(); return new Error("Slicing cancelled; the slicer process was stopped"); }],
    input: { signal: controller.signal, openInStudio: true },
  });
  const r = await h.run();
  assert.equal(r.stop.reason, "cancelled");
  assert.equal(r.verdict, "not_ready");
  assert.equal(r.delivered, null);
  assert.deepEqual(h.opened, []);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every(c => c.signal === controller.signal), "the baseline and every round hand the abort signal to the slicer, so a cancel can kill the CLI");
  await assert.rejects(fs.stat(env.out), /ENOENT/, "no deliverable folder");
});

test("a call that is already cancelled never starts", async t => {
  const env = await setup(t);
  const controller = new AbortController();
  controller.abort();
  const h = harness(env, { actions: [], script: [crossing(0)], input: { signal: controller.signal } });
  await assert.rejects(h.run(), /abort/i);
  assert.equal(h.calls.length, 0);
});

test("dry_run plans from the project's own data, never slices and delivers nothing", async t => {
  const env = await setup(t);
  const before = sha(await fs.readFile(env.source));
  const h = harness(env, {
    actions: [definite("tune.def", { top_shell_layers: "5" }), definite("tune.weak", { seam_position: "nearest" }, "hipotese"), definite("tune.ctx", { wall_loops: "4" }, "relato", { when: { all: [{ fact: "object.load_class", op: "eq", value: "functional" }] } })],
    script: [new Error("a dry run must not slice")], input: { dryRun: true, openInStudio: true },
  });
  const r = await h.run();
  assert.equal(h.calls.length, 0);
  assert.equal(r.stop.reason, "dry_run");
  assert.equal(r.delivered, null);
  assert.equal(r.verdict, "not_ready");
  assert.ok(r.not_ready_reasons.some(x => x.code === "dry_run"));
  assert.deepEqual(changedKeys(r), ["top_shell_layers"], "the plan: the definite change; the weak one is a suggestion; the context-bound one is skipped");
  assert.deepEqual(r.suggestions_not_applied.map(s => s.key), ["seam_position"]);
  assert.equal(r.suggestions_not_applied[0].confidence, "hipotese");
  assert.equal(r.skipped.for_undescribed_part.count, 1);
  assert.equal(r.skipped.declare_to_enable[0].fact, "object.load_class");
  assert.deepEqual(r.skipped.declare_to_enable[0].would_enable.map(a => a.action), ["tune.ctx"]);
  assert.deepEqual(h.opened, []);
  await assert.rejects(fs.stat(env.out), /ENOENT/);
  await assertSourceUntouched(env.source, before, r);
});

test("the output never overwrites: an existing name gets a numeric suffix and keeps its bytes", async t => {
  const env = await setup(t);
  await fs.mkdir(env.out, { recursive: true });
  await fs.writeFile(path.join(env.out, "part_tuned.3mf"), "keep me");
  const r = await harness(env, { actions: [definite("tune.def", { top_shell_layers: "5" })], script: [crossing(0)] }).run();
  assert.equal(path.basename(r.delivered.path), "part_tuned-2.3mf");
  assert.equal(await fs.readFile(path.join(env.out, "part_tuned.3mf"), "utf8"), "keep me");
  const named = await harness(env, { actions: [definite("tune.def", { top_shell_layers: "5" })], script: [crossing(0)], input: { outputName: "mine" } }).run();
  assert.equal(path.basename(named.delivered.path), "mine.3mf");
  await assert.rejects(harness(env, { actions: [], script: [crossing(0)], input: { outputName: "../escape.3mf" } }).run(), /file name, not a path/);
});

test("the source is only read: if it changes during the run the verdict is not_ready and the deliverable is not opened", async t => {
  const env = await setup(t);
  const h = harness(env, {
    actions: [definite("tune.def", { top_shell_layers: "5" })],
    script: [async () => { await writeSource(env.source, baseConfig({ wall_loops: "9" })); return crossing(0); }],
    input: { openInStudio: true },
  });
  const r = await h.run();
  assert.equal(r.source.unchanged, false);
  assert.equal(r.verdict, "not_ready");
  assert.ok(r.not_ready_reasons.some(x => x.code === "source_changed"));
  assert.deepEqual(h.opened, []);
});

test("the deliverable is opened once, after the checks, unless open_in_studio is false; a failure to open is a warning", async t => {
  const env = await setup(t);
  const h = harness(env, { actions: [], script: [crossing(0)], input: { openInStudio: true } });
  const r = await h.run();
  assert.deepEqual(h.opened, [r.delivered.path]);
  assert.equal(r.delivered.opened_in_studio, true);

  const env2 = await setup(t);
  const closed = harness(env2, { actions: [], script: [crossing(0)] });
  assert.equal((await closed.run()).delivered.opened_in_studio, false);
  assert.deepEqual(closed.opened, []);

  const env3 = await setup(t);
  const broken = await harness(env3, { actions: [], script: [crossing(0)], open: async () => { throw new Error("no display"); }, input: { openInStudio: true } }).run();
  assert.equal(broken.verdict, "ready");
  assert.equal(broken.delivered.open_error, "no display");
  assert.ok(broken.warnings.some(w => /no display/.test(w)));
});

// ---------------------------------------------------------------- what the user said, what is only suggested
test("a declared fact enables its action and becomes an unchecked-declaration caveat; an undeclared one is skipped and listed", async t => {
  const ctx = definite("tune.ctx", { wall_loops: "4" }, "relato", { when: { all: [{ fact: "object.load_class", op: "eq", value: "functional" }] } });
  const env = await setup(t);
  const none = await harness(env, { actions: [ctx], script: [crossing(0)] }).run();
  assert.deepEqual(none.diff.tuning, []);
  assert.equal(none.skipped.for_undescribed_part.count, 1);

  const env2 = await setup(t);
  const declared = await harness(env2, { actions: [ctx], script: [crossing(0)], input: { partContext: { load_class: "functional" } } }).run();
  assert.deepEqual(changedKeys(declared), ["wall_loops"]);
  assert.deepEqual(declared.part.declared, { load_class: "functional" });
  assert.ok(declared.caveats.some(c => c.code === "declared_unchecked" && /object\.load_class/.test(c.text)));
  assert.equal(declared.skipped.for_undescribed_part.count, 0);

  const env3 = await setup(t);
  await assert.rejects(harness(env3, { actions: [ctx], script: [crossing(0)], input: { partContext: { load_class: "heavy" } } }).run(), /load_class must be one of/);
});

test("a ladder step the slicer did not use is PREDICTED ONLY and the verdict is never ready", async t => {
  const env = await setup(t);
  const h = harness(env, {
    actions: [ladder("tune.travel", CROSS, [["sparse_infill_pattern", "gyroid"]])],
    script: [crossing(40), crossing(0, { block: { sparse_infill_pattern: "grid" } })], // the trigger clears, but the CONFIG_BLOCK still shows the old pattern
  });
  const r = await h.run();
  const step = r.diff.tuning.find(c => c.key === "sparse_infill_pattern");
  assert.equal(step.reached_slice, false);
  assert.equal(step.verified, false);
  assert.equal(step.verification.status, "predicted_only");
  assert.match(step.verification.note, /não usou/);
  assert.notEqual(r.verdict, "ready");
  assert.ok(r.caveats.some(x => x.code === "not_reached_slice" && /sparse_infill_pattern/.test(x.text)));
  assert.deepEqual(r.verified.measured.values_reached_the_slice, []);
});

test("each change carries the print-time cost of the round that introduced it, and the summary shows it", async t => {
  const actions = [definite("tune.a", { top_shell_layers: "5" }), definite("tune.b", { seam_position: "nearest" })];
  const r = await harness(await setup(t), { actions, script: [crossing(0, { time: 3600 }), crossing(0, { time: 5400 })] }).run();
  for (const c of r.diff.tuning) assert.deepEqual(c.round_time_cost, { before_s: 3600, after_s: 5400, delta_s: 1800, shared_with: 1 });
  assert.match(r.resumo, /\+30 min de impressão \(50\.0%, junto com 1 outra\(s\) da mesma rodada\)/);
  const same = await harness(await setup(t), { actions, script: [crossing(0, { time: 3600 })] }).run();
  assert.doesNotMatch(same.resumo, /min de impressão/, "a cost under a minute is not shown");
});

test("apply strong_only writes only preset, oficial and bug conhecido values; relato stays a suggestion", async t => {
  const actions = [definite("tune.strong", { top_shell_layers: "5" }, "oficial"), definite("tune.relato", { seam_position: "nearest" }, "relato")];
  const rec = await harness(await setup(t), { actions, script: [crossing(0)] }).run();
  assert.deepEqual(changedKeys(rec), ["seam_position", "top_shell_layers"]);
  const strong = await harness(await setup(t), { actions, script: [crossing(0)], input: { apply: "strong_only" } }).run();
  assert.deepEqual(changedKeys(strong), ["top_shell_layers"]);
  assert.deepEqual(strong.suggestions_not_applied.map(s => s.key), ["seam_position"]);
});

test("a changed key is checked in the slice's CONFIG_BLOCK: reached_slice true, false, or null when there is no block", async t => {
  const block = { top_shell_layers: "5", seam_position: "aligned" }; // the slicer kept the old seam
  const actions = [definite("tune.a", { top_shell_layers: "5" }), definite("tune.b", { seam_position: "nearest" })];
  const r = await harness(await setup(t), { actions, script: [crossing(0), crossing(0, { block })] }).run();
  assert.deepEqual(Object.fromEntries(r.diff.tuning.map(c => [c.key, c.reached_slice])), { top_shell_layers: true, seam_position: false });
  assert.deepEqual(r.verified.measured.values_reached_the_slice, ["top_shell_layers"]);
  const none = await harness(await setup(t), { actions, script: [crossing(0)] }).run();
  assert.deepEqual(none.diff.tuning.map(c => c.reached_slice), [null, null]);
});

// ---------------------------------------------------------------- the report, with the shipped data
test("the report carries untouched risks, unseen facts and the honest statement; the tool is registered with the part_context guidance", async t => {
  const env = await setup(t);
  const r = await harness(env, { actions: getTuning().actions.filter(a => a.id === "tune.travel.unprotected-ladder"), noAction: getTuning().noAction, script: [crossing(0)] }).run();
  assert.ok(r.untouched_risks.items.some(x => x.rule === "bambu.hardware.loose-screws-bed-cable"), "a hardware check the engine cannot change");
  assert.ok(r.untouched_risks.items.every(x => x.severity !== "tip"));
  assert.match(r.ready_means, /nenhuma impressora/);
  assert.match(r.unseen.no_printer, /Nenhuma impressora/);
  assert.match(r.unseen.weak_rules, /^\d+% das regras/);
  assert.equal(r.kb.tuning_version === null, true, "injected actions carry no version");
  assert.ok(!/testamos todas|todas as possibilidades/i.test(JSON.stringify(r)), "never claims every possibility was tested");

  const tool = PREPARE_TOOLS[0];
  assert.equal(tool.name, "prepare_print_project");
  assert.match(tool.description, /LEAVE IT OUT/);
  assert.match(tool.description, /never prints/);
  assert.deepEqual(Object.keys(tool.inputSchema.properties.part_context.properties).sort(), ["has_fit_pins_and_holes", "has_tight_fit_male_part", "is_cut_part", "is_cut_pin", "is_large_part", "is_tall_narrow", "is_tiny_part", "kind", "load_class", "mold_kind"]);
});

test("parsePrepareArgs applies the defaults and refuses a typo or a wrong type", () => {
  assert.deepEqual(parsePrepareArgs({ path: "/x/a.3mf" }), { path: "/x/a.3mf", plateIndex: 0, model: undefined, partContext: undefined, maxSlices: 12, maxMinutes: 20, outputDir: undefined, outputName: undefined, openInStudio: true, apply: "recommended", dryRun: false });
  assert.throws(() => parsePrepareArgs({}), /Missing required parameter: path/);
  assert.throws(() => parsePrepareArgs({ path: "a.3mf", file_path: "b" }), /Unknown argument "file_path"/);
  assert.throws(() => parsePrepareArgs({ path: "a.3mf", max_slices: 1 }), /max_slices must be an integer from 2 to 50/);
  assert.throws(() => parsePrepareArgs({ path: "a.3mf", max_minutes: 0 }), /max_minutes/);
  assert.throws(() => parsePrepareArgs({ path: "a.3mf", apply: "all" }), /apply must be/);
  assert.throws(() => parsePrepareArgs({ path: "a.3mf", dry_run: "yes" }), /dry_run must be true or false/);
});

// ---------------------------------------------------------------- through the server (no Bambu Studio needed: a dry run of an X2D project slices nothing)
test("through the server: registered, named in the instructions, strict about its arguments, and a dry run works end to end", async t => {
  const env = await setup(t);
  const before = sha(await fs.readFile(env.source));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER], cwd: env.dir, stderr: "pipe",
    env: {
      PATH: process.env.PATH || "", MCP_TRANSPORT: "stdio", PRINTER_HOST: "127.0.0.1", BAMBU_MODEL: "x2d", BAMBU_SERIAL: "", BAMBU_TOKEN: "",
      TEMP_DIR: path.join(env.dir, "temp"), SLICER_STATE_FILE: path.join(env.dir, "slicers.json"), BAMBU_STUDIO_PATH: path.join(env.dir, "no-studio"),
      BAMBU_CLIENT_CERT: path.join(env.dir, "no-cert"), BAMBU_CLIENT_KEY: path.join(env.dir, "no-key"),
    },
  });
  const client = new Client({ name: "prepare-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find(x => x.name === "prepare_print_project");
    assert.ok(tool, "registered");
    assert.equal(tool.annotations.readOnlyHint, false, "it writes a new file");
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.properties.bambu_model.enum, undefined, "not part of the bambu_model enum invariant: the handler validates it");
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /prepare_print_project/);
    assert.match(instructions, /never that every possibility was tested/);
    for (const name of instructions.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g)) assert.ok(tools.some(x => x.name === name), `instructions mention ${name}, which is not a tool`);

    const typo = await client.callTool({ name: "prepare_print_project", arguments: { file_path: env.source } });
    assert.equal(typo.isError, true);
    assert.match(typo.content[0].text, /Unknown argument "file_path"/);
    const missing = await client.callTool({ name: "prepare_print_project", arguments: { path: path.join(env.dir, "nope.3mf"), dry_run: true } });
    assert.equal(missing.isError, true);

    const result = await client.callTool({ name: "prepare_print_project", arguments: { path: env.source, dry_run: true, open_in_studio: false, part_context: { load_class: "functional" } } });
    assert.notEqual(result.isError, true, result.content[0].text);
    const report = JSON.parse(result.content[0].text);
    assert.equal(report.stop.reason, "dry_run");
    assert.equal(report.verdict, "not_ready");
    assert.equal(report.delivered, null);
    assert.deepEqual(report.part.declared, { load_class: "functional" });
    assert.equal(report.source.unchanged, true);
    assert.match(report.resumo, /Projeto preparado: part\.3mf/);

    // An STL has no project settings to export, so building its project needs a real slice: a dry run must refuse, before any CLI is started.
    const stl = path.join(env.dir, "tetra.stl");
    await fs.writeFile(stl, "solid t\nfacet normal 0 0 -1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nfacet normal 0 -1 0\nouter loop\nvertex 0 0 0\nvertex 0 0 1\nvertex 1 0 0\nendloop\nendfacet\nfacet normal -1 0 0\nouter loop\nvertex 0 0 0\nvertex 0 1 0\nvertex 0 0 1\nendloop\nendfacet\nfacet normal 1 1 1\nouter loop\nvertex 1 0 0\nvertex 0 0 1\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n");
    const stlDry = await client.callTool({ name: "prepare_print_project", arguments: { path: stl, dry_run: true, open_in_studio: false } });
    assert.equal(stlDry.isError, true);
    assert.match(stlDry.content[0].text, /a dry run cannot build its plan/, "refused by the retargeter itself, not by a failed attempt to start the (absent) Studio CLI");
  } finally {
    await client.close();
  }
  assert.equal(sha(await fs.readFile(env.source)), before);
});

// ---------------------------------------------------------------- the retargeter (the only place a dry run could slice by accident)
test("studioRetargeter: allowSlice false refuses a retarget that needs a real slice, before calling the CLI; allowed, it counts the slice", async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retarget-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const calls = [];
  const manipulator = {
    planProjectSettings: async () => { throw new Error("an STL has no project to plan"); },
    sliceSTL: async (...args) => {
      calls.push(args);
      const dir = await fs.mkdtemp(path.join(tempDir, "slice-"));
      const out = path.join(dir, "out.3mf");
      await fs.writeFile(out, "exported");
      return out;
    },
  };
  const options = { slicerPath: "no-studio", tempDir, printerPreset: X2D, modelCode: "X2D", manipulator };
  await assert.rejects(studioRetargeter({ ...options, allowSlice: false })("/x/a.stl"), /a dry run cannot build its plan/);
  assert.equal(calls.length, 0, "the CLI was never called");

  const outcome = await studioRetargeter(options)("/x/a.stl");
  assert.equal(calls.length, 1);
  assert.equal(outcome.slices, 1);
  assert.equal(outcome.archive.toString(), "exported");
});
