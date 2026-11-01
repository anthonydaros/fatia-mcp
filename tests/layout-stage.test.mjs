// src/tuning/layout-stage.ts with a fake slicer: the candidates are really written (and proven), the fake answers per-plate predictions, and the stage's
// decisions are checked: the table, the choice, the budget, modes, locked plates, blockers, clean projects, hostile input.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openProject } from "../dist/knowledge/facts/settings.js";
import { analyzeLayout, geometryFromConfig, readLayoutModel } from "../dist/tuning/layout.js";
import { colourName, runLayoutStage } from "../dist/tuning/layout-stage.js";
import { buildLayoutProject, scatteredSpec, x2dConfig } from "./fixtures/layout-project.mjs";

const scattered = scatteredSpec;
async function setup(t, spec = scattered()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "layout-stage-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const p0 = path.join(dir, "p0.3mf");
  await fs.writeFile(p0, await buildLayoutProject(spec));
  const work = path.join(dir, "work");
  await fs.mkdir(work);
  return { dir, p0, work };
}
/** The fake slicer: records the files it is given and answers per-plate predictions from `time(id, plates, index)`. */
function fakeSlicer(time, { fail = [], ticks = 0, clock } = {}) {
  const calls = [];
  const sliceAll = async file => {
    const base = path.basename(file);
    const id = base === "p0.3mf" ? "as_is" : /^layout-(.+)\.3mf$/.exec(base)[1];
    const existed = await fs.access(file).then(() => true, () => false);
    const model = await readLayoutModel(await openProject(file));
    calls.push({ id, file, existed, plates: model.plates.length });
    if (clock) clock.now += ticks;
    if (fail.includes(id)) throw new Error("the slicer said no");
    return model.plates.map((p, i) => ({ plate: i + 1, time_s: time(id, model.plates.length, i, p), weight_g: 100 + i, crossing: i, filament_maps: [1, 1], warnings: [] }));
  };
  return { calls, sliceAll };
}
const stage = (env, extra = {}) => runLayoutStage({ p0: env.p0, mode: "auto", dryRun: false, work: env.work, ...extra });
const ids = run => run.candidates.map(c => c.id);

