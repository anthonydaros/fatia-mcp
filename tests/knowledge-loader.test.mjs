import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { approvalFor, getKb, loadKbFrom } from "../dist/knowledge/loader.js";
import { validateKnowledge } from "../scripts/validate-knowledge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KB = path.join(ROOT, "knowledge");
const SERVER = path.join(ROOT, "dist", "index.js");

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A copy of knowledge/ in a scratch folder, optionally with one JSON file rewritten. */
function copyKb(t, edits = {}) {
  const dir = path.join(scratch(t), "kb folder");
  fs.cpSync(KB, dir, { recursive: true });
  for (const [name, edit] of Object.entries(edits)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, edit(fs.readFileSync(file, "utf8")));
  }
  return dir;
}

const editRules = (mutate) => (text) => JSON.stringify((() => { const rules = JSON.parse(text); mutate(rules); return rules; })(), null, 2);

test("the shipped base loads, indexes and matches its manifest", () => {
  const kb = loadKbFrom(KB);
  const manifest = JSON.parse(fs.readFileSync(path.join(KB, "manifest.json"), "utf8"));
  assert.equal(kb.integrity, "ok");
  assert.equal(kb.version, manifest.kb_version);
  assert.equal(kb.topics.length, manifest.counts.topics);
  assert.equal(kb.rules.length, manifest.counts.rules);
  assert.equal(kb.facts.length, manifest.counts.facts);
  assert.equal(kb.topicById.size, kb.topics.length);
  assert.equal([...kb.rulesByTopic.values()].reduce((n, rules) => n + rules.length, 0), kb.rules.length);
  assert.ok(kb.synonyms.length >= 50);
  assert.doesNotMatch(JSON.stringify(manifest), /\/Users\/|[A-Z]:\\|\.\.\//, "the manifest holds no absolute path");
});

test("a BOM and Windows line endings do not change what loads or the integrity check", (t) => {
  const crlf = (text) => `\uFEFF${text.replace(/\r?\n/g, "\r\n")}`;
  const dir = copyKb(t, { "rules.json": crlf, "synonyms.json": crlf, "manifest.json": crlf });
  const kb = loadKbFrom(dir);
  assert.equal(kb.rules.length, 320);
  assert.equal(kb.integrity, "ok");
});

test("the build-time validator refuses auto_apply on a Blender-domain rule, whatever its stage", (t) => {
  const dir = copyKb(t, { "rules.json": editRules((rules) => {
    const rule = rules.find((r) => r.domain === "blender" && r.stage !== "blender-prep");
    assert.ok(rule, "the base has a Blender-domain rule outside the blender-prep stage");
    Object.assign(rule, { auto_apply: true, confidence: "preset", solution: { settings: { z_hop: "0.4" }, steps: [], message: "m" } });
  }) });
  assert.match(validateKnowledge(dir, undefined, { checkManifest: false }).errors.join("\n"), /auto_apply not allowed for Blender steps/);
});

test("no invisible U+FEFF is typed into the knowledge code or its tests (write the escape \\uFEFF)", () => {
  for (const file of ["scripts/validate-knowledge.mjs", "tests/knowledge-loader.test.mjs", "src/knowledge/facts/settings.ts"]) {
    const full = path.join(ROOT, file);
    if (fs.existsSync(full)) assert.ok(!fs.readFileSync(full, "utf8").includes("\uFEFF"), `${file} holds a literal U+FEFF`);
  }
});

test("an edited file, or a missing manifest, is a warning (integrity mismatch), not an error", (t) => {
  const edited = loadKbFrom(copyKb(t, { "rules.json": editRules((rules) => { rules[0].title += " (edited)"; }) }));
  assert.equal(edited.integrity, "mismatch");
  assert.ok(edited.rules[0].title.endsWith("(edited)"));

  const dir = copyKb(t);
  fs.rmSync(path.join(dir, "manifest.json"));
  const bare = loadKbFrom(dir);
  assert.equal(bare.integrity, "mismatch");
  assert.equal(bare.version, "unknown");
});

test("a missing folder or a corrupt file is an error naming the path", (t) => {
  const missing = path.join(scratch(t), "nowhere");
  assert.throws(() => loadKbFrom(missing), (error) => error.message.includes(missing) && /BAMBU_KB_DIR/.test(error.message));
  assert.throws(() => loadKbFrom(copyKb(t, { "facts.json": () => "{ not json" })), /facts\.json .*not valid JSON/);
});

test("load-time validation rejects rules nobody can evaluate", (t) => {
  const cases = {
    "duplicate rule id": [(rules) => { rules[1].id = rules[0].id; }, /duplicate rule id/],
    "unknown topic": [(rules) => { rules[0].topic = "bambu.nope.nothing"; }, /topic bambu\.nope\.nothing does not exist/],
    "bad op": [(rules) => { rules.find((r) => r.detect.when).detect.when = { fact: "settings.x", op: "approx", value: "1" }; }, /bad op approx/],
    "in without an array": [(rules) => { rules.find((r) => r.detect.when).detect.when = { fact: "settings.x", op: "in", value: "a" }; }, /op in needs an array/],
    "unparseable applies_to": [(rules) => { rules[0].applies_to = { bambu_studio: "soon" }; }, /applies_to\.bambu_studio "soon" does not parse/],
    "undeclared fact": [(rules) => { rules[0].detect.facts = ["mesh.never_declared"]; }, /fact mesh\.never_declared is not declared/],
  };
  for (const [name, [mutate, expected]] of Object.entries(cases)) {
    assert.throws(() => loadKbFrom(copyKb(t, { "rules.json": editRules(mutate) })), expected, name);
  }
});

test("getKb follows BAMBU_KB_DIR, does not cache a failure, and loads late", (t) => {
  const previous = process.env.BAMBU_KB_DIR;
  t.after(() => { if (previous === undefined) delete process.env.BAMBU_KB_DIR; else process.env.BAMBU_KB_DIR = previous; });
  delete process.env.BAMBU_KB_DIR;
  assert.equal(getKb().dir, KB, "default: knowledge/ next to dist/");
  const missing = path.join(scratch(t), "nowhere");
  process.env.BAMBU_KB_DIR = missing;
  assert.throws(() => getKb(), /cannot read/);
  const fixed = copyKb(t);
  process.env.BAMBU_KB_DIR = fixed;
  assert.equal(getKb().dir, fixed);
});

test("approval is computed in code: only a definite setting with a strong source and no Blender stage is auto_apply", () => {
  const rule = { auto_apply: true, confidence: "preset", stage: "project-settings", solution: { settings: { z_hop: "0.4" }, steps: [], message: "m" } };
  assert.equal(approvalFor(rule), "auto_apply");
  assert.equal(approvalFor({ ...rule, confidence: "oficial" }), "auto_apply");
  assert.equal(approvalFor({ ...rule, confidence: "relato" }), "needs_user_approval");
  assert.equal(approvalFor({ ...rule, confidence: "hipotese" }), "needs_user_approval");
  assert.equal(approvalFor({ ...rule, auto_apply: false }), "needs_user_approval");
  assert.equal(approvalFor({ ...rule, stage: "blender-prep" }), "needs_user_approval");
  assert.equal(approvalFor({ ...rule, domain: "blender" }), "needs_user_approval", "a Blender-domain rule is never auto_apply, whatever its stage");
  assert.equal(approvalFor({ ...rule, solution: { settings: null, steps: ["x"], message: "m" } }), "needs_user_approval");
  assert.equal(approvalFor({ ...rule, solution: { settings: {}, steps: ["x"], message: "m" } }), "needs_user_approval");
  assert.equal(loadKbFrom(KB).rules.filter((r) => approvalFor(r) === "auto_apply").length, 0, "no rule of the shipped base is auto_apply");
});

async function withServer(t, kbDir, run) {
  const cwd = scratch(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd,
    env: {
      PATH: process.env.PATH || "", MCP_TRANSPORT: "stdio", PRINTER_HOST: "127.0.0.1", BAMBU_MODEL: "x2d", BAMBU_SERIAL: "", BAMBU_TOKEN: "",
      TEMP_DIR: path.join(cwd, "temp"), SLICER_STATE_FILE: path.join(cwd, "slicers.json"),
      BAMBU_STUDIO_PATH: path.join(cwd, "no-studio"), // never installed: the Studio version is unknown
      BAMBU_CLIENT_CERT: path.join(cwd, "no-cert"), BAMBU_CLIENT_KEY: path.join(cwd, "no-key"),
      ...(kbDir ? { BAMBU_KB_DIR: kbDir } : {}),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "knowledge-test", version: "1.0.0" });
  await client.connect(transport);
  try { return await run(client); } finally { await client.close(); }
}
const json = (result) => JSON.parse(result.content[0].text);

test("through the server: consult_knowledge is read-only, instructions name only existing tools, answers and no_match", async (t) => {
  await withServer(t, undefined, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((x) => x.name === "consult_knowledge");
    assert.ok(tool, "consult_knowledge is registered");
    assert.equal(tool.annotations.readOnlyHint, true);

    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /consult_knowledge/);
    for (const name of instructions.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g)) {
      assert.ok(tools.some((x) => x.name === name), `instructions mention ${name}, which is not a tool`);
    }

    const zhop = json(await client.callTool({ name: "consult_knowledge", arguments: { query: "z hop" } }));
    assert.equal(zhop.kb.integrity, "ok");
    assert.equal(zhop.untrusted_reference, true);
    assert.equal(zhop.no_match, false);
    assert.equal(zhop.results[0].id, "bambu.travel.zhop-types");
    assert.equal(zhop.results[0].version_status, "aplica", "no version limit");
    assert.ok(zhop.results[0].excerpt && !("body" in zhop.results[0]));

    const nothing = json(await client.callTool({ name: "consult_knowledge", arguments: { query: "asdkjh qwlkj zxcmnb" } }));
    assert.equal(nothing.no_match, true);
    assert.deepEqual(nothing.results, []);
    assert.match(nothing.hint, /Rephrase/);

    const limited = json(await client.callTool({ name: "consult_knowledge", arguments: { id: "bambu.travel.factory-values" } }));
    assert.equal(limited.results[0].version_status, "desconhecida", "this topic has a Studio limit and no Studio is installed here");
    assert.ok(limited.results[0].body);

    const byRule = json(await client.callTool({ name: "consult_knowledge", arguments: { id: "bambu.travel.unprotected-travel" } }));
    assert.equal(byRule.results[0].kind, "rule");
    assert.ok(byRule.results[0].detect.when_text);
    assert.equal(byRule.results[0].approval, "needs_user_approval");
    assert.equal(byRule.results[1].id, byRule.results[0].topic);
    assert.ok(byRule.results[1].body, "an id lookup returns the topic in full");

    const unknownId = json(await client.callTool({ name: "consult_knowledge", arguments: { id: "bambu.no.such-thing" } }));
    assert.equal(unknownId.no_match, true);

    const bad = await client.callTool({ name: "consult_knowledge", arguments: {} });
    assert.equal(bad.isError, true);
    const badLimit = await client.callTool({ name: "consult_knowledge", arguments: { query: "z hop", limit: 99 } });
    assert.equal(badLimit.isError, true);
  });
});

test("through the server: a missing knowledge folder is a tool error and the server stays up", async (t) => {
  const missing = path.join(scratch(t), "no knowledge here");
  await withServer(t, missing, async (client) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await client.callTool({ name: "consult_knowledge", arguments: { query: "z hop" } });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes(missing), "the error names the folder it tried");
    }
    assert.ok((await client.listTools()).tools.some((x) => x.name === "slicer_info"), "other tools still answer");
    const info = await client.callTool({ name: "slicer_info", arguments: { check_updates: false } });
    assert.equal(info.isError, undefined);
  });
});
