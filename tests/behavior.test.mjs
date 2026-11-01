import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import JSZip from "jszip";
import { analyze3MFPlateObjects } from "../dist/3mf_parser.js";
import { STLManipulator } from "../dist/stl/stl-manipulator.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const SAMPLE_STL = path.join(REPO_ROOT, "test", "sample_cube.stl");
const EXPECTED_BAMBU_MODELS = ["p1s", "p1p", "p2s", "x1c", "x1e", "a1", "a1mini", "h2d", "h2dpro", "h2s", "h2c", "x2d"];

function createClient() {
  return new Client({
    name: "bambu-printer-mcp-behavior-tests",
    version: "0.0.1",
  });
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close(() => reject(new Error("Unable to resolve free port")));
        return;
      }
      server.close((error) => {
        if (error) { reject(error); return; }
        resolve(address.port);
      });
    });
  });
}

async function waitForHttpServerReady(endpoint, attempts = 40, delayMs = 150) {
  let lastStatus = "unreachable";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, { method: "PUT" });
      lastStatus = String(response.status);
      if (response.status === 405 || response.status === 400) return;
    } catch {
      lastStatus = "unreachable";
    }
    await sleep(delayMs);
  }
  throw new Error(`HTTP server did not become ready in time (last status: ${lastStatus})`);
}

async function closeTransport(transport) {
  try { await transport.close(); } catch { }
}

async function terminateChildProcess(childProcess) {
  if (childProcess.exitCode !== null) return;
  childProcess.kill("SIGTERM");
  await Promise.race([
    once(childProcess, "exit"),
    sleep(2000).then(() => { if (childProcess.exitCode === null) childProcess.kill("SIGKILL"); }),
  ]);
}

function parseJsonResult(toolResult) {
  const text = toolResult.content?.[0]?.text;
  assert.equal(typeof text, "string", "Expected text result payload");
  return JSON.parse(text);
}

function assertCommonToolPresence(listToolsResult) {
  const names = listToolsResult.tools.map((tool) => tool.name);
  for (const name of ["list_3mf_plate_objects", "get_stl_info", "blender_mcp_edit_model", "slice_stl", "slicer_info", "prepare_print_project"]) {
    assert.ok(names.includes(name), `${name} tool must be registered`);
  }
  for (const removed of ["print_3mf", "get_printer_status", "upload_file", "start_print", "bambu_connect_import_file"]) {
    assert.ok(!names.includes(removed), `${removed} was removed: this server never contacts a printer`);
  }
}

function assertBambuStudioSlicerSupport(listToolsResult) {
  const sliceTool = listToolsResult.tools.find((t) => t.name === "slice_stl");
  assert.ok(sliceTool, "slice_stl tool must exist");
  const desc = sliceTool.inputSchema?.properties?.slicer_type?.description || "";
  assert.ok(
    desc.includes("bambustudio"),
    `slice_stl slicer_type description must mention bambustudio, got: ${desc}`
  );
}

// Canonical schema contracts for BambuStudio slicer options on slice_stl.
// Each entry: [property_name, expected_json_type, description_must_contain]
// Description fragments should be domain-stable keywords, not exact phrasing.
const BAMBU_SLICER_OPTION_CONTRACTS = [
  ["uptodate",              "boolean", "preset"],
  ["repetitions",           "number",  "copies"],
  ["orient",                "boolean", "orient"],
  ["arrange",               "boolean", "arrange"],
  ["ensure_on_bed",         "boolean", "bed"],
  ["clone_objects",         "string",  "clone"],
  ["skip_objects",          "string",  "skip"],
  ["load_filaments",        "string",  "filament"],
  ["load_filament_ids",     "string",  "filament"],
  ["bed_type",              "string",  "bed"],
  ["enable_timelapse",      "boolean", "timelapse"],
  ["allow_mix_temp",        "boolean", "temperature"],
  ["scale",                 "number",  "scale"],
  ["rotate",                "number",  "z-axis"],
  ["rotate_x",              "number",  "x-axis"],
  ["rotate_y",              "number",  "y-axis"],
  ["min_save",              "boolean", "smaller"],
  ["skip_modified_gcodes",  "boolean", "gcode"],
  ["slice_plate",           "number",  "plate"],
];