test("a scattered project: the issues are found with evidence, four candidates are written, proven and measured, the table has the numbers, and the loser files are removed", async t => {
  const env = await setup(t);
  const slicer = fakeSlicer((id, plates) => 1000 * plates + (id === "plus1" ? -1500 : 0)); // every plate 1000 s plus 1000 s per plate count; plus1 is cheaper
  const run = await stage(env, { sliceAll: slicer.sliceAll });
  assert.equal(run.status, "applied");
  assert.ok(run.issues.length >= 5 && run.issues.every(i => ["outside_plate", "straddling", "between_plates", "bed_changed"].includes(i.kind) || i.kind === "overlap"), run.issues.map(i => i.kind).join());
  assert.deepEqual(ids(run), ["fewest", "plus1", "plus2", "authored_rebased"]);
  assert.deepEqual(slicer.calls.map(c => c.id), ["fewest", "plus1", "plus2", "authored_rebased"], "the reference last");
  assert.ok(slicer.calls.every(c => c.existed), "each candidate file existed when it was sliced");
  assert.deepEqual(slicer.calls.map(c => c.plates), run.candidates.map(c => c.plates));
  assert.equal(run.candidates[3].plates, 9);
  assert.deepEqual(run.candidates.map(c => c.measured), [true, true, true, true]);
  assert.deepEqual(run.candidates.map(c => c.total_time_s), run.candidates.map(c => 1000 * c.plates * c.plates + (c.id === "plus1" ? -1500 * c.plates : 0)));
  assert.deepEqual(run.candidates.map(c => c.crossing_per_plate.length), run.candidates.map(c => c.plates));
  assert.deepEqual(run.candidates.map(c => c.objects_per_plate.reduce((a, b) => a + b, 0)), [9, 9, 9, 9], "no object lost in any candidate");
  assert.equal(run.chosen.id, "fewest", "3 plates: 9,000 s against plus1's 4 x 2,500 = 10,000 s");
  assert.match(run.chosen.reason, /lowest total predicted time/);
  assert.deepEqual(run.candidates.filter(c => c.chosen).map(c => c.id), ["fewest"]);
  assert.equal(run.budget.slices_used, 4);
  assert.equal(run.budget.stopped_early, null);
  assert.equal(run.unmeasured, false);
  assert.equal(run.plates_before_count, 9);
  assert.equal(run.plates_after, 3);
  assert.deepEqual(run.unfixed, []);

  // the chosen file is the one kept; the other candidate files are gone
  assert.ok(run.file.endsWith("layout-fewest.3mf"));
  assert.deepEqual((await fs.readdir(env.work)).sort(), ["layout-fewest.3mf"]);
  assert.equal(run.proof.ok, true);
  const model = await readLayoutModel(await openProject(run.file));
  assert.equal(analyzeLayout(model, geometryFromConfig(x2dConfig()), { minGapMm: 2 }).clean, true);
  // colours never mixed: every plate holds one class; the frame is alone
  assert.deepEqual(run.chosen.plates.map(p => [p.class, p.objects.length]), [["1", 1], ["2", 4], ["2", 4]]);
  assert.deepEqual(run.chosen.plates.map(p => p.colour), ["black", "grey", "grey"]);
  assert.deepEqual(run.chosen.plates.map(p => p.name), ["Frame - black", "Filament 2 - grey (1/2)", "Filament 2 - grey (2/2)"]);
  assert.ok(run.chosen.plates.every(p => p.objects.every(o => o.rotation_deg === 0 || o.rotation_deg === 90)));
  // the plate to measure: the longest predicted (the fake gives every plate the same time, so the first)
  assert.deepEqual([run.measured_plate.index, run.measured_plate.number], [0, 1]);
  assert.ok(run.not_verified.some(l => /failure ruins a whole plate/.test(l)));
  assert.match(run.not_verified.join(" "), /adhesion/);
  assert.equal(run.policy.gap_mm, 8);
  assert.equal(run.policy.margin_mm, 5);
});

test("the measurement decides the number of plates: a layout with more plates wins when the slicer says so, and the 3% band falls to the smaller longest plate", async t => {
  const env = await setup(t);
  const cheaper = fakeSlicer((id, plates) => (id === "plus2" ? 1500 : 2000)); // 5 plates x 1,500 = 7,500 against 3 x 2,000 = 6,000 ... fewest still wins
  const a = await stage(env, { sliceAll: cheaper.sliceAll });
  assert.equal(a.chosen.id, "fewest");
  const env2 = await setup(t);
  const plus2 = fakeSlicer((id, plates, i) => (id === "plus2" ? 1000 : id === "fewest" ? (i === 1 ? 4000 : 2000) : 5000)); // plus2: 5 x 1000 = 5000; fewest: 2000 + 4000 + 2000 = 8000
  const b = await stage(env2, { sliceAll: plus2.sliceAll });
  assert.equal(b.chosen.id, "plus2");
  assert.equal(b.plates_after, 5);
  assert.deepEqual(b.chosen.plates.map(p => p.class), ["1", "2", "2", "2", "2"]);
  assert.equal(b.candidates.find(c => c.id === "plus2").longest_plate_s, 1000);
  // a tie inside 3%: fewest = 3 x 1,030 = 3,090 s with a 1,030 s longest plate; plus2 = 5 x 600 = 3,000 s with a 600 s one: plus2 is the lowest and wins anyway;
  // swap them so the lowest total has the longer plate: fewest 3,000 (1,000 each), plus2 3,060 (612 each) -> within 3%, the smaller longest plate decides.
  const env3 = await setup(t);
  const band = fakeSlicer((id, plates) => (id === "fewest" ? 1000 : id === "plus2" ? 612 : 9999));
  const c = await stage(env3, { sliceAll: band.sliceAll });
  assert.equal(c.chosen.id, "plus2");
  assert.match(c.chosen.reason, /within 3% of the lowest total \(3000 s, fewest\).*smaller longest plate/);
});

