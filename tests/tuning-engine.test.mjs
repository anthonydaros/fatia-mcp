// Parity of src/tuning/engine.ts with the reference engine kb/tuning/evaluate-tuning.mjs (ground truth), without needing the reference at run time.
//
//  1. eval.json: every scenario and sequence passes with the expectations the reference's --check-eval uses (ported below).
//  2. golden.json: outputs the reference produced for those same scenarios and sequences, plus 300 seeded random draws over the real tuning.json
//     and 120 over a synthetic action set (scripts/gen-tuning-golden.mjs). The TS engine must reproduce them exactly: every readable field per
//     round (settings, changes, suggested, skipped_unknown, exhausted, unknown, done, stalled, ...) and a digest of the complete result and state.
//  3. Hand-written cases for each semantic decision (sticky, unknown trigger, relax, bound-on-top, elements, done), so a broken rule fails with its name.
//
// The one intentional evaluator difference is the "%" handling documented in src/knowledge/condition.ts: it compares two "%" strings as numbers
// ("15.0%" == "15%"), the reference as text. No golden case depends on it (checked below, case by case, with the same test the generator applies).
// The other difference, applies_to forms, is closed by scripts/validate-knowledge.mjs (tuningVersionForm) and checked here against a copy of the
// reference's versionMatches. Regenerate the golden file only on purpose: node scripts/gen-tuning-golden.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyTuning, initialState, nextRound, simulate } from "../dist/tuning/engine.js";
import { matchVersion } from "../dist/knowledge/version.js";
import { tuningVersionForm } from "../scripts/validate-knowledge.mjs";
import { expandRounds, materialize, pctDivergence, runCase } from "../scripts/gen-tuning-golden.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n"));
const TUNING = readJson("knowledge/tuning/tuning.json");
const EVAL = readJson("tests/fixtures/tuning/eval.json");
const GOLDEN = readJson("tests/fixtures/tuning/golden.json");
const ENGINE = { applyTuning, nextRound, simulate };

// ---------------------------------------------------------------- eval.json (the reference's checkEvalData, on the TS engine)
test("every eval.json scenario and sequence passes with the reference's expectations", () => {
  const bad = [];
  const uniq = (l) => [...new Set(l)].sort();
  const cmp = (w, what, want, got) => { const x = JSON.stringify(want), y = JSON.stringify(got); if (x !== y) bad.push(`${w}: ${what}\n    expected ${x}\n    got      ${y}`); };
  for (const s of EVAL.scenarios) {
    const r = applyTuning(TUNING, s.facts ?? {}, s.base ?? s.base_settings ?? {}, { printer: s.printer, studioVersion: s.studio_version, phase: s.phase, unavailable: s.unavailable, studioKeys: GOLDEN.studio_keys });
    for (const [k, list] of [["expect_applied", r.applied], ["expect_suggested", r.suggested], ["expect_unchanged", r.unchanged_already]]) {
      if (s[k] !== undefined) cmp(`scenario ${s.name}`, k, uniq(s[k]), uniq(list.map((i) => i.action)));
    }
  }
  for (const q of EVAL.sequences) {
    const o = q.options ?? {};
    const sim = simulate(TUNING, q.base_settings ?? {}, q.rounds.map((x) => x.facts ?? {}), { printer: o.printer, studioVersion: o.studio_version, phase: o.phase, unavailable: o.unavailable, studioKeys: GOLDEN.studio_keys });
    q.rounds.forEach((rd, i) => {
      const got = sim.rounds[i], e = rd.expect ?? {}, w = `sequence ${q.id} round ${i}`;
      if (e.changes_keys !== undefined) cmp(w, "changes_keys", [...e.changes_keys].sort(), got.changes.map((c) => c.key).sort());
      if (e.exhausted_ids !== undefined) cmp(w, "exhausted_ids", uniq(e.exhausted_ids), uniq(got.exhausted.map((x) => x.action)));
      if (e.done !== undefined) cmp(w, "done", e.done, got.done);
    });
  }
  assert.deepEqual(bad, []);
  assert.equal(EVAL.scenarios.length, 68);
  assert.equal(EVAL.sequences.length, 28);
});

