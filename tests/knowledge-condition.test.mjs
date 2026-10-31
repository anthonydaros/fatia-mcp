import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evalCondition, ruleStatus } from "../dist/knowledge/condition.js";

const L = (fact, op, value) => ({ fact, op, value });
const E = (c, f) => evalCondition(c, f);
const fixture = (...parts) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(parts.join("/"), import.meta.url)), "utf8"));

test("numbers compare numerically when both sides parse, otherwise as case-sensitive strings", () => {
  assert.equal(E(L("a", "eq", "0.4"), { a: "0.40" }), true);
  assert.equal(E(L("a", "eq", "0.4"), { a: 0.4 }), true);
  assert.equal(E(L("a", "lt", "10"), { a: "9" }), true, "numeric, not lexicographic");
  assert.equal(E(L("a", "gt", "256"), { a: 256 }), false);
  assert.equal(E(L("a", "lte", "30"), { a: 30 }), true);
  assert.equal(E(L("a", "eq", "PLA"), { a: "pla" }), false);
  assert.equal(E(L("a", "eq", "true"), { a: true }), true, "booleans compare as 'true'/'false'");
  assert.equal(E(L("a", "eq", "1"), { a: true }), false);
  assert.equal(E(L("a", "gte", "2.8.4.57"), { a: "2.8.4.57" }), true, "versions are strings");
});

test("percentages compare as numbers only when both sides carry the % sign", () => {
  assert.equal(E(L("a", "eq", "25%"), { a: "25%" }), true);
  assert.equal(E(L("a", "eq", "25%"), { a: "25.0%" }), true);
  assert.equal(E(L("a", "lt", "30%"), { a: "5%" }), true, "5% < 30% numerically; as strings it would be false");
  assert.equal(E(L("a", "gt", "30%"), { a: "100%" }), true);
  assert.equal(E(L("a", "eq", "25%"), { a: "25" }), false, "a bare 25 is not 25%");
  assert.equal(E(L("a", "eq", "25"), { a: "25%" }), false);
  assert.equal(E(L("a", "eq", "25%"), { a: 25 }), false);
  assert.equal(E(L("l", "eq", "15%"), { l: ["15%", "15.00%"] }), true, "lists too");
  assert.equal(E(L("a", "matches", "^10(\\.0+)?%?$"), { a: "10%" }), true, "matches sees the raw text");
});

test("operator table on lists: every element, except any_eq and contains", () => {
  assert.equal(E(L("l", "eq", "PLA"), { l: ["PLA", "PLA"] }), true);
  assert.equal(E(L("l", "eq", "PLA"), { l: ["PLA", "PETG"] }), false);
  assert.equal(E(L("l", "neq", "PLA"), { l: ["PETG", "PLA"] }), false, "neq every: one equal makes it false");
  assert.equal(E(L("l", "neq", "PLA"), { l: ["PETG", "ABS"] }), true);
  assert.equal(E(L("l", "gt", "0"), { l: ["0.4", "0"] }), false);
  assert.equal(E(L("l", "lt", "1"), { l: ["0.4", "0"] }), true);
  assert.equal(E(L("l", "gte", "0.4"), { l: ["0.4", "0.6"] }), true);
  assert.equal(E(L("l", "lte", "0.4"), { l: ["0.4", "0.6"] }), false);
  assert.equal(E(L("l", "any_eq", "PETG"), { l: ["PLA", "PETG"] }), true);
  assert.equal(E(L("l", "any_eq", "ABS"), { l: ["PLA", "PETG"] }), false);
  assert.equal(E(L("l", "contains", "PETG"), { l: ["PLA", "PETG"] }), true);
  assert.equal(E(L("l", "contains", "PET"), { l: ["PLA", "PETG"] }), false, "list contains is exact");
  assert.equal(E(L("l", "in", ["a", "b"]), { l: ["a", "b"] }), true);
  assert.equal(E(L("l", "in", ["a", "b"]), { l: ["a", "c"] }), false);
  assert.equal(E(L("l", "matches", "^Bambu"), { l: ["Bambu PLA", "Generic"] }), false);
  assert.equal(E(L("l", "eq", "0"), { l: [] }), true, "empty list: vacuous");
  assert.equal(E(L("l", "any_eq", "0"), { l: [] }), false);
});

test("operator table on scalars", () => {
  assert.equal(E(L("s", "contains", "Lite"), { s: "AMS Lite" }), true, "substring");
  assert.equal(E(L("a", "any_eq", "0.2"), { a: "0.20" }), true);
  assert.equal(E(L("a", "in", ["by object", "By object"]), { a: "By object" }), true);
  assert.equal(E(L("a", "matches", "A1$"), { a: "A1" }), true);
  assert.equal(E(L("a", "matches", "A1$"), { a: "A1 mini" }), false);
  assert.equal(E(L("a", "matches", "A1"), { a: "A1 mini" }), true, "unanchored");
  assert.equal(E(L("a", "exists"), { a: 0 }), true, "falsy values exist");
  assert.equal(E(L("a", "exists"), { a: null }), false, "null = known absent");
  assert.equal(E(L("a", "neq", "1"), { a: "2" }), true);
});

