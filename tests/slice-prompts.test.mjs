import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import JSZip from "jszip";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failure = "Required Bambu machine profile is missing nozzle_volume_type; select a matching machine and filament profile.";
const MODEL_XML = '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';

// A real server process whose slicer boundary is mocked: nothing here starts Bambu Studio.
async function start(t, { sliceSucceeds = false, realSlice = false, elicitDelayMs = 0, elicitation = true, env = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-slice-prompts-"));
  const log = path.join(directory, "calls.jsonl");
  const elicitLog = path.join(directory, "elicitations.jsonl");
  const profile = path.join(directory, "process.json");
  fs.writeFileSync(profile, "{}");
  const profilesRoot = path.join(directory, "profiles");
  fs.mkdirSync(path.join(profilesRoot, "BBL", "machine"), { recursive: true });
  const executable = path.join(directory, "slicer");
  fs.writeFileSync(executable, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({action: 'cli'}) + '\\n');\n`, { mode: 0o755 });
  const makeProject = async (name) => {
    const zip = new JSZip();
    zip.file("3D/3dmodel.model", MODEL_XML);
    const file = path.join(directory, name);
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
    return file;
  };
  const slicedOutput = path.join(directory, "sliced.gcode.3mf");
  fs.writeFileSync(slicedOutput, await (async () => {
    const zip = new JSZip();
    zip.file("3D/3dmodel.model", MODEL_XML);
    zip.file("Metadata/plate_1.gcode", "; printer_model = p1s\nG1 X0 Y0\n");
    zip.file("Metadata/slice_info.config", '<?xml version="1.0"?><config><plate><metadata key="index" value="1"/><metadata key="prediction" value="60"/><metadata key="weight" value="1"/></plate></config>');
    return zip.generateAsync({ type: "nodebuffer" });
  })());
  const preload = path.join(directory, "boundaries.mjs");
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import { STLManipulator } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/stl/stl-manipulator.js")).href)};
import { Server } from ${JSON.stringify(pathToFileURL(path.join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js")).href)};
const log = (event) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + '\\n');
const elicitInput = Server.prototype.elicitInput;
Server.prototype.elicitInput = function (params, options) {
  fs.appendFileSync(${JSON.stringify(elicitLog)}, JSON.stringify({ timeout: options?.timeout }) + '\\n');
  return elicitInput.call(this, params, options);
};
${realSlice ? "" : `STLManipulator.prototype.sliceSTL = async function (file, _type, _path, _profile, _progress, _preset, options) {
  log({ action: 'slice', file, ...(options?.nozzleType ? { nozzleType: options.nozzleType } : {}) });
  ${sliceSucceeds ? `return ${JSON.stringify(slicedOutput)};` : `throw new Error(${JSON.stringify(failure)});`}
};`}
`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", pathToFileURL(preload).href, path.join(root, "dist/index.js")],
    cwd: directory,
    env: {
      ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s",
      BAMBU_TEMPLATE_3MF: "", BAMBU_TEMPLATE_3MF_PATH: "", BAMBU_SLICER_PROFILE: "", BAMBU_SLICER_TYPE: "bambustudio",
      SLICER_TYPE: "bambustudio", SLICER_PATH: executable, BAMBU_PROFILES_ROOT: profilesRoot, BAMBU_SLICER_PROFILE_DIRS: "",
      BAMBU_CONFIRMATION_TIMEOUT_MS: "", ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "slice-prompt-tests", version: "1" }, { capabilities: elicitation ? { elicitation: { form: {} } } : {} });
  if (elicitation) client.setRequestHandler(ElicitRequestSchema, async () => {
    // A person may take a while to answer.
    await new Promise((resolve) => setTimeout(resolve, elicitDelayMs));
    return { action: "accept", content: { bambu_model: "p1s" } };
  });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  return {
    makeProject,
    events: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [],
    elicitations: () => fs.existsSync(elicitLog) ? fs.readFileSync(elicitLog, "utf8").trim().split("\n").map(JSON.parse) : [],
    slice: (file, extra = {}) => client.callTool({ name: "slice_stl", arguments: { stl_path: file, bambu_model: "p1s", slicer_profile: profile, bed_type: "textured_plate", ...extra } }),
    sliceWithoutModel: (file) => client.callTool({ name: "slice_stl", arguments: { stl_path: file, slicer_profile: profile, bed_type: "textured_plate" } }),
  };
}