// ---------------------------------------------------------------- golden
function replay(suite, tuning, keys) {
  const mismatches = [];
  let rounds = 0;
  for (const c of GOLDEN.cases.filter((x) => x.suite === suite)) {
    const got = runCase(ENGINE, tuning, { ...c, rounds: expandRounds(c.rounds) }, materialize(GOLDEN.bases, c.base), keys);
    got.rounds.forEach((g, i) => {
      rounds++;
      const want = c.expect.rounds[i];
      for (const field of new Set([...Object.keys(want), ...Object.keys(g)])) {
        try { assert.deepStrictEqual(g[field], want[field]); } catch { mismatches.push(`${c.id} round ${i} ${field}\n    want ${JSON.stringify(want[field]).slice(0, 300)}\n    got  ${JSON.stringify(g[field]).slice(0, 300)}`); }
      }
    });
    if (got.simulation !== c.expect.simulation) mismatches.push(`${c.id} simulate() differs from the reference`);
  }
  return { mismatches, rounds };
}

test("the golden file belongs to the shipped tuning data and covers the engine's branches", () => {
  const text = fs.readFileSync(path.join(ROOT, "knowledge/tuning/tuning.json"), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  assert.equal(GOLDEN.meta.tuning_sha256, createHash("sha256").update(text, "utf8").digest("hex"), "tuning.json changed: run node scripts/gen-tuning-golden.mjs");
  const { counts, coverage } = GOLDEN.meta;
  assert.ok(counts.shipped_random >= 300);
  assert.equal(counts.shipped_eval_cases, EVAL.scenarios.length + EVAL.sequences.length);
  assert.equal(GOLDEN.cases.length, counts.cases);
  assert.equal(new Set(GOLDEN.cases.map((c) => c.id + c.suite)).size, GOLDEN.cases.length, "case ids are unique per suite");
  for (const k of ["applied", "suggested", "unchanged_already", "skipped_unknown", "conflicts", "combined_conflicts", "object_overrides", "advanced", "skipped_noop", "relaxed", "relax_changes", "exhausted", "unknown_trigger", "unknown_when", "blind", "reverted", "choices_verified", "done", "stalled", "elements_unresolved", "unit_mismatch", "unresolvable_ref"]) {
    assert.ok(coverage[k] > 0, `the golden cases never exercise ${k}`);
  }
});

test("the TS engine reproduces the reference on every eval scenario/sequence and the 300 random draws over the shipped tuning.json", () => {
  const { mismatches, rounds } = replay("shipped", TUNING, GOLDEN.studio_keys);
  assert.ok(rounds >= 1000, `only ${rounds} rounds replayed`);
  assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} differences from the reference`);
});

test("the TS engine reproduces the reference on the synthetic action set (relax, object ladders, several bounds, weak winners)", () => {
  const { mismatches, rounds } = replay("synthetic", GOLDEN.synthetic, GOLDEN.synthetic_studio_keys);
  assert.ok(rounds >= 200, `only ${rounds} rounds replayed`);
  assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} differences from the reference`);
});

test('no golden case can tell the "%" handling of condition.ts from the reference, and the difference is real', () => {
  for (const [suite, tuning] of [["shipped", TUNING], ["synthetic", GOLDEN.synthetic]]) {
    const dependent = GOLDEN.cases.filter((c) => c.suite === suite && pctDivergence(tuning, materialize(GOLDEN.bases, c.base), expandRounds(c.rounds)).length).map((c) => c.id);
    assert.deepEqual(dependent, [], `${suite}: cases whose result depends on the "%" difference`);
  }
  assert.equal(GOLDEN.meta.pct_dependent_cases, 0);
  // The detector is not vacuous: a "15.0%" base against the shipped `eq 15%` conditions is exactly what it flags ...
  assert.ok(pctDivergence(TUNING, { sparse_infill_density: "15.0%" }, [{}]).length > 0);
  assert.equal(pctDivergence(TUNING, { sparse_infill_density: "15%" }, [{}]).length, 0);
  // ... and condition.ts reads it as equal (the reference would say not equal: a string compare).
  const a = act({ when: { all: [L("settings.sparse_infill_density", "eq", "15%")] }, set: { wall_loops: "3" } });
  assert.equal(applyTuning([a], {}, { sparse_infill_density: "15.0%", wall_loops: "2" }).applied.length, 1);
});