test("a missing fact makes a leaf unknown (undefined) for every operator, null stays unknown except exists", () => {
  for (const op of ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "matches", "any_eq", "exists"]) {
    assert.equal(E(L("a", op, "1"), {}), undefined, op);
  }
  assert.equal(E(L("a", "in", ["1"]), {}), undefined);
  assert.equal(E(L("a", "eq", "1"), { a: null }), undefined);
});

test("an invalid regular expression is unknown, never an exception", () => {
  assert.equal(E(L("a", "matches", "("), { a: "x" }), undefined);
  assert.equal(E(L("l", "matches", "[a-"), { l: ["x", "y"] }), undefined);
  assert.equal(E({ all: [L("a", "matches", "("), L("b", "eq", "1")] }, { a: "x", b: "2" }), false, "false still beats unknown");
});

test("an oversized subject for matches is unknown and returns fast (no regex stall on a crafted 3MF)", () => {
  const rule = fixture("../knowledge/rules.json").find(r => r.id === "bambu.quality.wall-order-three-with-overhangs");
  const t0 = Date.now();
  assert.equal(ruleStatus(rule, { "settings.wall_sequence": "inner".repeat(200_000), "mesh.overhang_area_mm2": 1 }), undefined);
  assert.ok(Date.now() - t0 < 1000, "must not run the quadratic pattern");
  assert.equal(E(L("a", "matches", "x"), { a: "x".repeat(4096) }), true, "at the cap it still runs");
  assert.equal(E(L("a", "matches", "x"), { a: "x".repeat(4097) }), undefined);
  assert.equal(E(L("l", "matches", "x"), { l: ["x", "x".repeat(5000)] }), undefined, "list elements too");
});

test("three-valued all / any / not", () => {
  const T = L("t", "eq", "1"), F = L("f", "eq", "1"), U = L("u", "eq", "1"), f = { t: 1, f: 0 };
  assert.equal(E({ all: [T, T] }, f), true);
  assert.equal(E({ all: [T, U] }, f), undefined);
  assert.equal(E({ all: [F, U] }, f), false);
  assert.equal(E({ any: [F, U] }, f), undefined);
  assert.equal(E({ any: [T, U] }, f), true);
  assert.equal(E({ any: [F, F] }, f), false);
  assert.equal(E({ not: U }, f), undefined);
  assert.equal(E({ not: F }, f), true);
  assert.equal(E({ not: T }, f), false);
  assert.equal(E({ not: { all: [F, U] } }, f), true);
});

test("malformed conditions throw", () => {
  assert.throws(() => E(L("a", "zzz", "1"), { a: 1 }), /bad op/);
  assert.throws(() => E({ all: [] }, {}), /non-empty/);
  assert.throws(() => E(L("a", "in", "x"), { a: "x" }), /array/);
});

test("rule printer scope is part of the verdict", () => {
  const T = L("t", "eq", "1");
  const rule = { printers: ["a1", "a1-mini"], detect: { when: T } };
  assert.equal(ruleStatus(rule, { t: 1, "printer.model": "A1 mini" }), true);
  assert.equal(ruleStatus(rule, { t: 1, "printer.model": "Bambu Lab A1" }), true);
  assert.equal(ruleStatus(rule, { t: 1, "printer.model": "X2D" }), false);
  assert.equal(ruleStatus(rule, { t: 1 }), undefined, "unknown printer");
  assert.equal(ruleStatus(rule, { t: 0 }), false, "false condition beats unknown printer");
  assert.equal(ruleStatus({ ...rule, printers: [] }, { t: 1 }), true);
});

test("every scenario of the reference evaluator (kb/out/eval.json) gives the same verdicts", () => {
  const rules = fixture("../knowledge/rules.json");
  const { scenarios } = fixture("fixtures/knowledge/eval.json");
  assert.equal(scenarios.length, 76);
  const problems = [];
  for (const s of scenarios) {
    const fires = [], unchecked = [], notFired = [];
    for (const r of rules) {
      if (!r.detect?.when) continue;
      const v = ruleStatus(r, s.facts);
      (v === true ? fires : v === undefined ? unchecked : notFired).push(r.id);
    }
    if (fires.sort().join() !== [...s.expect_rules].sort().join()) problems.push(`${s.name}: fires [${fires}] expected [${s.expect_rules}]`);
    for (const id of s.expect_not) if (!notFired.includes(id)) problems.push(`${s.name}: ${id} must evaluate to false`);
    for (const id of s.expect_unchecked ?? []) if (!unchecked.includes(id)) problems.push(`${s.name}: ${id} must be unchecked`);
  }
  assert.deepEqual(problems, []);
});