test("the measured sample's shape: every candidate within 1% of the others, the one-object-per-plate reference has the shortest longest plate, and it still does not win", async t => {
  const env = await setup(t);
  const totals = { fewest: 9000, plus1: 9100, plus2: 9150, authored_rebased: 9080 };
  const slicer = fakeSlicer((id, plates) => totals[id] / plates);
  const run = await stage(env, { sliceAll: slicer.sliceAll });
  assert.deepEqual(run.candidates.map(c => c.measured), [true, true, true, true]);
  assert.equal(run.chosen.id, "plus2", "the smallest longest plate among the proposals");
  assert.equal(run.plates_after, 5);
  const ref = run.candidates.find(c => c.id === "authored_rebased");
  assert.ok(Math.abs(ref.longest_plate_s - 9080 / 9) < 1e-6 && ref.longest_plate_s < Math.min(...run.candidates.filter(c => c !== ref).map(c => c.longest_plate_s)), "the reference does have the shortest longest plate");
  assert.match(run.chosen.reason, /authored_rebased .* would win every tie by construction/);
  assert.deepEqual(run.chosen.ranking.map(r => [r.id, r.eligible]), [["fewest", true], ["plus1", true], ["plus2", true], ["authored_rebased", false]]);
  const clear = await setup(t);
  const faster = fakeSlicer((id, plates) => (id === "authored_rebased" ? 5000 / plates : totals[id] / plates));
  const win = await stage(clear, { sliceAll: faster.sliceAll });
  assert.equal(win.chosen.id, "authored_rebased", "more than 3% faster in total: the plain rule applies");
  assert.equal(win.plates_after, 9);
});

test("the layout has its own slicing budget: the slices and minutes it used are reported, and when it stops early the best measured candidate is applied and the report says so", async t => {
  const env = await setup(t);
  const bySlices = fakeSlicer((id, plates) => 1000 * plates);
  const a = await stage(env, { sliceAll: bySlices.sliceAll, maxSlices: 2 });
  assert.deepEqual(bySlices.calls.map(c => c.id), ["fewest", "plus1"]);
  assert.deepEqual(a.budget, { slices_used: 2, max_slices: 2, minutes_used: a.budget.minutes_used, max_minutes: 12, stopped_early: "layout slice budget of 2 reached" });
  assert.deepEqual(a.candidates.map(c => c.measured), [true, true, false, false]);
  assert.match(a.candidates[2].not_measured_reason, /layout slice budget \(2\) is used up/);
  assert.equal(a.status, "applied");
  assert.equal(a.chosen.id, "fewest");
  assert.match(a.chosen.reason, /Candidate evaluation stopped early.*best measured one was applied/);

  // minutes: the clock moves 5 minutes per slice with a 12 minute budget: the third would end at 15 > 12
  const env2 = await setup(t);
  const clock = { now: 1_000_000 };
  const timed = fakeSlicer((id, plates) => 1000 * plates, { ticks: 5 * 60_000, clock });
  const b = await stage(env2, { sliceAll: timed.sliceAll, now: () => clock.now });
  assert.deepEqual(timed.calls.map(c => c.id), ["fewest", "plus1"], "after two slices (10 min) plus the last one's 5 would pass 12");
  assert.equal(b.budget.stopped_early, "layout time budget of 12 min reached");
  assert.equal(b.budget.max_minutes, 12);
  assert.match(b.candidates[3].not_measured_reason, /time budget \(12 min\)/);
});