test("applies_to forms: tuning.json uses only forms on which version.ts and the reference's versionMatches agree", () => {
  // Copy of versionMatches from kb/tuning/evaluate-tuning.mjs (components compared only as far as the predicate has them).
  const reference = (pred, version) => {
    const parts = (s) => String(s).trim().split(".").map((x) => (/^x$/i.test(x) ? "x" : /^\d+$/.test(x) ? Number(x) : NaN));
    const v = version === undefined || version === null ? null : parts(version);
    const known = v && v.length && v.every((x) => Number.isInteger(x));
    let ok = false;
    for (const clause of String(pred).split(",")) {
      const m = /^\s*(<=|>=|<|>|=)?\s*(\d+(?:\.(?:\d+|x))*)\s*$/i.exec(clause);
      if (!known) continue;
      const p = parts(m[2]);
      let c = 0;
      for (let i = 0; i < p.length && !c; i++) if (p[i] !== "x") c = Math.sign((v[i] ?? 0) - p[i]);
      if ({ "=": c === 0, "<": c < 0, "<=": c <= 0, ">": c > 0, ">=": c >= 0 }[m[1] ?? "="]) ok = true;
    }
    return known ? ok : null;
  };
  const mapped = { applies: true, not_applies: false, unknown: null };
  const versions = ["2.8.4.57", "02.08.04.57", "2.8.0.0", "2.8", "2.7.1.0", "2.7", "2.9.0.1", "3.0.0.0", "2.8.2.61", "2.8.1.9", undefined, "garbage"];
  const allowed = [">=2.8", ">=2.8.2.61", "<2.9", "<2.8.2", "<2.8.4.57", "2.8.4.57", "2.8", "2.7.1", "2.8.x", "2.7.1, 2.8.2.61", ">=3,<2.8", ">2.8.4.57", "<=2.8.4.57", "=2.8.4.57"];
  for (const pred of allowed) {
    assert.ok(tuningVersionForm(pred), `${pred} should be an allowed form`);
    for (const v of versions) assert.equal(mapped[matchVersion(pred, v)], reference(pred, v), `${pred} against ${v}`);
  }
  for (const pred of [">2.8", "<=2.8", "=2.8", ">2.8.4", "garbage"]) assert.equal(tuningVersionForm(pred), false, `${pred} must be rejected`);
  // ">2.8" really is where they split: the reference counts 2.8.4.57 as inside the 2.8 series, version.ts as above 2.8.0.0.
  assert.notEqual(mapped[matchVersion(">2.8", "2.8.4.57")], reference(">2.8", "2.8.4.57"));
  const forms = new Set(TUNING.map((a) => a.applies_to?.bambu_studio).filter(Boolean));
  assert.ok(forms.size >= 2);
  for (const f of forms) assert.ok(tuningVersionForm(f), `${f} (tuning.json) is not an agreed form`);
});

// ---------------------------------------------------------------- the semantic decisions, one by one
const L = (fact, op, value) => ({ fact, op, value });
let seq = 0;
const act = (o) => ({ id: `tune.t.a${++seq}`, rules: ["r"], topic: "t", phase: "pre-slice", scope: "process", when: { all: [] }, when_text: "x", mode: "set", set: {}, confidence: "preset", risk: "low", priority: 50, printers: [], applies_to: null, rationale: "x", src: ["guide:1-2"], ...o });
const stp = (set, o = {}) => ({ set, why: "w", cost: "tempo", expect: "x", confidence: "preset", src: ["guide:1-2"], ...o });
const lad = (o) => act({ kind: "ladder", relax: false, trigger: { all: [L("gcode.n", "gt", "0")] }, trigger_text: "x", steps: [], exhausted: "exhausted text", ...o });
const deepFreeze = (x) => { if (x && typeof x === "object") { Object.values(x).forEach(deepFreeze); Object.freeze(x); } return x; };
/** Rounds 0..n over scripted facts; returns every round result. */
function rounds(tuning, base, factsPerRound, options = {}) {
  const out = [];
  factsPerRound.forEach((facts, i) => out.push(i === 0 ? applyTuning(tuning, facts, base, options) : nextRound(tuning, out[i - 1].state, facts, options)));
  return out;
}

test("a definite action is sticky: a measured condition that clears after the fix does not undo it", () => {
  const a = act({ phase: "post-slice", when: { all: [L("gcode.crossings", "gt", "0")] }, set: { z_hop: "0.4" } });
  const [r0, r1, r2] = rounds([a], { z_hop: "0" }, [{}, { "gcode.crossings": 2 }, { "gcode.crossings": 0 }]);
  assert.equal(r0.applied.length, 0, "a post-slice action waits for a slice in round 0");
  assert.deepEqual(r1.changes.map((c) => [c.key, c.from, c.to]), [["z_hop", "0", "0.4"]]);
  assert.equal(r2.settings_after.z_hop, "0.4");
  assert.equal(r2.changes.length, 0);
  assert.equal(r2.done, true);
});

