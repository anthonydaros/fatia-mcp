// knowledge/tuning/: the shipped tuning data, its build-time contract check (scripts/validate-knowledge.mjs), and the lazy, failure-isolated loader.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadKbFrom } from "../dist/knowledge/loader.js";
import { getTuning, loadTuningFrom, tuningDir } from "../dist/tuning/loader.js";
import { MANIFEST_FILES, TUNING_FILES, validateKnowledge } from "../scripts/validate-knowledge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KB = path.join(ROOT, "knowledge");
const TUNING_EVAL = path.join(ROOT, "tests/fixtures/tuning/eval.json");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuning-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A copy of knowledge/ with one tuning file rewritten by `edit(parsedJson)`. */
function copyKb(t, edits = {}) {
  const dir = path.join(scratch(t), "kb folder");
  fs.cpSync(KB, dir, { recursive: true });
  for (const [name, edit] of Object.entries(edits)) {
    const file = path.join(dir, "tuning", name);
    const data = readJson(file);
    edit(data);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }
  return dir;
}

/** Contract errors of a knowledge folder (manifest hashes are not the subject unless asked). */
const errorsOf = (dir, checkManifest = false) => validateKnowledge(dir, path.join(ROOT, "tests/fixtures/knowledge/eval.json"), { checkManifest, tuningEvalFile: TUNING_EVAL }).errors;