test("slicing model safety: schema requires bambu_model, rejects missing/invalid models", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "", // Explicitly empty to override dotenv .env file
      SLICER_PATH: "/nonexistent/slicer", // A valid model must never reach a real slicer here.
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const listToolsResult = await client.listTools();
  assertBambuStudioSlicerSupport(listToolsResult);

  const toolsWithModel = listToolsResult.tools
    .filter((tool) => Array.isArray(tool.inputSchema?.properties?.bambu_model?.enum))
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(
    toolsWithModel,
    ["slice_stl", "slice_with_template"],
    "all tools that expose bambu_model must be covered by the model enum invariant"
  );
  for (const toolName of toolsWithModel) {
    const tool = listToolsResult.tools.find((t) => t.name === toolName);
    assert.deepEqual(
      tool.inputSchema.properties.bambu_model.enum,
      EXPECTED_BAMBU_MODELS,
      `${toolName} bambu_model must enumerate all valid models`
    );
    assert.ok(tool.inputSchema.required.includes("bambu_model"), `${toolName} must list bambu_model as required`);
  }
  // No 'type' param should exist on any tool (Bambu-only)
  for (const tool of listToolsResult.tools) {
    assert.ok(
      !tool.inputSchema?.properties?.type,
      `Tool ${tool.name} should not have a 'type' property (Bambu-only server)`
    );
  }

  // --- Runtime validation: slice_stl without bambu_model must error ---
  // The server will attempt elicitation, which fails in test (no client support),
  // then falls back to a clear error about bambu_model being required.
  const noModelResult = await client.callTool({
    name: "slice_stl",
    arguments: { stl_path: "/tmp/nonexistent_test.stl" },
  });
  assert.equal(noModelResult.isError, true, "slice_stl without bambu_model must error");
  const noModelError = noModelResult.content?.[0]?.text || "";
  assert.ok(
    noModelError.toLowerCase().includes("bambu_model") || noModelError.toLowerCase().includes("model"),
    `Error must mention model is required, got: ${noModelError}`
  );

  // --- Runtime validation: slice_stl with invalid model must error ---
  const badModelResult = await client.callTool({
    name: "slice_stl",
    arguments: { stl_path: "/tmp/nonexistent_test.stl", bambu_model: "ender3" },
  });
  assert.equal(badModelResult.isError, true, "slice_stl with invalid model must error");
  const badModelError = badModelResult.content?.[0]?.text || "";
  assert.ok(
    badModelError.includes("Invalid bambu_model"),
    `Error must reject invalid model, got: ${badModelError}`
  );

  // --- Runtime validation: every valid model, including H2C, passes model validation ---
  for (const bambuModel of EXPECTED_BAMBU_MODELS) {
    const validModelResult = await client.callTool({
      name: "slice_stl",
      arguments: { stl_path: "/tmp/nonexistent_test.stl", bambu_model: bambuModel },
    });
    assert.equal(validModelResult.isError, true, "Missing slicer should still error");
    const validModelError = validModelResult.content?.[0]?.text || "";
    assert.ok(
      !validModelError.includes("bambu_model"),
      `Error with valid model ${bambuModel} should not be about model, got: ${validModelError}`
    );
  }
});