test("a suggest-only action is not sticky: it is re-evaluated every round", () => {
  const a = act({ phase: "post-slice", confidence: "hipotese", when: { all: [L("gcode.crossings", "gt", "0")] }, set: { z_hop: "0.4" } });
  const [, r1, r2] = rounds([a], { z_hop: "0" }, [{}, { "gcode.crossings": 2 }, { "gcode.crossings": 0 }]);
  assert.deepEqual(r1.suggested.map((i) => i.key), ["z_hop"]);
  assert.equal(r1.settings_after.z_hop, "0");
  assert.equal(r2.suggested.length, 0);
});

test("a ladder never moves on an unknown trigger and stays where it is", () => {
  const l = lad({ steps: [stp({ brim_width: "5" }), stp({ brim_width: "8" })] });
  const [r0, r1, r2] = rounds([l], { brim_width: "0" }, [{}, { "gcode.n": 1 }, {}]);
  assert.deepEqual(r0.unknown.map((u) => [u.where, u.missing]), [["trigger", ["gcode.n"]]]);
  assert.equal(r0.ladders[0].level, 0);
  assert.equal(r0.settings_after.brim_width, "0");
  assert.equal(r1.ladders[0].level, 1);
  assert.deepEqual(r1.changes.map((c) => [c.key, c.from, c.to, c.level, c.step]), [["brim_width", "0", "5", 1, 1]]);
  assert.equal(r2.ladders[0].level, 1, "unknown trigger: level kept");
  assert.equal(r2.settings_after.brim_width, "5", "no un-doing");
  assert.equal(r2.done, false, "an unknown trigger for a fact that should be available blocks done");
  assert.equal(r2.stalled, true);
  assert.deepEqual(r2.missing_facts, ["gcode.n"]);
});

test("a ladder runs its steps cumulatively, one per round, and reports exhaustion at the end", () => {
  const l = lad({ steps: [stp({ brim_type: "outer_only" }), stp({ brim_width: "5", brim_object_gap: "0.1" })] });
  const [r0, r1, r2, r3] = rounds([l], { brim_type: "no_brim", brim_width: "0", brim_object_gap: "0" }, [{ "gcode.n": 1 }, { "gcode.n": 1 }, { "gcode.n": 1 }, { "gcode.n": 1 }]);
  assert.deepEqual(r0.applied.map((c) => c.key), ["brim_type"]);
  assert.deepEqual(r1.changes.map((c) => c.key).sort(), ["brim_object_gap", "brim_width"]);
  assert.equal(r1.settings_after.brim_type, "outer_only", "step 2 keeps step 1");
  assert.equal(r2.exhausted.length, 1);
  assert.equal(r2.exhausted[0].text, "exhausted text");
  assert.equal(r3.done, false, "an exhausted ladder keeps done false: the trigger is still true");
});

test("relax: a trigger that is false for two rounds in a row steps one level back; any other round restarts the count", () => {
  const l = lad({ relax: true, trigger: { all: [L("gcode.warp", "gt", "0.5")] }, steps: [stp({ brim_width: "5" }), stp({ brim_width: "8" }), stp({ brim_width: "10" })] });
  const f = (...w) => w.map((x) => (x === null ? {} : { "gcode.warp": x }));
  let r = rounds([l], { brim_width: "0" }, f(1, 1, 0, 0, 0));
  assert.deepEqual(r.map((x) => x.ladders[0].level), [1, 2, 2, 1, 1]);
  assert.equal(r[2].relaxed.length, 0);
  assert.deepEqual(r[3].relaxed, [{ action: l.id, from: 2, to: 1 }]);
  assert.deepEqual(r[3].changes.map((c) => [c.action, c.key, c.from, c.to, c.relax, c.level]), [[l.id, "brim_width", "8", "5", true, 1]]);
  assert.equal(r[4].relaxed.length, 0, "the count restarted after the relax");
  r = rounds([l], { brim_width: "0" }, f(1, 0, 1, 0, 0));
  assert.deepEqual(r.map((x) => x.ladders[0].level), [1, 1, 2, 2, 1], "true in between resets the count; a quiet pair then relaxes");
  r = rounds([l], { brim_width: "0" }, f(1, 0, null, 0, 0));
  assert.deepEqual(r.map((x) => x.ladders[0].level), [1, 1, 1, 1, 0], "unknown resets the count too: one more quiet round is not enough, two are");
  const fixed = act({ ...lad({ steps: l.steps, trigger: l.trigger }), id: "tune.t.norelax" });
  assert.deepEqual(rounds([fixed], { brim_width: "0" }, f(1, 0, 0, 0)).map((x) => x.ladders[0].level), [1, 1, 1, 1], "relax false: the level never goes back");
});