test("a failed candidate slice is reported for that candidate only; with nothing measurable the planner's default is applied and the report says it was not measured", async t => {
  const env = await setup(t);
  const one = fakeSlicer((id, plates) => 1000 * plates, { fail: ["fewest"] });
  const a = await stage(env, { sliceAll: one.sliceAll });
  assert.match(a.candidates[0].not_measured_reason, /its slice failed: the slicer said no/);
  assert.equal(a.candidates[0].measured, false);
  assert.equal(a.chosen.id, "plus1", "the best of the measured");
  const env2 = await setup(t);
  const none = fakeSlicer(() => 1, { fail: ["fewest", "plus1", "plus2", "authored_rebased"] });
  const b = await stage(env2, { sliceAll: none.sliceAll });
  assert.equal(b.status, "applied");
  assert.equal(b.unmeasured, true);
  assert.equal(b.chosen.id, "fewest");
  assert.match(b.chosen.reason, /no candidate could be measured/);
  assert.equal(b.measured_plate, undefined, "no longest plate is known");
  const env3 = await setup(t);
  const noSlicer = await stage(env3, {});
  assert.equal(noSlicer.unmeasured, true);
  assert.match(noSlicer.candidates[0].not_measured_reason, /no slicer was available/);
  assert.equal(noSlicer.status, "applied");
});

test("check_only and dry_run analyse and plan but never slice or write; off does nothing", async t => {
  for (const [name, extra, status] of [["check_only", { mode: "check_only" }, "check_only"], ["dry_run", { dryRun: true }, "dry_run"]]) {
    const env = await setup(t);
    const slicer = fakeSlicer(() => 1);
    const run = await stage(env, { ...extra, sliceAll: slicer.sliceAll });
    assert.equal(run.status, status, name);
    assert.deepEqual(slicer.calls, [], `${name} never slices`);
    assert.deepEqual(await fs.readdir(env.work), [], `${name} writes nothing`);
    assert.equal(run.file, undefined);
    assert.ok(run.issues.length > 0);
    assert.ok(run.unfixed.length > 0, "the issues are still there");
    assert.ok(run.candidates.length >= 3 && run.candidates.every(c => c.measured === false && c.not_measured_reason));
    assert.equal(run.unmeasured, true);
    assert.equal(run.chosen.id, "fewest");
    assert.match(run.chosen.reason, /not a measured choice/);
  }
  const env = await setup(t);
  const off = await stage(env, { mode: "off", sliceAll: fakeSlicer(() => 1).sliceAll });
  assert.equal(off.status, "off");
  assert.deepEqual(off.issues, []);
});

test("a locked plate: reported, its objects never move, nothing is written or sliced, and the errors stay unfixed", async t => {
  const spec = scattered();
  spec.locked = [3];
  const env = await setup(t, spec);
  const slicer = fakeSlicer(() => 1);
  const before = await fs.readFile(env.p0);
  const run = await stage(env, { sliceAll: slicer.sliceAll });
  assert.equal(run.status, "locked");
  assert.deepEqual(slicer.calls, []);
  assert.equal(run.file, undefined);
  assert.ok(run.issues.some(i => i.kind === "locked_plate" && i.plate === 3));
  assert.ok(run.unfixed.length > 0 && run.unfixed.every(i => i.severity === "error"));
  assert.deepEqual(await fs.readFile(env.p0), before, "P0 is untouched");
  assert.deepEqual(await fs.readdir(env.work), []);
});

test("an object that fits no plate is a blocker: reported, nothing moves, no layout is applied", async t => {
  const spec = scattered();
  spec.objects.push({ id: 40, name: "Plank", size: [300, 20, 20], at: [100, 100], extruder: 2 });
  spec.plates.push(["40:0"]);
  const env = await setup(t, spec);
  const slicer = fakeSlicer(() => 1);
  const run = await stage(env, { sliceAll: slicer.sliceAll });
  assert.equal(run.status, "blocked");
  assert.deepEqual(run.blockers.map(b => b.objects), [["Plank"]]);
  assert.deepEqual(run.unfixed.filter(i => i.kind === "blocker").map(i => i.objects), [["Plank"]]);
  assert.deepEqual(slicer.calls, []);
  assert.equal(run.file, undefined);
});