test("3MF plate object analysis lists Bambu object ids for slice_stl skip_objects", async () => {
  const fixture = path.join(REPO_ROOT, "tests/fixtures/h2d_gui_sliced");
  const zip = new JSZip();
  zip.file("Metadata/plate_1.json", fs.readFileSync(path.join(fixture, "plate_1.json"), "utf8"));
  zip.file("Metadata/slice_info.config", fs.readFileSync(path.join(fixture, "slice_info.config"), "utf8"));
  const tempPath = path.join(os.tmpdir(), `plate-objects-${Date.now()}.3mf`);
  fs.writeFileSync(tempPath, await zip.generateAsync({ type: "nodebuffer" }));

  try {
    const plateObjects = await analyze3MFPlateObjects(tempPath, 0);
    assert.equal(plateObjects.objects.length, 20);
    assert.deepEqual(
      plateObjects.objects.slice(0, 2).map((object) => object.id),
      [5997, 6277]
    );
    assert.equal(plateObjects.objects[0].name, "mk2 collarID.stl_1");
    assert.equal(plateObjects.objects[0].area, 1152.0546875);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
});

test("3MF plate object analysis falls back to bbox ids without slice_info object ids", async () => {
  const fixture = path.join(REPO_ROOT, "tests/fixtures/h2d_gui_sliced");
  const zip = new JSZip();
  zip.file("Metadata/plate_1.json", fs.readFileSync(path.join(fixture, "plate_1.json"), "utf8"));
  const tempPath = path.join(os.tmpdir(), `plate-objects-bbox-${Date.now()}.3mf`);
  fs.writeFileSync(tempPath, await zip.generateAsync({ type: "nodebuffer" }));

  try {
    const plateObjects = await analyze3MFPlateObjects(tempPath, 0);
    assert.deepEqual(
      plateObjects.objects.slice(0, 2).map((object) => object.id),
      [6495, 6496]
    );
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
});

test("slicing model safety: BAMBU_MODEL env var accepted as default", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      SLICER_PATH: "/nonexistent/slicer",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  // With BAMBU_MODEL=p1s set in env, slice_stl should NOT error about missing model
  // (it will error about the missing slicer instead)
  const result = await client.callTool({
    name: "slice_stl",
    arguments: { stl_path: "/tmp/nonexistent_test.stl" },
  });
  assert.equal(result.isError, true);
  const errorText = result.content?.[0]?.text || "";
  assert.ok(
    !errorText.includes("bambu_model") && !errorText.includes("BAMBU_MODEL"),
    `With BAMBU_MODEL env set, error should not be about the model, got: ${errorText}`
  );
});

test("sliceSTL allows slicer executables resolved from PATH", async (t) => {
  if (process.platform === "win32") {
    t.skip("PATH executable resolution test uses a POSIX executable shim");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "path-slicer-"));
  const binDir = path.join(tempRoot, "bin");
  const commandName = `fake-prusaslicer-${process.pid}-${Date.now()}`;
  const commandPath = path.join(binDir, commandName);
  const originalPath = process.env.PATH || "";
  t.after(() => {
    process.env.PATH = originalPath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    commandPath,
    [
      "#!/bin/sh",
      "while [ \"$#\" -gt 0 ]; do",
      "  if [ \"$1\" = \"--output\" ]; then",
      "    shift",
      "    printf 'G1 X0\\n' > \"$1\"",
      "    exit 0",
      "  fi",
      "  shift",
      "done",
      "exit 2",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

  const manipulator = new STLManipulator(tempRoot);
  const outputPath = await manipulator.sliceSTL(SAMPLE_STL, "prusaslicer", commandName);

  assert.equal(outputPath, path.join(tempRoot, "sample_cube.gcode"));
  assert.equal(fs.readFileSync(outputPath, "utf8"), "G1 X0\n");
});

test("sliceSTL names a slicer crash signal or exit code and keeps the end of its output", { skip: process.platform === "win32" }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crashing-slicer-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const slicer = (name, body) => {
    const file = path.join(tempRoot, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const manipulator = new STLManipulator(tempRoot);
  // A crashing slicer can print nothing to stderr.
  await assert.rejects(manipulator.sliceSTL(SAMPLE_STL, "prusaslicer", slicer("segfaulting-slicer", 'echo "loading model"\nkill -SEGV $$')),
    error => {
      assert.match(error.message, /Slicer failed: the slicer crashed with SIGSEGV\./);
      assert.match(error.message, /Slicer output: loading model$/);
      return true;
    });
  await assert.rejects(manipulator.sliceSTL(SAMPLE_STL, "prusaslicer", slicer("refusing-slicer", 'echo "Some objects are located over the boundary of the heated bed." >&2\nexit 206')),
    error => {
      assert.match(error.message, /Slicer failed: the slicer exited with code 206\./);
      assert.equal(error.message.split("located over the boundary of the heated bed").length, 2, "stderr appears once");
      return true;
    });
});

async function writeTemplate3mfFixture(
  templateDir,
  baseName = "template-process",
  processName = "Template Process",
  layerHeight = "0.16"
) {
  const zip = new JSZip();
  zip.file("Metadata/project_settings.config", JSON.stringify({
    type: "process",
    name: processName,
    from: "project",
    layer_height: layerHeight,
  }));
  zip.file(
    "3D/3dmodel.model",
    '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model" name="template.stl"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>'
  );
  const templatePath = path.join(templateDir, `${baseName}.3mf`);
  fs.writeFileSync(templatePath, await zip.generateAsync({ type: "nodebuffer" }));
  return templatePath;
}

function writeTemplateJsonFixture(
  templateDir,
  baseName,
  processName,
  layerHeight = "0.12"
) {
  const templatePath = path.join(templateDir, `${baseName}.json`);
  fs.writeFileSync(templatePath, JSON.stringify({
    type: "process",
    name: processName,
    from: "User",
    layer_height: layerHeight,
  }));
  return templatePath;
}

const FAKE_SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="3600"/>
    <metadata key="weight" value="12.5"/>
    <filament id="1" type="PLA" color="#FFFFFF" used_m="4.2" used_g="12.5"/>
    <warning msg="bed_temperature_too_high_than_filament" level="3" error_code ="1000C001"  />
  </plate>
</config>`;

async function createFakeBambuSlicer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-mcp-template-slicer-"));
  const fakeSlicerPath = path.join(tempDir, "fake-slicer.mjs");
  const argsOutPath = path.join(tempDir, "args.json");
  // The fake executable has no app bundle. Give profile preparation a complete,
  // explicit tree so these tests do not depend on an installed BambuStudio.
  const profilesRoot = path.join(tempDir, "profiles");
  for (const kind of ["machine", "process", "filament"]) {
    fs.mkdirSync(path.join(profilesRoot, "BBL", kind), { recursive: true });
  }
  fs.writeFileSync(path.join(profilesRoot, "BBL", "cli_config.json"), JSON.stringify({ printer: {
    "Bambu Lab P1S": { downward_check: { "Bambu Lab P1S 0.4 nozzle": ["Bambu Lab A1 0.4 nozzle"] } },
  } }));
  const writeProfile = (kind, profile) => fs.writeFileSync(
    path.join(profilesRoot, "BBL", kind, `${profile.name}.json`), JSON.stringify(profile)
  );
  writeProfile("machine", { name: "Bambu Lab P1S 0.4 nozzle", nozzle_diameter: ["0.4"], default_print_profile: "Behavior process", default_filament_profile: ["Behavior filament"], machine_start_gcode: "fixture start" });
  writeProfile("process", { name: "Behavior process", layer_height: "0.2" });
  writeProfile("filament", { name: "Behavior filament", filament_type: ["PLA"] });
  // slice_stl reads the slicer's plate summary from the output 3MF.
  const slicedBase64 = await new JSZip().file("Metadata/slice_info.config", FAKE_SLICE_INFO).generateAsync({ type: "base64" });
  fs.writeFileSync(
    fakeSlicerPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsOutPath)}, JSON.stringify(args));
const outputDir = args[args.indexOf("--outputdir") + 1] || path.dirname(args[args.indexOf("--export-3mf") + 1]);
const exportArg = args[args.indexOf("--export-3mf") + 1];
const outputPath = path.isAbsolute(exportArg) ? exportArg : path.join(outputDir, exportArg);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, Buffer.from(${JSON.stringify(slicedBase64)}, "base64"));
`
  );
  fs.chmodSync(fakeSlicerPath, 0o755);
  return { tempDir, fakeSlicerPath, argsOutPath, profilesRoot };
}

test("slice_with_template prefers named template settings over BAMBU_SLICER_PROFILE default", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  const templateDir = path.join(fakeSlicer.tempDir, "templates");
  fs.mkdirSync(templateDir, { recursive: true });
  await writeTemplate3mfFixture(templateDir);
  const defaultProfilePath = path.join(fakeSlicer.tempDir, "default-profile.json");
  fs.writeFileSync(defaultProfilePath, JSON.stringify({ name: "default should not win" }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      BAMBU_SLICER_PROFILE: defaultProfilePath,
      BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot,
      MCP_ALLOW_EXECUTABLE_ARG: "1",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);
  const result = await client.callTool({
    name: "slice_with_template",
    arguments: {
      stl_path: SAMPLE_STL,
      template_name: "template-process",
      template_dir: templateDir,
      bambu_model: "p1s",
      slicer_path: fakeSlicer.fakeSlicerPath,
    },
  });

  assert.equal(result.isError, undefined);
  const sliced = JSON.parse(result.content[0].text);
  assert.match(path.basename(path.dirname(sliced.output_path)), /^slice-/);
  assert.equal(path.basename(sliced.output_path), "sample_cube_sliced.3mf");
  assert.deepEqual(sliced.plates, [{
    index: 1, prediction_s: 3600, weight_g: 12.5,
    filaments: [{ type: "PLA", color: "#FFFFFF", used_g: 12.5, used_m: 4.2 }],
    warnings: [{ msg: "bed_temperature_too_high_than_filament", level: 3, error_code: "1000C001" }],
  }]);
  const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
  const settingsValue = slicerArgs[slicerArgs.indexOf("--load-settings") + 1];
  const processPath = settingsValue.split(";").at(-1);
  const processSettings = JSON.parse(fs.readFileSync(processPath, "utf8"));
  assert.equal(processSettings.name, "Template Process");
  assert.equal(processSettings.layer_height, "0.16");
  assert.ok(!settingsValue.includes(defaultProfilePath), "server-level BAMBU_SLICER_PROFILE must not override a named template");
});

test("template machine settings never replace the selected machine preset", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  fs.writeFileSync(path.join(fakeSlicer.profilesRoot, "BBL", "machine", "Bambu Lab P1S 0.4 nozzle.json"), JSON.stringify({
    name: "Bambu Lab P1S 0.4 nozzle", printer_model: "Bambu Lab P1S", nozzle_diameter: ["0.4"],
    default_print_profile: "Behavior process", default_filament_profile: ["Behavior filament"], machine_start_gcode: "fixture start",
  }));
  // A project sliced for another printer stores that printer's machine settings in project_settings.
  const zip = new JSZip();
  zip.file("Metadata/project_settings.config", JSON.stringify({
    printer_model: "Bambu Lab X1 Carbon", printer_settings_id: "Bambu Lab X1 Carbon 0.4 nozzle",
    machine_start_gcode: "; TEMPLATE_MACHINE_MARKER", nozzle_diameter: ["0.6"], layer_height: "0.16",
  }));
  const templateDir = path.join(fakeSlicer.tempDir, "templates");
  fs.mkdirSync(templateDir, { recursive: true });
  const templatePath = path.join(templateDir, "x1c-project.3mf");
  fs.writeFileSync(templatePath, await zip.generateAsync({ type: "nodebuffer" }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      BAMBU_SLICER_PROFILE: "",
      BAMBU_TEMPLATE_3MF_PATH: "",
      BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot,
      BAMBU_SLICER_PROFILE_DIRS: "",
      MCP_ALLOW_EXECUTABLE_ARG: "1",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);
  for (const [name, template] of [
    ["slice_stl", { template_3mf_path: templatePath }],
    ["slice_with_template", { template_name: "x1c-project", template_dir: templateDir }],
  ]) {
    const result = await client.callTool({
      name,
      arguments: {
        stl_path: SAMPLE_STL,
        ...template,
        bambu_model: "p1s",
        slicer_path: fakeSlicer.fakeSlicerPath,
      },
    });

    assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result.content)}`);
    const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
    const [machinePath, processPath] = slicerArgs[slicerArgs.indexOf("--load-settings") + 1].split(";");
    const machine = JSON.parse(fs.readFileSync(machinePath, "utf8"));
    assert.equal(machine.machine_start_gcode, "fixture start");
    assert.equal(machine.printer_model, "Bambu Lab P1S");
    const processSettings = JSON.parse(fs.readFileSync(processPath, "utf8"));
    assert.equal(processSettings.layer_height, "0.16", `${name} keeps template process settings`);
    for (const key of ["machine_start_gcode", "printer_model", "nozzle_diameter"]) {
      assert.equal(key in processSettings, false, `${name}: template ${key} must not reach the CLI`);
    }
  }
});

test("slice_stl writes the installed nozzle type into the machine preset so printing can match the printer", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  fs.writeFileSync(path.join(fakeSlicer.profilesRoot, "BBL", "machine", "Bambu Lab P1S 0.4 nozzle.json"), JSON.stringify({
    name: "Bambu Lab P1S 0.4 nozzle", nozzle_diameter: ["0.4"], nozzle_type: ["stainless_steel"],
    default_print_profile: "Behavior process", default_filament_profile: ["Behavior filament"], machine_start_gcode: "fixture start",
  }));
  const connect = async (extraEnv = {}) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: {
        ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s",
        BAMBU_SLICER_PROFILE: "", BAMBU_TEMPLATE_3MF_PATH: "", BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot,
        BAMBU_SLICER_PROFILE_DIRS: "", BAMBU_NOZZLE_TYPE: "", BAMBU_NOZZLE_VOLUME_TYPE: "", MCP_ALLOW_EXECUTABLE_ARG: "1", ...extraEnv,
      },
      stderr: "pipe",
    });
    const client = createClient();
    t.after(async () => { await closeTransport(transport); });
    await client.connect(transport);
    return (extra) => client.callTool({ name: "slice_stl", arguments: {
      stl_path: SAMPLE_STL, bambu_model: "p1s", slicer_path: fakeSlicer.fakeSlicerPath, ...extra,
    } });
  };
  const machine = () => {
    const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
    return JSON.parse(fs.readFileSync(slicerArgs[slicerArgs.indexOf("--load-settings") + 1].split(";")[0], "utf8"));
  };
  const slice = await connect();
  let result = await slice({ nozzle_type: "hardened_steel" });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(machine().nozzle_type, ["hardened_steel"]);
  // Without a choice the preset's stock nozzle is kept.
  result = await slice({});
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(machine().nozzle_type, ["stainless_steel"]);
  // Invalid values stop before the slicer runs.
  fs.rmSync(fakeSlicer.argsOutPath);
  result = await slice({ nozzle_type: "diamond" });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Invalid nozzle type/);
  assert.equal(fs.existsSync(fakeSlicer.argsOutPath), false, "the slicer must not run");
  // BAMBU_NOZZLE_TYPE supplies the default.
  result = await (await connect({ BAMBU_NOZZLE_TYPE: "hardened-steel" }))({});
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(machine().nozzle_type, ["hardened_steel"]);
});

test("slice_stl slices for the installed nozzle flow type and refuses one the preset lacks", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  const writeMachine = (variants) => fs.writeFileSync(path.join(fakeSlicer.profilesRoot, "BBL", "machine", "Bambu Lab P1S 0.4 nozzle.json"), JSON.stringify({
    name: "Bambu Lab P1S 0.4 nozzle", nozzle_diameter: ["0.4"], extruder_type: ["Direct Drive"], extruder_variant_list: [variants],
    default_print_profile: "Behavior process", default_filament_profile: ["Behavior filament"], machine_start_gcode: "fixture start",
  }));
  writeMachine("Direct Drive Standard,Direct Drive High Flow");
  const connect = async (extraEnv = {}) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: {
        ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "p1s",
        BAMBU_SLICER_PROFILE: "", BAMBU_TEMPLATE_3MF_PATH: "", BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot,
        BAMBU_SLICER_PROFILE_DIRS: "", BAMBU_NOZZLE_TYPE: "", BAMBU_NOZZLE_VOLUME_TYPE: "", MCP_ALLOW_EXECUTABLE_ARG: "1", ...extraEnv,
      },
      stderr: "pipe",
    });
    const client = createClient();
    t.after(async () => { await closeTransport(transport); });
    await client.connect(transport);
    return (extra) => client.callTool({ name: "slice_stl", arguments: {
      stl_path: SAMPLE_STL, bambu_model: "p1s", slicer_path: fakeSlicer.fakeSlicerPath, ...extra,
    } });
  };
  const machine = () => {
    const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
    return JSON.parse(fs.readFileSync(slicerArgs[slicerArgs.indexOf("--load-settings") + 1].split(";")[0], "utf8"));
  };
  const slice = await connect();
  let result = await slice({ nozzle_volume_type: "high_flow" });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(machine().nozzle_volume_type, ["High Flow"]);
  // Without a choice the preset's Standard default is kept.
  result = await slice({});
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(machine().nozzle_volume_type, ["Standard"]);
  // Invalid values stop before the slicer runs.
  fs.rmSync(fakeSlicer.argsOutPath);
  result = await slice({ nozzle_volume_type: "turbo" });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Invalid nozzle volume type/);
  assert.equal(fs.existsSync(fakeSlicer.argsOutPath), false, "the slicer must not run");
  // BAMBU_NOZZLE_VOLUME_TYPE supplies the default.
  result = await (await connect({ BAMBU_NOZZLE_VOLUME_TYPE: "High Flow" }))({});
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(machine().nozzle_volume_type, ["High Flow"]);
  // A preset without High Flow values is refused rather than mislabelled.
  writeMachine("Direct Drive Standard");
  fs.rmSync(fakeSlicer.argsOutPath);
  result = await slice({ nozzle_volume_type: "high_flow" });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /declares no High Flow variant/);
  assert.equal(fs.existsSync(fakeSlicer.argsOutPath), false, "the slicer must not run");
});

test("template_name resolves by source type for slicer profiles versus 3MF sources", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  const templateDir = path.join(fakeSlicer.tempDir, "templates");
  fs.mkdirSync(templateDir, { recursive: true });
  await writeTemplate3mfFixture(templateDir, "shared-template", "3MF Template", "0.20");
  await writeTemplateJsonFixture(templateDir, "shared-template", "JSON Template", "0.12");
  await writeTemplateJsonFixture(templateDir, "My Template", "Space Template", "0.18");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      BAMBU_PROFILES_ROOT: fakeSlicer.profilesRoot,
      MCP_ALLOW_EXECUTABLE_ARG: "1",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const inspected = await client.callTool({
    name: "get_slice_settings",
    arguments: {
      template_name: "shared-template",
      template_dir: templateDir,
    },
  });
  assert.equal(inspected.isError, undefined);
  assert.equal(parseJsonResult(inspected).source_type, "3mf");

  const sliced = await client.callTool({
    name: "slice_with_template",
    arguments: {
      stl_path: SAMPLE_STL,
      template_name: "shared-template",
      template_dir: templateDir,
      bambu_model: "p1s",
      slicer_path: fakeSlicer.fakeSlicerPath,
    },
  });

  assert.equal(sliced.isError, undefined);
  const slicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
  const settingsValue = slicerArgs[slicerArgs.indexOf("--load-settings") + 1];
  const processPath = settingsValue.split(";").at(-1);
  const processSettings = JSON.parse(fs.readFileSync(processPath, "utf8"));
  assert.equal(processSettings.name, "JSON Template");
  assert.equal(processSettings.layer_height, "0.12");

  const spaced = await client.callTool({
    name: "slice_with_template",
    arguments: {
      stl_path: SAMPLE_STL,
      template_name: "My Template",
      template_dir: templateDir,
      bambu_model: "p1s",
      slicer_path: fakeSlicer.fakeSlicerPath,
    },
  });

  assert.equal(spaced.isError, undefined);
  const spacedSlicerArgs = JSON.parse(fs.readFileSync(fakeSlicer.argsOutPath, "utf8"));
  const spacedSettingsValue = spacedSlicerArgs[spacedSlicerArgs.indexOf("--load-settings") + 1];
  const spacedProcessPath = spacedSettingsValue.split(";").at(-1);
  const spacedProcessSettings = JSON.parse(fs.readFileSync(spacedProcessPath, "utf8"));
  assert.equal(spacedProcessSettings.name, "Space Template");
  assert.equal(spacedProcessSettings.layer_height, "0.18");
});

test("non-slicer tools ignore invalid slicer configuration", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      SLICER_TYPE: "definitely-not-a-real-slicer",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);
  const result = await client.callTool({
    name: "get_stl_info",
    arguments: { stl_path: SAMPLE_STL },
  });

  assert.equal(result.isError, undefined);
  const payload = parseJsonResult(result);
  assert.equal(payload.fileName, "sample_cube.stl");
});

test("per-call executable selectors are rejected before any process can start", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-executable-selector-gate-"));
  const executable = path.join(tempDir, "unexpected-executable");
  const markerPath = path.join(tempDir, "executed");
  fs.writeFileSync(
    executable,
    `#!/bin/sh\nprintf executed > '${markerPath}'\nexit 17\n`,
    { mode: 0o755 }
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "",
      BLENDER_MCP_BRIDGE_COMMAND: "",
      MCP_ALLOW_EXECUTABLE_ARG: "",
      MCP_ALLOW_BRIDGE_COMMAND_ARG: "",
    },
    stderr: "pipe",
  });
  const client = createClient();

  t.after(async () => {
    await closeTransport(transport);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await client.connect(transport);

  for (const call of [
    {
      name: "slice_stl",
      argumentName: "slicer_path",
      arguments: {
        stl_path: SAMPLE_STL,
        slicer_type: "bambustudio",
        slicer_path: executable,
        bambu_model: "p1s",
      },
    },
    {
      name: "blender_mcp_edit_model",
      argumentName: "bridge_command",
      arguments: {
        stl_path: SAMPLE_STL,
        operations: ["remesh"],
        execute: true,
        bridge_command: executable,
      },
    },
  ]) {
    fs.rmSync(markerPath, { force: true });
    const rejected = await client.callTool({
      name: call.name,
      arguments: call.arguments,
    });
    assert.equal(rejected.isError, true, `${call.name} must reject ${call.argumentName}`);
    assert.match(rejected.content?.[0]?.text || "", new RegExp(call.argumentName));
    assert.match(rejected.content?.[0]?.text || "", /MCP_ALLOW_EXECUTABLE_ARG/);
    assert.equal(
      fs.existsSync(markerPath),
      false,
      `${call.name} must reject ${call.argumentName} before executing it`
    );
  }
});