test("bound-on-top: a winning cap does not erase a lower-priority chosen value; it only trims what is above it", () => {
  const set = act({ id: "tune.t.set", priority: 40, set: { outer_wall_speed: "60" } });
  const cap = act({ id: "tune.t.cap", priority: 70, mode: "at_most", set: { outer_wall_speed: "200" } });
  let r = applyTuning([set, cap], {}, { outer_wall_speed: "300" });
  assert.equal(r.settings_after.outer_wall_speed, "60");
  assert.deepEqual(r.applied.map((c) => [c.action, c.to]), [["tune.t.set", "60"]], "the owner is the setter: the cap changed nothing");
  assert.deepEqual(r.conflicts.map((c) => [c.winner, c.loser, c.combined]), [["tune.t.cap", "tune.t.set", true]]);
  r = applyTuning([act({ id: "tune.t.set", priority: 40, set: { outer_wall_speed: "250" } }), cap], {}, { outer_wall_speed: "300" });
  assert.equal(r.settings_after.outer_wall_speed, "200");
  assert.equal(r.applied[0].action, "tune.t.cap", "the cap trimmed 250: the cap owns the result");
  const floor = act({ id: "tune.t.floor", priority: 30, mode: "at_least", set: { outer_wall_speed: "100" } });
  r = applyTuning([set, cap, floor], {}, { outer_wall_speed: "300" });
  assert.equal(r.settings_after.outer_wall_speed, "60", "a bound of the other direction is not folded over the winner's direction");
  const weakCap = act({ id: "tune.t.weak", priority: 70, mode: "at_most", confidence: "hipotese", set: { outer_wall_speed: "200" } });
  r = applyTuning([set, weakCap], {}, { outer_wall_speed: "300" });
  assert.equal(r.settings_after.outer_wall_speed, "300", "a weak (suggested) winner shadows the stronger setter: plain winner-takes-all");
  assert.deepEqual(r.suggested.map((i) => i.action), ["tune.t.weak"]);
});

test("elements: a cap on list-valued keys writes only the labelled elements and needs the aligned list", () => {
  const cap = act({ mode: "at_most", elements: { index_by: "print_extruder_variant", starts_with: "Bowden" }, set: { outer_wall_speed: "200" } });
  const base = { print_extruder_variant: ["Direct Drive Standard", "Bowden Standard", "Bowden High Flow"], outer_wall_speed: ["300", "300", "150"] };
  let r = applyTuning([cap], {}, base);
  assert.deepEqual(r.settings_after.outer_wall_speed, ["300", "200", "150"]);
  assert.deepEqual(base.outer_wall_speed, ["300", "300", "150"], "the input is not changed");
  r = applyTuning([cap], {}, { outer_wall_speed: ["300", "300"] });
  assert.deepEqual(r.skipped_unknown.map((s) => [s.reason, s.missing]), [["unresolvable-elements", ["settings.print_extruder_variant"]]]);
  assert.deepEqual(r.settings_after.outer_wall_speed, ["300", "300"]);
  r = applyTuning([cap], {}, { print_extruder_variant: ["Bowden Standard"], outer_wall_speed: ["300", "300"] });
  assert.equal(r.skipped_unknown[0].reason, "unresolvable-elements", "an index list of another length is no index");
});

