import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadKbFrom } from "../dist/knowledge/loader.js";
import { appliesTo, matchVersion, parseVersionPredicate } from "../dist/knowledge/version.js";

const KB_DIR = fileURLToPath(new URL("../knowledge/", import.meta.url));

test("every applies_to of the shipped knowledge base parses", () => {
  const kb = loadKbFrom(KB_DIR);
  const forms = new Set();
  for (const item of [...kb.topics, ...kb.rules]) {
    for (const [key, predicate] of Object.entries(item.applies_to ?? {})) {
      assert.ok(["bambu_studio", "blender"].includes(key), `${item.id}: unknown applies_to key ${key}`);
      assert.ok(parseVersionPredicate(predicate), `${item.id}: "${predicate}" does not parse`);
      forms.add(predicate);
    }
  }
  assert.ok(forms.size >= 16, `expected the 16+ distinct forms of the base, got ${forms.size}`);
});

test("predicate forms against an installed version", () => {
  const cases = [
    // [predicate, installed, expected]
    ["<2.8.2", "02.08.04.57", "not_applies"],
    ["<2.8.2", "2.8.1.9", "applies"],
    ["<2.8.2", "2.8.2.61", "not_applies"],
    ["<2.7.0", "2.6.9.9", "applies"],
    ["<2.8.0", "2.8.0.0", "not_applies"],
    ["<2.8.4.57", "02.08.04.57", "not_applies"],
    ["<2.8.4.57", "2.8.4.56", "applies"],
    [">=2.8", "02.08.04.57", "applies"],
    [">=2.8", "2.7.9.99", "not_applies"],
    [">=2.8", "3.0", "applies"],
    [">=2.8.2", "2.8.2.61", "applies"],
    [">=2.8.4.57", "2.8.4.57", "applies"],
    [">=2.8.4.57", "2.8.4.56", "not_applies"],
    [">=2.0", "2.1.0.50", "applies"],
    [">=4.2", "4.5.1", "applies"],
    [">=5.0", "4.5.1", "not_applies"],
    ["2.8.x", "2.8.4.57", "applies"],
    ["2.8.x", "02.08.00.1", "applies"],
    ["2.8.x", "2.9.0.1", "not_applies"],
    ["2.8.4.57", "02.08.04.57", "applies"],
    ["02.08.04.57", "v2.8.4.57", "applies"],
    ["2.8.4.57", "2.8.4.58", "not_applies"],
    ["2.1.0.50", "2.1.0.50", "applies"],
    ["2.7.1, 2.8.2.61", "2.7.1.5", "applies"],
    ["2.7.1, 2.8.2.61", "2.8.2.61", "applies"],
    ["2.7.1, 2.8.2.61", "2.8.3.1", "not_applies"],
    ["=2.8", "2.8.0.0", "applies"],
    ["=2.8", "2.8.4.57", "not_applies"],
    ["<=2.8.2", "2.8.2.0", "applies"],
    [">2.8.2", "2.8.2.0", "not_applies"],
  ];
  for (const [predicate, installed, expected] of cases) {
    assert.equal(matchVersion(predicate, installed), expected, `${predicate} vs ${installed}`);
  }
});

test("unknown when the version or the predicate cannot be read", () => {
  assert.equal(matchVersion(">=2.8", null), "unknown");
  assert.equal(matchVersion(">=2.8", undefined), "unknown");
  assert.equal(matchVersion(">=2.8", ""), "unknown");
  assert.equal(matchVersion(">=2.8", "nightly"), "unknown");
  assert.equal(matchVersion(">=2.8", "2.8.4-beta"), "unknown");
  for (const bad of ["latest", "", "<>2", ">=", "2..8", "2.8.4.57.1", ">=2.x", "2.8.y", "2.8, "]) {
    assert.equal(parseVersionPredicate(bad), null, JSON.stringify(bad));
    assert.equal(matchVersion(bad, "2.8.4.57"), "unknown", JSON.stringify(bad));
  }
});

test("appliesTo needs every key to hold; one that cannot be judged keeps the verdict open", () => {
  const studio = "02.08.04.57";
  assert.equal(appliesTo(null, {}), "applies");
  assert.equal(appliesTo({ bambu_studio: ">=2.8" }, { bambu_studio: studio }), "applies");
  assert.equal(appliesTo({ bambu_studio: "<2.8" }, { bambu_studio: studio }), "not_applies");
  assert.equal(appliesTo({ bambu_studio: ">=2.8" }, { bambu_studio: null }), "unknown");
  assert.equal(appliesTo({ blender: ">=4.2" }, { bambu_studio: studio }), "unknown", "Blender version not provided");
  assert.equal(appliesTo({ bambu_studio: "<2.8", blender: ">=4.2" }, { bambu_studio: studio }), "not_applies", "one failure decides");
  assert.equal(appliesTo({ bambu_studio: ">=2.8", blender: ">=4.2" }, { bambu_studio: studio }), "unknown");
});