test("legacy bridge opt-in does not authorize slicer executables", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-legacy-bridge-gate-"));
  const executable = path.join(tempDir, "unexpected-executable");
  const markerPath = path.join(tempDir, "executed");
  const bridgeExecutable = path.join(tempDir, "trusted-legacy-bridge");
  const bridgeMarkerPath = path.join(tempDir, "bridge-executed");
  fs.writeFileSync(
    executable,
    `#!/bin/sh\nprintf executed > '${markerPath}'\nexit 17\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    bridgeExecutable,
    `#!/bin/sh\nprintf executed > '${bridgeMarkerPath}'\nexit 0\n`,
    { mode: 0o755 }
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "",
      MCP_ALLOW_EXECUTABLE_ARG: "",
      MCP_ALLOW_BRIDGE_COMMAND_ARG: "1",
    },
    stderr: "pipe",
  });
  const client = createClient();

  t.after(async () => {
    await closeTransport(transport);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await client.connect(transport);
  for (const call of [
    {
      name: "slice_stl",
      argumentName: "slicer_path",
      arguments: {
        stl_path: SAMPLE_STL,
        slicer_type: "bambustudio",
        slicer_path: executable,
        bambu_model: "p1s",
      },
    },
  ]) {
    fs.rmSync(markerPath, { force: true });
    const rejected = await client.callTool({
      name: call.name,
      arguments: call.arguments,
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content?.[0]?.text || "", new RegExp(call.argumentName));
    assert.match(rejected.content?.[0]?.text || "", /MCP_ALLOW_EXECUTABLE_ARG/);
    assert.equal(
      fs.existsSync(markerPath),
      false,
      `${call.argumentName} must remain blocked by the legacy bridge-only flag`
    );
  }

  const bridgeResult = await client.callTool({
    name: "blender_mcp_edit_model",
    arguments: {
      stl_path: SAMPLE_STL,
      operations: ["remesh"],
      execute: true,
      bridge_command: bridgeExecutable,
    },
  });
  assert.equal(bridgeResult.isError, undefined, "the legacy flag must still authorize bridge_command");
  assert.equal(
    fs.existsSync(bridgeMarkerPath),
    true,
    "the legacy bridge-only compatibility path must remain functional"
  );
});

test("empty slicer_path preserves env fallback without executable opt-in", async (t) => {
  const fakeSlicer = await createFakeBambuSlicer();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
      SLICER_PATH: fakeSlicer.fakeSlicerPath,
      MCP_ALLOW_EXECUTABLE_ARG: "",
      MCP_ALLOW_BRIDGE_COMMAND_ARG: "",
    },
    stderr: "pipe",
  });
  const client = createClient();
  t.after(async () => {
    await closeTransport(transport);
    fs.rmSync(fakeSlicer.tempDir, { recursive: true, force: true });
  });

  await client.connect(transport);
  const result = await client.callTool({
    name: "slice_stl",
    arguments: {
      stl_path: SAMPLE_STL,
      slicer_path: "",
      bambu_model: "p1s",
    },
  });
  assert.doesNotMatch(result.content?.[0]?.text || "", /MCP_ALLOW_EXECUTABLE_ARG/);
});

