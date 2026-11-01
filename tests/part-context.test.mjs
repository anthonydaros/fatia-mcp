// Declared part facts (src/tuning/part-context.ts): validation against the data's own vocabulary, facts with provenance, the actions each declaration
// would enable, the "skipped because the part was not described" sentence, and geometry offered only as numbers.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyTuning } from "../dist/tuning/engine.js";
import { DECLARED_FACTS, PART_BOOLEANS, PART_ENUMS, declarationImpact, parsePartContext, partContextFacts, skippedByUndeclared, suggestDeclarations } from "../dist/tuning/part-context.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TUNING = JSON.parse(fs.readFileSync(path.join(ROOT, "knowledge/tuning/tuning.json"), "utf8"));

test("a declaration is validated key by key; nothing is coerced", () => {
  assert.deepEqual(parsePartContext(undefined), {});
  assert.deepEqual(parsePartContext(null), {});
  assert.deepEqual(parsePartContext({ kind: "keychain", load_class: "high_load", is_tiny_part: false, mold_kind: undefined }), { kind: "keychain", load_class: "high_load", is_tiny_part: false });
  assert.throws(() => parsePartContext([]), /must be an object/);
  assert.throws(() => parsePartContext("keychain"), /must be an object/);
  assert.throws(() => parsePartContext({ kind: "bracket" }), /kind must be one of keychain, pix_plate, face_down_plate, other/);
  assert.throws(() => parsePartContext({ load_class: "heavy" }), /load_class must be one of none, functional, high_load/);
  assert.throws(() => parsePartContext({ is_large_part: "true" }), /is_large_part must be true or false/);
  assert.throws(() => parsePartContext({ is_large_part: 1 }), /must be true or false/);
  assert.throws(() => parsePartContext({ is_huge: true }), /unknown key "is_huge"/);
  assert.throws(() => parsePartContext({ __proto__: null, kind: 3 }), /kind must be one of/);
});

test("the vocabulary is the data's: every literal tuning.json compares a declared fact with is accepted, and every declared fact is read by some action", () => {
  const seen = {};
  const walk = (c) => {
    if (!c) return;
    if (c.fact?.startsWith("object.") && DECLARED_FACTS.includes(c.fact)) for (const v of [].concat(c.value)) (seen[c.fact] ??= new Set()).add(v);
    for (const k of ["all", "any"]) (c[k] ?? []).forEach(walk);
    if (c.not) walk(c.not);
  };
  for (const a of TUNING) { walk(a.when); walk(a.trigger); (a.steps ?? []).forEach((s) => walk(s.only_if)); }
  for (const [fact, values] of Object.entries(seen)) {
    const key = fact.slice("object.".length);
    const allowed = PART_ENUMS[key] ?? ["true"];
    for (const v of values) assert.ok(allowed.includes(v), `${fact} is compared with "${v}", outside ${allowed.join("|")}`);
  }
  for (const key of [...Object.keys(PART_ENUMS), ...PART_BOOLEANS]) assert.ok(seen[`object.${key}`], `object.${key} is read by no action`);
});

test("declared facts: object.* names, the declared value, provenance 'declared'", () => {
  const d = partContextFacts({ kind: "face_down_plate", is_tall_narrow: true, is_large_part: false });
  assert.deepEqual(d.facts, { "object.kind": "face_down_plate", "object.is_tall_narrow": true, "object.is_large_part": false });
  assert.deepEqual(d.provenance, { "object.kind": "declared", "object.is_tall_narrow": "declared", "object.is_large_part": "declared" });
  assert.match(d.evidence["object.kind"].source, /declared/);
  assert.deepEqual(partContextFacts({}).facts, {});
  assert.throws(() => partContextFacts({ kind: "x" }), /kind must be one of/);
});

test("'not a mold' (mold_kind none) makes the mold actions false instead of unknown; undeclared stays unknown", () => {
  const molds = TUNING.filter((a) => a.id.startsWith("tune.mold."));
  const none = applyTuning(molds, partContextFacts({ mold_kind: "none" }).facts, {});
  assert.ok(none.skipped_unknown.every((s) => !s.missing.includes("object.mold_kind")));
  const undeclared = applyTuning(molds, {}, {});
  assert.ok(undeclared.skipped_unknown.length > 0 && undeclared.skipped_unknown.every((s) => s.missing.includes("object.mold_kind")));
});

test("declarationImpact lists, per declarable fact, the actions that read it and what else they still need", () => {
  const impact = declarationImpact(TUNING);
  const by = Object.fromEntries(impact.map((i) => [i.fact, i]));
  assert.equal(by["object.load_class"].actions.length, 14);
  assert.ok(by["object.load_class"].actions.some((a) => a.id === "tune.strength.wall-loops-high-load"));
  assert.equal(impact[0].fact, "object.load_class"); // most actions first
  const fit = by["object.has_fit_pins_and_holes"].actions.find((a) => a.id === "tune.walls.fit-parts-order");
  assert.ok(fit.also_needs.includes("object.mold_kind") && fit.also_needs.includes("mesh.unsupported_overhang_area_mm2"));
  const cut = by["object.is_cut_part"].actions.find((a) => a.id === "tune.cut.elephant-foot-seam-choice");
  assert.ok(cut.also_needs.includes("object.flat_cut_or_pin_base_on_bed")); // declaring is_cut_part alone does not enable it
  const withMold = declarationImpact(TUNING, ["object.mold_kind", "mesh.unsupported_overhang_area_mm2"]);
  assert.equal(withMold.find((i) => i.fact === "object.mold_kind").declared, true);
  assert.deepEqual(withMold.find((i) => i.fact === "object.has_fit_pins_and_holes").actions[0].also_needs, []);
  assert.equal(impact.find((i) => i.fact === "object.origin"), undefined);
});

test("skippedByUndeclared turns an engine result into the sentence for the report", () => {
  const r = applyTuning(TUNING, {}, {});
  const s = skippedByUndeclared(r);
  assert.ok(s.count >= 14, `count ${s.count}`);
  assert.ok(s.by_fact["object.load_class"].length >= 12);
  assert.match(s.text, /^\d+ actions were skipped because the part was not described: object\.load_class \(\d+\)/);
  const declared = applyTuning(TUNING, partContextFacts({ load_class: "none", kind: "other", mold_kind: "none" }).facts, {});
  const after = skippedByUndeclared(declared);
  assert.equal(after.by_fact["object.load_class"], undefined);
  assert.ok(after.count < s.count);
  assert.equal(skippedByUndeclared({ skipped_unknown: [], unknown: [] }).count, 0);
});

test("suggested declarations carry the numbers and never a value", () => {
  const facts = { "mesh.height_mm": 100, "mesh.footprint_area_mm2": 25, "mesh.height_to_footprint": 20, "mesh.size_x_mm": 5, "mesh.size_y_mm": 5 };
  const s = suggestDeclarations(facts);
  assert.deepEqual(s.map((x) => x.fact), ["object.is_tall_narrow", "object.is_tiny_part", "object.is_large_part"]);
  assert.deepEqual(s[0].numbers, { "mesh.height_mm": 100, "mesh.footprint_area_mm2": 25, "mesh.height_to_footprint": 20 });
  for (const x of s) { assert.equal("value" in x, false); assert.match(x.note, /no threshold/); }
  assert.deepEqual(suggestDeclarations({ "mesh.height_mm": 100 }), []);
  assert.deepEqual(suggestDeclarations({}), []);
});
