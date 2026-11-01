#!/usr/bin/env node
// Dev-only: writes tests/fixtures/tuning/golden.json, the reference engine's outputs that tests/tuning-engine.test.mjs makes the TypeScript engine reproduce.
//   node scripts/gen-tuning-golden.mjs [referenceDir]     default: ../kb/tuning (or KB_TUNING_DIR); needs evaluate-tuning.mjs, ../evaluate-rules.mjs, studio-keys.json
// Two suites. "shipped" runs over knowledge/tuning/tuning.json: every eval.json scenario and sequence plus 300 seeded random draws (facts, base
// settings, printer, Studio version, phase, blind facts, apply set; 1 to 5 rounds each). "synthetic" runs over a small hand-made action set that covers what
// the shipped data does not use (a relax ladder, an object-scope ladder, several bounds on one key, weak winners, list keys shaped by studio-keys).
// Reruns are byte-identical (seeded PRNG, no clock). The golden file holds hashes and names only, never an absolute path.
// The test imports summarize/digest/pctDivergence from here; importing this file runs nothing.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GOLDEN = path.join(ROOT, "tests/fixtures/tuning/golden.json");
const SEED = 20261031;
const SHIPPED_DRAWS = 300;
const SYNTHETIC_DRAWS = 120;

// ---------------------------------------------------------------- shared with the test
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const json = (x) => JSON.parse(JSON.stringify(x));
/** JSON with sorted keys, so two equal values have one spelling. */
export const stable = (x) => (Array.isArray(x) ? `[${x.map(stable).join(",")}]` : x && typeof x === "object" ? `{${Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(x[k])}`).join(",")}}` : JSON.stringify(x));
export const digest = (x) => sha(stable(x)).slice(0, 20);

/** The engine's result in the form the golden stores: the fields people read, plus a digest of EVERYTHING (rationale, src, conflicts' values, state...). */
export function summarize(result, base) {
  const { state, ...r } = json(result);
  const changes = r.applied ?? r.changes;
  const settingsDelta = {};
  for (const k of Object.keys(r.settings_after)) if (stable(r.settings_after[k]) !== stable(base[k])) settingsDelta[k] = r.settings_after[k];
  const item = (c) => ({ action: c.action, key: c.key, scope: c.scope, kind: c.kind, mode: c.mode, from: c.from, to: c.to, confidence: c.confidence, risk: c.risk, level: c.level, step: c.step, candidate: c.candidate, weak: c.weak, relax: c.relax, reverted: c.reverted });
  const id = (i) => `${i.action}:${i.key}`;
  return json({
    round: r.round, done: r.done, stalled: r.stalled,
    settings_delta: settingsDelta, object_overrides: r.object_overrides,
    changes: changes.map(item), suggested: r.suggested.map(id), unchanged_already: r.unchanged_already.map(id),
    // an unknown condition can list dozens of missing facts: those are digested (the digest of the whole result has them anyway)
    skipped_unknown: r.skipped_unknown.map((u) => [u.action, u.key ?? "", u.reason, u.reason === "unknown-condition" ? digest(u.missing).slice(0, 8) : u.missing.join(",")].join("|")),
    exhausted: r.exhausted.map(({ action, level, steps, text }) => ({ action, level, steps, text: digest(text).slice(0, 8) })), // the text is the action's own: digested to keep the file small
    unknown: r.unknown.map((u) => [u.action, u.where, u.missing.join(","), u.blind.join(",")].join("|")),
    advanced: r.advanced.map(({ action, from, to, steps, skipped_noop }) => ({ action, from, to, steps, skipped_noop })), relaxed: r.relaxed, ladders: r.ladders.map((l) => [l.action, `${l.level}/${l.steps}`, l.relevant, l.trigger].join("|")),
    conflicts: r.conflicts.map(({ scope, key, winner, loser, reason, same_value, combined }) => ({ scope, key, winner, loser, reason, same_value, combined })),
    choices: r.choices.map((c) => [c.action, c.key, c.verified, c.missing.join(",")].join("|")),
    missing_facts: r.missing_facts, blind_facts: r.blind_facts,
    digest: digest({ ...r, applied: undefined, changes }), state_digest: digest(state),
  });
}

/** Facts of each round after the first as {set, del} against the previous round (the draws keep most facts from round to round). */
export function encodeRounds(rounds) {
  return rounds.map((facts, i) => {
    if (!i) return facts;
    const prev = rounds[i - 1], set = {}, del = [];
    for (const [k, v] of Object.entries(facts)) if (!(k in prev) || stable(prev[k]) !== stable(v)) set[k] = v;
    for (const k of Object.keys(prev)) if (!(k in facts)) del.push(k);
    return { set, del };
  });
}
export function expandRounds(encoded) {
  const out = [];
  encoded.forEach((e, i) => {
    if (!i) return out.push(json(e));
    const facts = json(out[i - 1]);
    for (const k of e.del) delete facts[k];
    Object.assign(facts, json(e.set));
    out.push(facts);
  });
  return out;
}

// "%" handling: src/knowledge/condition.ts compares two "%" strings as numbers, the reference as strings. They can differ on a (fact value, condition
// value) pair only when both end in "%"; then the verdict of the condition's own operator under each comparison decides ("99.5%" eq "100%" is false in both).
const NUM = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const num = (v) => (typeof v === "number" ? (Number.isFinite(v) ? v : null) : typeof v === "string" && NUM.test(v.trim()) ? Number(v) : null);
const order = (x, y, s, t) => (x !== null && y !== null ? Math.sign(x - y) : s < t ? -1 : s > t ? 1 : 0);
const refCmp = (a, b) => order(num(a), num(b), String(a), String(b));
const tsCmp = (a, b) => {
  const pct = typeof a === "string" && typeof b === "string" && a.trim().endsWith("%") && b.trim().endsWith("%");
  return order(num(pct ? a.trim().slice(0, -1) : a), num(pct ? b.trim().slice(0, -1) : b), String(a), String(b));
};
const verdict = (op, c) => ({ eq: c === 0, neq: c !== 0, gt: c > 0, gte: c >= 0, lt: c < 0, lte: c <= 0, in: c === 0, any_eq: c === 0, contains: c === 0 })[op];
const isPct = (v) => typeof v === "string" && v.trim().endsWith("%");
const leavesOf = (c, out = []) => {
  if (c.all || c.any) (c.all ?? c.any).forEach((x) => leavesOf(x, out));
  else if (c.not) leavesOf(c.not, out);
  else out.push(c);
  return out;
};
/** Every condition of an action list: [where, condition] */
export function conditionsOf(tuning) {
  const out = [];
  for (const a of tuning) {
    out.push([a.id, a.when]);
    if (a.trigger) out.push([a.id, a.trigger]);
    for (const s of a.steps ?? []) if (s.only_if) out.push([a.id, s.only_if]);
  }
  return out.filter(([, c]) => !(c.all && !c.all.length));
}
/** "%" leaves of a tuning: [{fact, op, values}] for the ops that compare with cmp (not matches/exists). */
export function pctLeaves(tuning) {
  const out = [];
  for (const [, c] of conditionsOf(tuning)) for (const l of leavesOf(c)) {
    if (l.op === "matches" || l.op === "exists") continue;
    const values = [].concat(l.value ?? []).filter(isPct);
    if (values.length) out.push({ fact: l.fact, op: l.op, values });
  }
  return out;
}
/** The (fact, value) pairs of one case where the two evaluators could disagree. Empty = this input cannot tell them apart. */
export function pctDivergence(tuning, base, factsPerRound) {
  const leaves = pctLeaves(tuning);
  const found = [];
  for (const facts of factsPerRound) {
    const all = { ...Object.fromEntries(Object.entries(base).map(([k, v]) => [`settings.${k}`, v])), ...facts };
    for (const { fact, op, values } of leaves) for (const v of [].concat(all[fact] ?? [])) for (const x of values) {
      if (isPct(v) && verdict(op, refCmp(v, x)) !== verdict(op, tsCmp(v, x))) found.push({ fact, op, value: v, condition: x });
    }
  }
  return found;
}

// ---------------------------------------------------------------- the synthetic action set
const SRC = ["guide:1-2"];
const L = (fact, op, value) => ({ fact, op, value });
let seq = 0;
const act = (o) => ({ id: `tune.syn.a${String(++seq).padStart(2, "0")}`, rules: ["bambu.syn.rule"], topic: "bambu.syn.topic", phase: "pre-slice", scope: "process", when: { all: [] }, when_text: "x", mode: "set", set: {}, confidence: "preset", risk: "low", priority: 50, printers: [], applies_to: null, rationale: "x", src: SRC, ...o });
const step = (set, o = {}) => ({ set, why: `why ${JSON.stringify(set)}`, cost: "tempo", expect: "x", confidence: "preset", src: SRC, ...o });
const ladder = (o) => act({ kind: "ladder", phase: "post-slice", relax: false, exhausted: "exhausted text", trigger_text: "x", ...o });
const VARIANTS = ["Direct Drive Standard", "Direct Drive High Flow", "Bowden Standard", "Bowden High Flow"];
export const SYNTHETIC = [
  act({ id: "tune.syn.sticky-hop", phase: "post-slice", when: { all: [L("gcode.crossings", "gt", "0")] }, set: { z_hop: "0.4" } }),
  act({ id: "tune.syn.walls", when: { all: [L("settings.enable_support", "eq", "1")] }, mode: "at_least", set: { wall_loops: "3" } }),
  ladder({ id: "tune.syn.brim-relax", relax: true, trigger: { all: [L("gcode.warp", "gt", "0.5")] }, steps: [step({ brim_type: "outer_only" }), step({ brim_width: "5" }), step({ brim_width: "8", brim_object_gap: "0.1" }, { confidence: "hipotese" })] }),
  ladder({ id: "tune.syn.object-ladder", scope: "object", when: { all: [L("object.is_tall", "eq", "true")] }, trigger: { any: [L("gcode.lean", "gt", "1"), { not: L("gcode.stable", "eq", "1") }] }, steps: [step({ support_top_z_distance: "0.2" }), step({ support_top_z_distance: { ref: "settings.layer_height", mul: 2, round: 2 }, support_bottom_z_distance: "0.2" })] }),
  ladder({ id: "tune.syn.guarded", trigger: { all: [L("gcode.missing", "gt", "0")] }, steps: [step({ sparse_infill_pattern: "gyroid" }, { only_if: { all: [L("settings.sparse_infill_pattern", "in", ["grid", "triangles"])] } }), step({ sparse_infill_density: "20%" }), step({ wall_loops: "4" })] }),
  act({ id: "tune.syn.speed-set", set: { outer_wall_speed: "60" }, priority: 40 }),
  act({ id: "tune.syn.speed-cap", phase: "post-slice", mode: "at_most", priority: 70, elements: { index_by: "print_extruder_variant", starts_with: "Bowden" }, when: { all: [L("gcode.bowden_speed", "gt", "200")] }, set: { outer_wall_speed: "200", inner_wall_speed: "200" } }),
  act({ id: "tune.syn.speed-cap-low", phase: "post-slice", mode: "at_most", priority: 60, when: { all: [L("gcode.bowden_speed", "gt", "150")] }, set: { outer_wall_speed: "120" } }),
  act({ id: "tune.syn.speed-floor", mode: "at_least", priority: 55, set: { outer_wall_speed: "30" } }),
  act({ id: "tune.syn.inner-set", set: { inner_wall_speed: "80" }, priority: 30, confidence: "relato" }),
  act({ id: "tune.syn.choice", kind: "choice", key: "support_threshold_angle", candidates: ["30", "40", "45"], start: 1, start_why: "guide start", evaluated_by: ["gcode.support_weight_g"], when: { all: [L("settings.enable_support", "eq", "1")] } }),
  act({ id: "tune.syn.choice-weak", kind: "choice", key: "tree_support_branch_angle", candidates: ["40", { ref: "settings.layer_height", mul: 100 }], start: 1, confidence: "hipotese", evaluated_by: [], when: { all: [L("project.filament_count", "gte", "1")] } }),
  act({ id: "tune.syn.weak-high-prio", set: { seam_position: "aligned" }, confidence: "hipotese", priority: 90 }),
  act({ id: "tune.syn.strong-low-prio", set: { seam_position: "rear" }, priority: 20 }),
  act({ id: "tune.syn.tie-a", set: { top_shell_layers: "6" }, priority: 50, confidence: "oficial", risk: "medium" }),
  act({ id: "tune.syn.tie-b", set: { top_shell_layers: "5" }, priority: 50, confidence: "oficial", risk: "low" }),
  act({ id: "tune.syn.ref", set: { support_bottom_z_distance: { ref: "settings.layer_height", mul: 1.5, add: 0.05, round: 3 } }, when: { all: [L("settings.enable_support", "eq", "1")] } }),
  act({ id: "tune.syn.list", scope: "filament", set: { nozzle_temperature: "225" }, mode: "at_most", when: { any: [L("filament.type", "any_eq", "PETG"), L("filament.type", "contains", "ABS"), L("filament.profile", "exists")] } }),
  act({ id: "tune.syn.x2d-only", printers: ["x2d"], applies_to: { bambu_studio: ">=2.8" }, set: { reduce_crossing_wall: "1" } }),
  act({ id: "tune.syn.version-exact", applies_to: { bambu_studio: "2.8.4.57" }, set: { detect_overhang_wall: "1" }, when: { all: [L("settings.detect_thin_wall", "matches", "^(0|1)$")] } }),
  ladder({ id: "tune.syn.shadowed", priority: 10, trigger: { all: [L("gcode.shadow", "gt", "0")] }, steps: [step({ seam_position: "back" }), step({ z_hop: "0.8" })] }),
  ladder({ id: "tune.syn.when-unknown", when: { all: [L("object.kind", "eq", "figurine")] }, trigger: { all: [L("gcode.crossings", "gt", "2")] }, steps: [step({ travel_speed: "300" }), step({ travel_speed: "250" })] }),
];
const SYNTHETIC_BASES = [
  { enable_support: "1", wall_loops: "2", layer_height: "0.2", brim_type: "no_brim", brim_width: "0", brim_object_gap: "0", z_hop: "0", sparse_infill_pattern: "grid", sparse_infill_density: "15%", top_shell_layers: "4", support_top_z_distance: "0.15", support_bottom_z_distance: "0.15", seam_position: "nearest", travel_speed: "500", detect_thin_wall: "0", support_threshold_angle: "30", tree_support_branch_angle: "30", outer_wall_speed: "100", inner_wall_speed: "150" },
  { enable_support: "0", wall_loops: "3", layer_height: "0.28", brim_type: "outer_only", brim_width: "3", sparse_infill_pattern: "gyroid", sparse_infill_density: "25%", top_shell_layers: "5", outer_wall_speed: ["300", "300", "250", "250"], inner_wall_speed: ["300", "300", "250", "250"], print_extruder_variant: VARIANTS, nozzle_temperature: ["220", "230", "220", "230"], z_hop: "0.4", detect_thin_wall: "1" },
  { layer_height: "0.12", nozzle_temperature: ["260"], outer_wall_speed: ["200"], print_extruder_variant: ["Bowden Standard"], seam_position: "aligned", top_shell_layers: "7" },
  { outer_wall_speed: ["300", "300", "250"], inner_wall_speed: ["300", "300", "250", "250"], print_extruder_variant: VARIANTS, wall_loops: "1" },
  {},
];
const SYNTHETIC_STUDIO_KEYS = { nozzle_temperature: { is_list: true, project_array_len: 2 }, outer_wall_speed: { is_list: true, project_array_len: 4 }, inner_wall_speed: { is_list: true, project_array_len: 4 } };

// ---------------------------------------------------------------- seeded draws
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const chance = (rng, p) => rng() < p;

/** Values worth trying for one condition leaf: some that make it true, some that make it false. */
function derive(leaf) {
  const v = leaf.value;
  const n = typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null;
  const out = [];
  switch (leaf.op) {
    case "eq": case "any_eq": case "contains": out.push(v, n !== null ? String(n + 1) : `${v}~`); break;
    case "neq": out.push(v, n !== null ? String(n + 1) : `${v}~`, "0"); break;
    case "gt": case "gte": case "lt": case "lte": if (n !== null) out.push(String(n + 1), String(n), String(n - 1), n + 1, n, n - 1); else out.push(`${v}~`, v); break;
    case "in": out.push(...(Array.isArray(v) ? v : []), "zz"); break;
    case "exists": out.push("1"); break;
    case "matches": { const plain = String(v).replace(/^\^|\$$/g, "").replace(/\\\./g, "."); if (/^[\w .%-]+$/.test(plain)) out.push(plain); break; }
    default: break;
  }
  if (v === "true" || v === "false") out.push("true", "false", true, false);
  return out;
}

/** Everything the draws pick from: values per fact and per base key, the shapes of real bases. */
function harvest(tuning, evalData, bases) {
  const facts = new Map(), settings = new Map();
  const put = (map, k, v) => { if (!map.has(k)) map.set(k, new Map()); map.get(k).set(stable(v), v); };
  const putFact = (f, v) => (f.startsWith("settings.") ? put(settings, f.slice(9), v) : put(facts, f, v));
  for (const s of evalData.scenarios ?? []) {
    for (const [f, v] of Object.entries(s.facts ?? {})) putFact(f, v);
    for (const [k, v] of Object.entries(s.base ?? s.base_settings ?? {})) put(settings, k, v);
  }
  for (const q of evalData.sequences ?? []) {
    for (const [k, v] of Object.entries(q.base_settings)) put(settings, k, v);
    for (const r of q.rounds) for (const [f, v] of Object.entries(r.facts ?? {})) putFact(f, v);
  }
  for (const b of bases) for (const [k, v] of Object.entries(b)) put(settings, k, v);
  for (const [, c] of conditionsOf(tuning)) for (const l of leavesOf(c)) for (const v of derive(l)) putFact(l.fact, v);
  for (const a of tuning) {
    for (const [k, v] of Object.entries(a.set ?? {})) if (typeof v === "string") put(settings, k, v);
    for (const s of a.steps ?? []) for (const [k, v] of Object.entries(s.set)) if (typeof v === "string") put(settings, k, v);
    if (a.kind === "choice") for (const v of a.candidates) if (typeof v === "string") put(settings, a.key, v);
    for (const f of a.evaluated_by ?? []) put(facts, f, "1");
  }
  const factNames = [...new Set([...facts.keys(), ...tuning.flatMap((a) => (a.evaluated_by ?? []))])].sort();
  const flat = (m) => new Map([...m.entries()].map(([k, vals]) => [k, [...vals.values()]]));
  const used = new Set();
  for (const [, c] of conditionsOf(tuning)) for (const l of leavesOf(c)) if (l.fact.startsWith("settings.")) used.add(l.fact.slice(9));
  return { facts: flat(facts), settings: flat(settings), factNames, settingKeys: [...settings.keys()].sort(), conditionSettingKeys: [...used].sort(), bases };
}

const PRINTERS = [undefined, undefined, "x2d", "Bambu Lab X2D", "a1", "A1 mini", "h2d", "p2s", "h2c", "h2s", ["x2d", "a1"]];
const VERSIONS = [undefined, undefined, "2.8.4.57", "02.08.04.57", "2.7.1.0", "2.9.0.1", "3.0.0.0", "2.8", "2.8.0.0", "garbage"];
const UNAVAILABLE = [undefined, undefined, undefined, ["gcode."], ["gcode.missing_thin_feature_count"], ["mesh.", "gcode.unprotected_travel_crossing_count"], ["plate.", "slicer."], ["gcode.crossings", "gcode.warp"]];
const PHASES = [undefined, undefined, undefined, "pre-slice", "post-slice", "all"];
const APPLY = [undefined, undefined, undefined, undefined, undefined, ["preset", "oficial"], ["preset", "oficial", "bug conhecido", "teste de revisor", "relato", "hipotese", "nao verificado"]];

function drawBase(rng, H) {
  const t = pick(rng, H.bases);
  const base = json(t);
  const patch = { set: {}, del: [] };
  for (const k of H.conditionSettingKeys.concat(H.settingKeys)) {
    if (!chance(rng, H.conditionSettingKeys.includes(k) ? 0.3 : 0.02)) continue;
    if (chance(rng, 0.12) && k in base) { delete base[k]; patch.del.push(k); continue; }
    let v = json(pick(rng, H.settings.get(k) ?? [""]));
    if (typeof v === "number") v = String(v); // a project stores every setting as a string
    if (typeof v === "string" && Array.isArray(base[k]) && chance(rng, 0.8)) v = base[k].map(() => v);
    base[k] = v;
    patch.set[k] = v;
  }
  return { base, from: H.bases.indexOf(t), patch };
}

function drawFacts(rng, H, density, prev, keep) {
  const facts = {};
  for (const f of H.factNames) {
    if (prev && chance(rng, keep)) { if (f in prev) facts[f] = prev[f]; continue; }
    if (!chance(rng, density)) continue;
    facts[f] = chance(rng, 0.03) ? null : json(pick(rng, H.facts.get(f) ?? ["1"]));
  }
  for (const k of H.conditionSettingKeys) if (chance(rng, 0.03)) facts[`settings.${k}`] = json(pick(rng, H.settings.get(k) ?? ["1"]));
  if (prev) for (const [f, v] of Object.entries(prev)) if (f.startsWith("settings.") && chance(rng, keep) && !(f in facts)) facts[f] = v;
  return facts;
}

function drawCase(rng, H, tuning, i, studioKeysSubset) {
  for (let attempt = 0; ; attempt++) {
    const { base, from, patch } = drawBase(rng, H);
    const density = chance(rng, 0.3) ? 0.45 + rng() * 0.25 : 0.88 + rng() * 0.12; // some draws leave many facts unknown, most leave few
    const rounds = [drawFacts(rng, H, density, null, 0)];
    const n = 1 + Math.floor(rng() * 5);
    while (rounds.length < n) rounds.push(drawFacts(rng, H, density, rounds.at(-1), 0.7));
    const options = { printer: pick(rng, PRINTERS), studio_version: pick(rng, VERSIONS), phase: pick(rng, PHASES), unavailable: pick(rng, UNAVAILABLE), apply_confidences: pick(rng, APPLY), studio_keys: studioKeysSubset && chance(rng, 0.35) };
    if (pctDivergence(tuning, base, rounds).length && attempt < 20) continue; // cannot happen with these pools; kept so the claim never depends on luck
    if (pctDivergence(tuning, base, rounds).length) throw new Error(`draw ${i}: a "%" value that separates the two evaluators`);
    return json({ id: `random:${i}`, base: { from, ...patch }, options, rounds });
  }
}

// ---------------------------------------------------------------- running the reference
export const refOptions = (o, studioKeys) => ({ printer: o.printer, studioVersion: o.studio_version, phase: o.phase, unavailable: o.unavailable, applyConfidences: o.apply_confidences, studioKeys: o.studio_keys ? studioKeys : undefined });
/** base of a case: golden.bases[from] with the patch applied. */
export function materialize(bases, b) {
  const base = json(bases[b.from]);
  for (const k of b.del ?? []) delete base[k];
  for (const [k, v] of Object.entries(b.set ?? {})) base[k] = json(v);
  return base;
}

/** Runs one case with an engine {applyTuning, nextRound, simulate}: the per-round summaries and the digest of the whole simulation. */
export function runCase(engine, tuning, c, base, studioKeys, onRound = () => {}) {
  const options = refOptions(c.options, studioKeys);
  let state;
  const rounds = c.rounds.map((facts, i) => {
    const r = i === 0 ? engine.applyTuning(tuning, facts, base, options) : engine.nextRound(tuning, state, facts, options);
    state = r.state;
    onRound(json(r));
    return summarize(r, base);
  });
  const sim = engine.simulate(tuning, base, c.rounds, options);
  return { rounds, simulation: digest(json(sim)) };
}

function pctReport(cases, tuning, bases) {
  return cases.filter((c) => pctDivergence(tuning, materialize(bases, c.base), c.rounds).length).length;
}

async function main() {
  const refDir = path.resolve(process.argv[2] || process.env.KB_TUNING_DIR || path.join(ROOT, "..", "kb", "tuning"));
  const ref = await import(pathToFileURL(path.join(refDir, "evaluate-tuning.mjs")).href);
  const read = (p) => fs.readFileSync(p, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const shipped = JSON.parse(read(path.join(ROOT, "knowledge/tuning/tuning.json")));
  const evalData = JSON.parse(read(path.join(ROOT, "tests/fixtures/tuning/eval.json")));
  const allKeys = JSON.parse(read(path.join(refDir, "studio-keys.json"))).keys;
  const desk = JSON.parse(read(path.join(refDir, "fixtures/desk-organizer.project_settings.json")));

  // studio-keys, cut to the keys the actions write or read: all the engine needs is how long an absent list is.
  const wanted = new Set();
  for (const a of shipped) {
    for (const k of Object.keys(a.set ?? {})) wanted.add(k);
    for (const s of a.steps ?? []) for (const k of Object.keys(s.set)) wanted.add(k);
    if (a.key) wanted.add(a.key);
    for (const [, c] of conditionsOf([a])) for (const l of leavesOf(c)) if (l.fact.startsWith("settings.")) wanted.add(l.fact.slice(9));
  }
  const studioKeys = Object.fromEntries([...wanted].sort().filter((k) => allKeys[k]).map((k) => [k, { is_list: allKeys[k].is_list, project_array_len: allKeys[k].project_array_len }]));

  const bases = [];
  const baseIndex = (b) => { const s = stable(b); let i = bases.findIndex((x) => stable(x) === s); if (i < 0) i = bases.push(json(b)) - 1; return i; };
  const out = [], raw = [];
  const record = (suite, tuning, c, keys) => {
    const base = materialize(bases, c.base);
    const got = runCase(ref, tuning, c, base, keys, (r) => raw.push(r));
    out.push({ suite, ...c, expect: got });
  };

  // shipped suite: the eval data, then the draws
  const evalCases = [];
  for (const s of evalData.scenarios) evalCases.push({ id: `eval:scenario:${s.name}`, base: { from: baseIndex(s.base ?? s.base_settings ?? {}) }, options: { printer: s.printer, studio_version: s.studio_version, phase: s.phase, unavailable: s.unavailable, studio_keys: true }, rounds: [s.facts ?? {}] });
  for (const q of evalData.sequences) {
    const o = q.options ?? {};
    evalCases.push({ id: `eval:sequence:${q.id}`, base: { from: baseIndex(q.base_settings) }, options: { printer: o.printer, studio_version: o.studio_version, phase: o.phase, unavailable: o.unavailable, studio_keys: true }, rounds: q.rounds.map((r) => r.facts ?? {}) });
  }
  const H = harvest(shipped, evalData, [desk]);
  H.bases = [...evalCases.map((c) => bases[c.base.from]).filter((b) => Object.keys(b).length), desk];
  const rng = mulberry32(SEED);
  const shippedCases = [...evalCases];
  for (let i = 0; i < SHIPPED_DRAWS; i++) {
    const c = drawCase(rng, H, shipped, i, true);
    c.base = { from: baseIndex(H.bases[c.base.from]), set: c.base.set, del: c.base.del };
    shippedCases.push(c);
  }
  for (const c of shippedCases) record("shipped", shipped, c, studioKeys);

  // synthetic suite
  const synBases = SYNTHETIC_BASES.map((b) => baseIndex(b));
  const HS = harvest(SYNTHETIC, {}, SYNTHETIC_BASES);
  HS.bases = SYNTHETIC_BASES;
  const rngS = mulberry32(SEED + 1);
  const syntheticCases = [];
  for (let i = 0; i < SYNTHETIC_DRAWS; i++) {
    const c = drawCase(rngS, HS, SYNTHETIC, i, true);
    c.base = { from: synBases[c.base.from], set: c.base.set, del: c.base.del };
    syntheticCases.push(c);
  }
  for (const c of syntheticCases) record("synthetic", SYNTHETIC, c, SYNTHETIC_STUDIO_KEYS);

  // coverage of the reference's own branches, so a weak draw set shows up in the file instead of hiding
  const count = (pred) => raw.filter(pred).length;
  const reason = (x) => (r) => r.skipped_unknown.some((u) => u.reason === x);
  const coverage = {
    rounds: raw.length,
    applied: count((r) => (r.applied ?? r.changes).length), suggested: count((r) => r.suggested.length), unchanged_already: count((r) => r.unchanged_already.length),
    skipped_unknown: count((r) => r.skipped_unknown.length), conflicts: count((r) => r.conflicts.length), combined_conflicts: count((r) => r.conflicts.some((c) => c.combined)),
    object_overrides: count((r) => Object.keys(r.object_overrides).length), advanced: count((r) => r.advanced.length), skipped_noop: count((r) => r.advanced.some((a) => a.skipped_noop)),
    relaxed: count((r) => r.relaxed.length), exhausted: count((r) => r.exhausted.length), unknown_trigger: count((r) => r.unknown.some((u) => u.where === "trigger")),
    unknown_when: count((r) => r.unknown.some((u) => u.where === "when")), blind: count((r) => r.blind_facts.length), reverted: count((r) => (r.applied ?? r.changes).some((c) => c.reverted)),
    relax_changes: count((r) => (r.applied ?? r.changes).some((c) => c.relax)), choices_verified: count((r) => r.choices.some((c) => c.verified)), done: count((r) => r.done), stalled: count((r) => r.stalled),
    elements_unresolved: count(reason("unresolvable-elements")), unit_mismatch: count(reason("unit-mismatch")), unresolvable_ref: count(reason("unresolvable-ref")),
    bound_on_top: count((r) => r.conflicts.some((c) => c.combined)),
  };
  const meta = {
    about: "Reference outputs of kb/tuning/evaluate-tuning.mjs; regenerate with scripts/gen-tuning-golden.mjs. Hashes and names only.",
    seed: SEED,
    tuning_sha256: sha(read(path.join(ROOT, "knowledge/tuning/tuning.json"))),
    reference: { "evaluate-tuning.mjs": sha(read(path.join(refDir, "evaluate-tuning.mjs"))), "evaluate-rules.mjs": sha(read(path.join(refDir, "..", "evaluate-rules.mjs"))) },
    counts: { shipped_eval_cases: evalCases.length, shipped_random: SHIPPED_DRAWS, synthetic_random: SYNTHETIC_DRAWS, cases: out.length },
    pct_dependent_cases: pctReport(shippedCases, shipped, bases) + pctReport(syntheticCases, SYNTHETIC, bases),
    coverage,
  };
  for (const c of out) c.rounds = encodeRounds(c.rounds);
  const lines = (list) => `[\n${list.map((x) => JSON.stringify(x)).join(",\n")}\n]`;
  const text = `{\n"meta": ${JSON.stringify(meta, null, 1)},\n"studio_keys": ${JSON.stringify(studioKeys)},\n"synthetic_studio_keys": ${JSON.stringify(SYNTHETIC_STUDIO_KEYS)},\n"synthetic": ${lines(SYNTHETIC)},\n"bases": ${lines(bases)},\n"cases": ${lines(out)}\n}`;
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  fs.writeFileSync(GOLDEN, `${text}\n`);
  console.log(`wrote ${path.relative(ROOT, GOLDEN)}: ${out.length} cases, ${(text.length / 1e6).toFixed(2)} MB`);
  console.log(JSON.stringify(coverage));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
}