test("the shipped tuning data passes the contract check and matches the manifest", () => {
  assert.deepEqual(errorsOf(KB, true), []);
  const manifest = readJson(path.join(KB, "manifest.json"));
  for (const name of MANIFEST_FILES) assert.match(manifest.files[name], /^[0-9a-f]{64}$/, `${name} has a hash in the manifest`);
  assert.deepEqual(TUNING_FILES.map((n) => `tuning/${n}`).every((n) => n in manifest.files), true);
  assert.equal(manifest.counts.actions, 141);
  assert.equal(manifest.counts.no_action, 137);
  assert.doesNotMatch(JSON.stringify(manifest), /\/Users\/|[A-Z]:\\|\.\.\//, "the manifest holds no absolute path");
});

test("every bambu rule is covered once: by an action or by a no_action entry", () => {
  const rules = readJson(path.join(KB, "rules.json")).filter((r) => r.domain === "bambu");
  const actions = readJson(path.join(KB, "tuning/tuning.json"));
  const noAction = readJson(path.join(KB, "tuning/no_action.json"));
  const covered = new Set([...actions.flatMap((a) => a.rules), ...noAction.map((n) => n.rule)]);
  assert.deepEqual(rules.filter((r) => !covered.has(r.id)).map((r) => r.id), []);
  assert.equal(JSON.stringify(actions).includes("blender."), false, "no action mentions a blender.* fact");
});

test("the loader reads, validates and indexes the shipped tuning data", () => {
  const kb = loadKbFrom(KB);
  const tuning = loadTuningFrom(path.join(KB, "tuning"), kb);
  assert.equal(tuning.integrity, "ok");
  assert.equal(tuning.version, readJson(path.join(KB, "manifest.json")).kb_version);
  assert.equal(tuning.actions.length, 141);
  assert.equal(tuning.noAction.length, 137);
  assert.equal(tuning.facts.length, 25);
  assert.equal(tuning.actionById.size, tuning.actions.length);
  assert.deepEqual(new Set(tuning.actions.map((a) => a.kind ?? "definite")), new Set(["definite", "choice", "ladder"]));
});

test("a BOM, Windows line endings or an edited file change nothing but the integrity flag", (t) => {
  const crlf = (text) => `﻿${text.replace(/\n/g, "\r\n")}`;
  const dir = copyKb(t);
  for (const n of ["tuning/tuning.json", "tuning/no_action.json", "manifest.json"]) fs.writeFileSync(path.join(dir, n), crlf(fs.readFileSync(path.join(dir, n), "utf8")));
  assert.equal(loadTuningFrom(path.join(dir, "tuning"), loadKbFrom(dir)).integrity, "ok");
  const edited = copyKb(t, { "tuning.json": (a) => { a[0].title += " (edited)"; } });
  const loaded = loadTuningFrom(path.join(edited, "tuning"), loadKbFrom(edited));
  assert.equal(loaded.integrity, "mismatch");
  assert.ok(loaded.actions[0].title.endsWith("(edited)"));
});

test("the loader refuses data the engine could not run on, with the action id in the message", (t) => {
  const load = (edits) => { const dir = copyKb(t, edits); return () => loadTuningFrom(path.join(dir, "tuning"), loadKbFrom(dir)); };
  assert.throws(load({ "tuning.json": (a) => a.push(structuredClone(a[0])) }), /duplicate action id/);
  assert.throws(load({ "tuning.json": (a) => { a[0].rules = ["bambu.does.not-exist"]; } }), /bambu\.does\.not-exist is not a bambu rule/);
  assert.throws(load({ "tuning.json": (a) => { a[0].rules = [loadKbFrom(KB).rules.find((r) => r.domain === "blender").id]; } }), /is not a bambu rule/);
  assert.throws(load({ "tuning.json": (a) => { a[0].topic = "bambu.no.topic"; } }), /topic bambu\.no\.topic does not exist/);
  assert.throws(load({ "tuning.json": (a) => { a[0].when = { all: [{ fact: "blender.mesh_ok", op: "eq", value: "1" }] }; } }), /must not depend on Blender/);
  assert.throws(load({ "tuning.json": (a) => { a[0].when = { all: [{ fact: "gcode.never_declared", op: "eq", value: "1" }] }; } }), /gcode\.never_declared is not declared/);
  assert.throws(load({ "tuning.json": (a) => { delete a.find((x) => x.kind === "ladder").steps; } }), /a ladder needs a trigger and steps/);
  assert.throws(load({ "tuning.json": (a) => { const c = a.find((x) => x.kind === "choice"); c.start = 99; } }), /choice start is not a candidate index/);
  assert.throws(load({ "tuning.json": (a) => { a[0].applies_to = { bambu_studio: "not a version" }; } }), /does not parse/);
  assert.throws(load({ "no_action.json": (n) => { n[0].rule = "bambu.no.such-rule"; } }), /no_action: rule bambu\.no\.such-rule does not exist/);
  assert.throws(load({ "tuning.json": (a) => { a.splice(0, a.length, 5); } }), /malformed|a definite action/);
  const notJson = copyKb(t);
  fs.writeFileSync(path.join(notJson, "tuning/tuning.json"), "{ nope");
  assert.throws(() => loadTuningFrom(path.join(notJson, "tuning"), loadKbFrom(notJson)), /not valid JSON/);
});

test("a missing tuning folder is an error for the caller, not a crash, and it is not cached; the knowledge base is unaffected", (t) => {
  const previous = process.env.BAMBU_KB_DIR;
  t.after(() => { if (previous === undefined) delete process.env.BAMBU_KB_DIR; else process.env.BAMBU_KB_DIR = previous; });
  const broken = copyKb(t);
  fs.rmSync(path.join(broken, "tuning"), { recursive: true });
  process.env.BAMBU_KB_DIR = broken;
  assert.equal(tuningDir(), path.join(path.resolve(broken), "tuning"));
  assert.throws(() => getTuning(), (e) => e.message.includes("Tuning data unavailable") && e.message.includes(path.join(broken, "tuning")) && /BAMBU_KB_DIR/.test(e.message));
  assert.equal(loadKbFrom(broken).rules.length, 320, "consult_knowledge and preflight_check keep working without the tuning folder");
  process.env.BAMBU_KB_DIR = KB;
  assert.equal(getTuning().actions.length, 141, "fixing the folder works without a restart");
  assert.equal(getTuning(), getTuning(), "loaded once, then cached");
});

// ---------------------------------------------------------------- the build-time validator
function contractErrors(t, edits, checkManifest = false) {
  return errorsOf(copyKb(t, edits), checkManifest).join("\n");
}

test("kb:check rejects each way the tuning data can break the contract", (t) => {
  const ladder = (a) => a.find((x) => x.kind === "ladder");
  const choice = (a) => a.find((x) => x.kind === "choice");
  const definite = (a) => a.find((x) => (x.kind ?? "definite") === "definite");
  const cases = [
    ["duplicate action ids", { "tuning.json": (a) => a.push(structuredClone(a[0])) }, /duplicate action id/],
    ["a rule that does not exist", { "tuning.json": (a) => { a[0].rules = ["bambu.nope.nope"]; } }, /rule bambu\.nope\.nope is not a bambu rule/],
    ["a Blender rule", { "tuning.json": (a) => { a[0].rules = [loadKbFrom(KB).rules.find((r) => r.domain === "blender").id]; } }, /is not a bambu rule/],
    ["a topic that does not exist", { "tuning.json": (a) => { a[0].topic = "bambu.nope.nope"; } }, /topic bambu\.nope\.nope does not exist/],
    ["a bad kind", { "tuning.json": (a) => { a[0].kind = "wizard"; } }, /bad kind wizard/],
    ["a definite action without set", { "tuning.json": (a) => { delete definite(a).set; } }, /set must be a non-empty object/],
    ["a bad mode", { "tuning.json": (a) => { definite(a).mode = "sometimes"; } }, /bad mode sometimes/],
    ["elements on a choice", { "tuning.json": (a) => { choice(a).elements = { index_by: "x", starts_with: "y" }; } }, /no set\/elements/],
    ["a choice start outside the candidates", { "tuning.json": (a) => { choice(a).start = 50; } }, /start must be an index of candidates/],
    ["a choice without evaluated_by", { "tuning.json": (a) => { delete choice(a).evaluated_by; } }, /evaluated_by must be a string array/],
    ["a ladder without steps", { "tuning.json": (a) => { ladder(a).steps = []; } }, /steps must be a non-empty array/],
    ["a ladder without trigger", { "tuning.json": (a) => { delete ladder(a).trigger; } }, /condition must be an object/],
    ["a ladder step with a bad cost", { "tuning.json": (a) => { ladder(a).steps[0].cost = "free"; } }, /bad cost free/],
    ["a ladder without exhausted text", { "tuning.json": (a) => { delete ladder(a).exhausted; } }, /exhausted text missing/],
    ["an only_if over a measured fact", { "tuning.json": (a) => { ladder(a).steps[0].only_if = { all: [{ fact: "gcode.zhop_type_mismatch", op: "eq", value: "1" }] }; } }, /only_if may use settings\.\* only/],
    ["an undeclared fact in when", { "tuning.json": (a) => { definite(a).when = { all: [{ fact: "gcode.never_declared", op: "eq", value: "1" }] }; } }, /gcode\.never_declared .* is not declared/],
    ["an undeclared fact in evaluated_by", { "tuning.json": (a) => { choice(a).evaluated_by = ["mesh.never_declared"]; } }, /mesh\.never_declared .* is not declared/],
    ["a blender fact in when", { "tuning.json": (a) => { definite(a).when = { all: [{ fact: "blender.mesh_ok", op: "eq", value: "1" }] }; } }, /no tuning action may depend on blender\.\* facts/],
    ["a blender fact in a trigger", { "tuning.json": (a) => { ladder(a).trigger = { all: [{ fact: "blender.mesh_ok", op: "eq", value: "1" }] }; } }, /no tuning action may depend on blender\.\* facts/],
    ["a blender fact declared by tuning-facts", { "tuning-facts.json": (f) => { f[0].name = "blender.manifold"; } }, /blender\.\* facts are not allowed in tuning/],
    ["a fact declared twice", { "tuning-facts.json": (f) => { f[0].name = loadKbFrom(KB).facts.find((x) => x.name.startsWith("gcode.")).name; } }, /is already in facts\.json/],
    ["an invalid regex", { "tuning.json": (a) => { definite(a).when = { all: [{ fact: "settings.x", op: "matches", value: "(" }] }; } }, /bad regex/],
    ["an empty any in a condition", { "tuning.json": (a) => { definite(a).when = { all: [{ any: [] }] }; } }, /needs a non-empty array/],
    ["risk high with a weak confidence", { "tuning.json": (a) => { Object.assign(definite(a), { risk: "high", confidence: "relato" }); } }, /risk high needs confidence preset or oficial/],
    ["a version form the two engines read differently", { "tuning.json": (a) => { definite(a).applies_to = { bambu_studio: ">2.8" }; } }, /not a form the engine and the reference agree on/],
    ["a bad priority", { "tuning.json": (a) => { definite(a).priority = 0; } }, /priority must be an integer 1-100/],
    ["a bad src", { "tuning.json": (a) => { definite(a).src = ["guide:abc"]; } }, /src must be/],
    ["a no_action rule that does not exist", { "no_action.json": (n) => { n[0].rule = "bambu.nope.nope"; } }, /rule bambu\.nope\.nope does not exist/],
    ["a no_action reason outside the list", { "no_action.json": (n) => { n[0].reason = "lazy"; } }, /bad reason lazy/],
    ["a duplicate no_action rule", { "no_action.json": (n) => n.push(structuredClone(n[0])) }, /duplicate no_action rule/],
    ["a bambu rule that nothing covers", { "no_action.json": (n) => n.pop() }, /bambu rule .* is neither in an action's rules nor in no_action\.json/],
  ];
  for (const [what, edits, expected] of cases) assert.match(contractErrors(t, edits), expected, what);
});

test("kb:check notices a tuning file that no longer matches the manifest, or a missing tuning folder", (t) => {
  assert.match(contractErrors(t, { "tuning.json": (a) => { a[0].title += "!"; } }, true), /sha256 of tuning\/tuning\.json differs; run npm run kb:build/);
  const dir = copyKb(t);
  fs.rmSync(path.join(dir, "tuning"), { recursive: true });
  assert.match(errorsOf(dir).join("\n"), /tuning: unreadable/);
});

test("kb:check validates the tuning eval fixture against the actions", (t) => {
  const dir = scratch(t);
  const ev = readJson(TUNING_EVAL);
  ev.scenarios[0].expect_applied = ["tune.no.such-action"];
  ev.sequences[0].rounds[0].facts = { "blender.thing": 1 };
  const file = path.join(dir, "eval.json");
  fs.writeFileSync(file, JSON.stringify(ev));
  const errors = validateKnowledge(KB, path.join(ROOT, "tests/fixtures/knowledge/eval.json"), { checkManifest: false, tuningEvalFile: file }).errors.join("\n");
  assert.match(errors, /unknown action tune\.no\.such-action/);
  assert.match(errors, /bad fact name blender\.thing/);
});