test("stdio transport: initialize, list tools, call success + structured failure", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, "bambu-printer-mcp");

  const listToolsResult = await client.listTools();
  assertCommonToolPresence(listToolsResult);

  assert.equal(client.getServerCapabilities()?.resources, undefined, "the server exposes no printer resources");

  const success = await client.callTool({
    name: "get_stl_info",
    arguments: { stl_path: SAMPLE_STL },
  });

  assert.equal(success.isError, undefined);
  const successPayload = parseJsonResult(success);
  assert.equal(successPayload.fileName, "sample_cube.stl");
  assert.equal(successPayload.faceCount, 12);

  const failure = await client.callTool({
    name: "get_stl_info",
    arguments: {},
  });

  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent?.status, "error");
  assert.equal(typeof failure.structuredContent?.suggestion, "string");
});

test("streamable-http transport: initialize, list tools, call success + origin rejection", async (t) => {
  const port = await getFreePort();
  const endpoint = `http://127.0.0.1:${port}/mcp`;

  const childProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MCP_TRANSPORT: "streamable-http",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_ALLOWED_ORIGINS: "http://localhost",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderrOutput = "";
  childProcess.stderr?.on("data", (chunk) => { stderrOutput += chunk.toString(); });

  t.after(async () => { await terminateChildProcess(childProcess); });

  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await waitForHttpServerReady(endpoint);
  await client.connect(transport);

  assert.equal(client.getServerVersion()?.name, "bambu-printer-mcp");

  const listToolsResult = await client.listTools();
  assertCommonToolPresence(listToolsResult);

  const success = await client.callTool({
    name: "get_stl_info",
    arguments: { stl_path: SAMPLE_STL },
  });

  const successPayload = parseJsonResult(success);
  assert.equal(successPayload.fileName, "sample_cube.stl");

  const forbiddenOriginResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://malicious.local",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-05",
        capabilities: {},
        clientInfo: { name: "origin-test-client", version: "1.0.0" },
      },
    }),
  });

  assert.equal(
    forbiddenOriginResponse.status,
    403,
    `Expected 403 for forbidden origin. stderr: ${stderrOutput}`
  );

  const wrongPathResponse = await fetch(`http://127.0.0.1:${port}/not-mcp`, { method: "POST" });
  assert.equal(wrongPathResponse.status, 404);
});