test("bambustudio real profile gate stops MCP slicing before any slicer process starts", async t => {
  const server = await start(t, { realSlice: true });
  const result = await server.slice(await server.makeProject("missing-machine.3mf"));
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text || "", /Printer profile.*Bambu Lab P1S 0\.4 nozzle.*not found/);
  assert.deepEqual(server.events(), [], "a missing machine profile must stop the CLI launch");
});

test("slice_stl preserves the slicer's error", async (t) => {
  const server = await start(t);
  const project = await server.makeProject("unsliced.3mf");
  const result = await server.slice(project);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.message, failure);
  assert.deepEqual(server.events(), [{ action: "slice", file: project }]);
});

test("slice_stl slices for the installed nozzle type", async (t) => {
  const server = await start(t, { sliceSucceeds: true });
  const project = await server.makeProject("unsliced.3mf");
  const result = await server.slice(project, { nozzle_type: "hardened_steel" });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(server.events()[0], { action: "slice", file: project, nozzleType: "hardened_steel" });
});

test("the printer-model prompt waits ten minutes by default instead of the SDK's 60 seconds", async (t) => {
  const server = await start(t, { sliceSucceeds: true, elicitDelayMs: 500, env: { BAMBU_MODEL: "" } });
  const result = await server.sliceWithoutModel(await server.makeProject("unsliced.3mf"));
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.ok(server.elicitations().length > 0, "a missing model must be asked for");
  assert.deepEqual([...new Set(server.elicitations().map((call) => call.timeout))], [600000]);
  assert.equal(server.events().filter((event) => event.action === "slice").length, 1);
});

for (const invalid of ["3000000000", "999", "3600001", "10.5", "soon"]) {
  test(`an out-of-range prompt timeout (${invalid}) falls back to ten minutes`, async (t) => {
    // Node clamps timer delays above 2^31-1 ms to 1 ms, which would time out every prompt at once.
    const server = await start(t, { sliceSucceeds: true, elicitDelayMs: 200, env: { BAMBU_MODEL: "", BAMBU_CONFIRMATION_TIMEOUT_MS: invalid } });
    const result = await server.sliceWithoutModel(await server.makeProject("unsliced.3mf"));
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    assert.deepEqual([...new Set(server.elicitations().map((call) => call.timeout))], [600000]);
  });
}

test("a late answer within the configured timeout still slices", async (t) => {
  const server = await start(t, { sliceSucceeds: true, elicitDelayMs: 1000, env: { BAMBU_MODEL: "", BAMBU_CONFIRMATION_TIMEOUT_MS: "5000" } });
  const result = await server.sliceWithoutModel(await server.makeProject("unsliced.3mf"));
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual([...new Set(server.elicitations().map((call) => call.timeout))], [5000]);
  assert.equal(server.events().filter((event) => event.action === "slice").length, 1);
});

test("an unanswered printer-model prompt is reported as a timeout", async (t) => {
  const server = await start(t, { elicitDelayMs: 2500, env: { BAMBU_MODEL: "", BAMBU_CONFIRMATION_TIMEOUT_MS: "1000" } });
  const result = await server.sliceWithoutModel(await server.makeProject("unsliced.3mf"));
  assert.equal(result.isError, true);
  const message = JSON.stringify(result.content);
  assert.match(message, /No printer model was selected within 1 second\(s\); nothing was sliced/);
  assert.doesNotMatch(message, /does not support elicitation/);
  assert.deepEqual(server.events(), [], "no slice without a model");
});

test("a client without elicitation is told to configure the printer model", async (t) => {
  const server = await start(t, { elicitation: false, env: { BAMBU_MODEL: "" } });
  const result = await server.sliceWithoutModel(await server.makeProject("unsliced.3mf"));
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /does not support elicitation.*BAMBU_MODEL/);
  assert.deepEqual(server.events(), []);
});