test("a project with no problem: one plate stays as it is without a slice; several plates stay unless another layout is more than 3% faster", async t => {
  const one = await setup(t, { objects: [{ id: 2, name: "Solo", size: [50, 50, 20], at: [100, 100] }], plates: [["2:0"]] });
  const s1 = fakeSlicer(() => 1);
  const a = await stage(one, { sliceAll: s1.sliceAll });
  assert.equal(a.status, "unchanged");
  assert.deepEqual(s1.calls, [], "nothing to improve, nothing sliced");
  assert.match(a.reason, /no layout problem found/);

  // two clean plates of the same colour that could share one: the incumbent keeps a tie, loses to a clearly faster layout
  const spec = { objects: [{ id: 2, name: "A", size: [50, 50, 20], at: [100, 100] }, { id: 4, name: "B", size: [50, 50, 20], at: [307.2 + 100, 100] }], plates: [["2:0"], ["4:0"]] };
  const tie = await setup(t, spec);
  const s2 = fakeSlicer((id, plates) => (id === "as_is" ? 1000 : 1000 * 2 / plates * 1.02));
  const b = await stage(tie, { sliceAll: s2.sliceAll });
  assert.deepEqual(s2.calls.map(c => c.id), ["fewest", "plus1", "as_is"]);
  assert.equal(b.status, "unchanged", "within 3%: it stays as the user left it");
  assert.equal(b.file, undefined);
  assert.deepEqual(await fs.readdir(tie.work), [], "the candidate files are removed when the project stays as it is");
  const win = await setup(t, spec);
  const s3 = fakeSlicer((id, plates) => (id === "as_is" ? 1000 : 600));
  const c = await stage(win, { sliceAll: s3.sliceAll });
  assert.equal(c.status, "applied");
  assert.equal(c.plates_after, 1);
  assert.equal(c.chosen.id, "fewest");
});

test("over 20 plates the authored reference is not built: a clean project is left alone, a project with problems is planned without it", async t => {
  const make = (broken) => {
    const objects = Array.from({ length: 21 }, (_, i) => ({ id: 2 + 2 * i, name: `O${i}`, size: [40, 40, 20], at: [broken ? 9999 : 128 + 307.2 * (i % 5), (broken ? 9999 : 128) - 307.2 * Math.floor(i / 5)], extruder: 1 }));
    return { objects, plates: objects.map(o => [`${o.id}:0`]) };
  };
  const clean = await setup(t, make(false));
  const s1 = fakeSlicer(() => 1);
  const a = await stage(clean, { sliceAll: s1.sliceAll });
  assert.equal(a.status, "unchanged");
  assert.match(a.reason, /21 plates \(over 20\)/);
  assert.deepEqual(s1.calls, []);
  const dirty = await setup(t, make(true));
  const s2 = fakeSlicer((id, plates) => 100 * plates);
  const b = await stage(dirty, { sliceAll: s2.sliceAll });
  assert.equal(b.status, "applied");
  assert.ok(!b.candidates.some(c => c.id === "authored_rebased"));
  assert.ok(b.not_verified.some(l => /was not built: the project has 21 plates/.test(l)));
});

test("hostile input: a project over 500 objects is refused by the stage as a failure with a reason, not a crash; a project with no geometry or no printable_area is skipped", async t => {
  const many = Array.from({ length: 501 }, (_, i) => ({ id: 2 + 2 * i, name: `O${i}`, size: [1, 1, 1], at: [5, 5] }));
  const big = await setup(t, { objects: many, plates: [many.map(o => `${o.id}:0`)] });
  const a = await stage(big, { sliceAll: fakeSlicer(() => 1).sliceAll });
  assert.equal(a.status, "failed");
  assert.match(a.reason, /at most 500/);
  const noArea = await setup(t, { objects: [{ id: 2, name: "A", size: [5, 5, 5], at: [5, 5] }], plates: [["2:0"]], config: { printer_settings_id: "x" } });
  const b = await stage(noArea, {});
  assert.equal(b.status, "skipped");
  assert.match(b.reason, /printable_area/);
});

test("colour names for the plate titles come from the filament colour", () => {
  assert.deepEqual(["#000000", "#9B9EA0", "#FFFFFF", "#D32F2F", "#1E50DC", undefined].map(colourName), ["black", "grey", "white", "red", "blue", "unknown colour"]);
});