test("slice_stl schema: all BambuStudio slicer options present with correct types and descriptions", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const listToolsResult = await client.listTools();
  const sliceTool = listToolsResult.tools.find((t) => t.name === "slice_stl");
  assert.ok(sliceTool, "slice_stl tool must exist");

  const props = sliceTool.inputSchema?.properties || {};

  // Matrix test: every BambuStudio slicer option must be present, typed correctly,
  // and have a meaningful description.
  for (const [propName, expectedType, descFragment] of BAMBU_SLICER_OPTION_CONTRACTS) {
    assert.ok(
      props[propName],
      `slice_stl must have property "${propName}"`
    );
    assert.equal(
      props[propName].type,
      expectedType,
      `slice_stl.${propName} must be type "${expectedType}", got "${props[propName].type}"`
    );
    assert.ok(
      props[propName].description?.toLowerCase().includes(descFragment),
      `slice_stl.${propName} description must mention "${descFragment}", got: "${props[propName].description}"`
    );
  }

  // Original core params must still be present (regression guard)
  for (const coreParam of ["stl_path", "bambu_model", "slicer_type", "slicer_path", "slicer_profile", "nozzle_diameter"]) {
    assert.ok(props[coreParam], `slice_stl must retain core property "${coreParam}"`);
  }

  // bambu_model and stl_path must remain required
  assert.ok(
    sliceTool.inputSchema.required.includes("bambu_model"),
    "bambu_model must be required"
  );
  assert.ok(
    sliceTool.inputSchema.required.includes("stl_path"),
    "stl_path must be required"
  );

  // New slicer options must NOT be required (they are all optional)
  for (const [propName] of BAMBU_SLICER_OPTION_CONTRACTS) {
    assert.ok(
      !sliceTool.inputSchema.required?.includes(propName),
      `Slicer option "${propName}" must not be required`
    );
  }
});