test("done needs no true trigger, nothing unknown that should be known, and nothing changed in the round", () => {
  const a = act({ phase: "post-slice", when: { all: [L("gcode.crossings", "gt", "0")] }, set: { z_hop: "0.4" } });
  const [r0, r1, r2] = rounds([a], { z_hop: "0" }, [{}, { "gcode.crossings": 2 }, { "gcode.crossings": 2 }]);
  assert.equal(r0.done, false, "round 0 is never done: nothing was sliced yet");
  assert.equal(r1.done, false, "the round changed a setting, so the facts were measured on settings that are not final");
  assert.equal(r1.stalled, false);
  assert.equal(r2.done, true, "the next slice measured the final settings");
  const l = lad({ steps: [stp({ brim_width: "5" })] });
  const [, q1, q2] = rounds([l], { brim_width: "0" }, [{}, { "gcode.n": 0 }, { "gcode.n": 0 }]);
  assert.equal(q1.done, true);
  assert.equal(q2.done, true);
});

test("facts that can never be collected are blind, not missing, and do not block done", () => {
  const l = lad({ steps: [stp({ brim_width: "5" })] });
  const [r0, r1] = rounds([l], { brim_width: "0" }, [{}, {}], { unavailable: ["gcode."] });
  assert.deepEqual(r0.unknown.map((u) => [u.missing, u.blind]), [[[], ["gcode.n"]]]);
  assert.deepEqual([r0.missing_facts, r0.blind_facts], [[], ["gcode.n"]]);
  assert.equal(r1.done, true);
  assert.equal(rounds([l], { brim_width: "0" }, [{}, {}])[1].done, false);
});

test("selection is three-valued: printer and Studio version unknown means skipped_unknown, a known mismatch is silent", () => {
  const a = act({ printers: ["x2d"], applies_to: { bambu_studio: ">=2.8" }, set: { z_hop: "0.4" } });
  let r = applyTuning([a], {}, { z_hop: "0" });
  assert.deepEqual(r.skipped_unknown.map((s) => s.missing), [["printer.model", "studio.version"]]);
  r = applyTuning([a], {}, { z_hop: "0" }, { printer: "Bambu Lab X2D", studioVersion: "02.08.04.57" });
  assert.equal(r.applied.length, 1);
  r = applyTuning([a], { "printer.model": "a1", "studio.version": "2.8.4.57" }, { z_hop: "0" });
  assert.deepEqual([r.applied.length, r.skipped_unknown.length], [0, 0]);
  r = applyTuning([a], {}, { z_hop: "0" }, { printer: "x2d", studioVersion: "2.7.1.0" });
  assert.deepEqual([r.applied.length, r.skipped_unknown.length], [0, 0]);
  assert.throws(() => applyTuning([act({ id: "tune.t.badver", applies_to: { bambu_studio: "garbage" } })], {}, {}), /tune\.t\.badver/);
});

test("a ladder step that is already in effect is skipped, not given a slice round", () => {
  const l = lad({ steps: [stp({ wall_loops: "3" }), stp({ wall_loops: "4" })] });
  const [r0] = rounds([l], { wall_loops: "3" }, [{ "gcode.n": 1 }]);
  assert.deepEqual(r0.advanced.map((a) => [a.from, a.to, a.skipped_noop]), [[0, 2, 1]]);
  assert.equal(r0.settings_after.wall_loops, "4");
});

test("the engine is pure: frozen inputs are accepted, nothing is mutated, a state can be reused", () => {
  const a = act({ phase: "post-slice", when: { all: [L("gcode.crossings", "gt", "0")] }, set: { z_hop: "0.4" } });
  const l = lad({ steps: [stp({ brim_width: "5" })] });
  const tuning = deepFreeze([a, l]);
  const base = deepFreeze({ z_hop: "0", brim_width: "0" });
  const r0 = applyTuning(tuning, deepFreeze({ "gcode.n": 1 }), base);
  const snapshot = JSON.stringify(r0.state);
  const facts = deepFreeze({ "gcode.crossings": 2, "gcode.n": 1 });
  const first = nextRound(tuning, r0.state, facts);
  const second = nextRound(tuning, r0.state, facts);
  assert.equal(JSON.stringify(r0.state), snapshot);
  assert.deepEqual(first, second);
  assert.equal(first.state.round, 1);
  assert.equal(r0.state.round, 0);
  assert.deepEqual(nextRound(tuning, initialState(base), facts).round, 1);
  assert.throws(() => nextRound(tuning, null, facts), TypeError);
  assert.throws(() => applyTuning([lad({ id: "tune.t.notrigger", trigger: undefined, steps: [stp({ a: "1" })] })], {}, {}), /tune\.t\.notrigger/);
  assert.throws(() => applyTuning([act({ id: "tune.t.kind", kind: "wizard" })], {}, {}), /tune\.t\.kind/);
});