test("tool schema invariant: every tool property has a description", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const listToolsResult = await client.listTools();

  // Every tool must have a description, and every property must have a description.
  // This is critical for LLM tool-use (codemode) -- missing descriptions degrade tool selection.
  for (const tool of listToolsResult.tools) {
    assert.ok(
      tool.description && tool.description.length > 10,
      `Tool "${tool.name}" must have a meaningful description`
    );

    const props = tool.inputSchema?.properties || {};
    for (const [propName, propSchema] of Object.entries(props)) {
      assert.ok(
        propSchema.description && propSchema.description.length > 5,
        `${tool.name}.${propName} must have a description (got: "${propSchema.description || ""}")`
      );
    }
  }
});

test("tool schema invariant: input schemas use Codex-compatible root objects", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      BAMBU_MODEL: "p1s",
    },
    stderr: "pipe",
  });

  const client = createClient();
  t.after(async () => { await closeTransport(transport); });

  await client.connect(transport);

  const listToolsResult = await client.listTools();

  for (const tool of listToolsResult.tools) {
    assert.equal(
      tool.inputSchema?.type,
      "object",
      `${tool.name} input schema root must be an object`
    );
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(tool.inputSchema || {}, keyword),
        false,
        `${tool.name} input schema root must not use ${keyword}`
      );
    }
  }
});

test("H2D Pro slicing selects its exact installed preset and refuses an H2D substitute", async (t) => {
  const fixture = await createFakeBambuSlicer();
  t.after(() => fs.rmSync(fixture.tempDir, { recursive: true, force: true }));
  const preset = "Bambu Lab H2D Pro 0.4 nozzle";
  const machinePath = path.join(fixture.profilesRoot, "BBL", "machine", `${preset}.json`);
  fs.writeFileSync(machinePath, JSON.stringify({
    name: preset, printer_model: "Bambu Lab H2D Pro", nozzle_diameter: ["0.4", "0.4"],
    default_print_profile: "Behavior process", default_filament_profile: ["Behavior filament"],
    machine_start_gcode: "H2D Pro fixture start",
  }));
  fs.writeFileSync(path.join(fixture.profilesRoot, "BBL", "cli_config.json"), JSON.stringify({ printer: {
    "Bambu Lab H2D Pro": { downward_check: { [preset]: [] } },
  } }));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_ENTRY], stderr: "pipe",
    env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "h2dpro",
      BAMBU_SLICER_PROFILE: "", BAMBU_TEMPLATE_3MF_PATH: "", BAMBU_PROFILES_ROOT: fixture.profilesRoot,
      BAMBU_SLICER_PROFILE_DIRS: "", BAMBU_NOZZLE_TYPE: "", BAMBU_NOZZLE_VOLUME_TYPE: "", MCP_ALLOW_EXECUTABLE_ARG: "1" },
  });
  const client = createClient();
  t.after(async () => { await closeTransport(transport); });
  await client.connect(transport);
  const slice = () => client.callTool({ name: "slice_stl", arguments: {
    stl_path: SAMPLE_STL, bambu_model: "h2dpro", slicer_path: fixture.fakeSlicerPath,
  } });
  const result = await slice();
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const args = JSON.parse(fs.readFileSync(fixture.argsOutPath, "utf8"));
  const machine = JSON.parse(fs.readFileSync(args[args.indexOf("--load-settings") + 1].split(";")[0], "utf8"));
  assert.equal(machine.machine_start_gcode, "H2D Pro fixture start");
  assert.deepEqual(machine.nozzle_diameter, ["0.4", "0.4"]);
  fs.rmSync(machinePath);
  fs.writeFileSync(path.join(fixture.profilesRoot, "BBL", "machine", "Bambu Lab H2D 0.4 nozzle.json"), JSON.stringify({
    name: "Bambu Lab H2D 0.4 nozzle", printer_model: "Bambu Lab H2D", nozzle_diameter: ["0.4", "0.4"],
    default_print_profile: "Behavior process", default_filament_profile: ["Behavior filament"],
  }));
  fs.rmSync(fixture.argsOutPath);
  const missing = await slice();
  assert.equal(missing.isError, true, JSON.stringify(missing.content));
  assert.equal(fs.existsSync(fixture.argsOutPath), false, "missing exact preset must stop before CLI execution");
});
