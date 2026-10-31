import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BambuImplementation } from "../dist/printers/bambu.js";
import { UNPINNED_PLUGIN_ENV, createFakeNativeHome } from "./fixtures/native-home.mjs";

// Mocked printers never report a started job; tests that cover it opt back in.
process.env.BAMBU_DISPATCH_CHECK_MS = "0";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const unsupportedX2D = /X2D direct printing is not supported.*native eMMC/i;

async function fixture(t, sliced = true, physicalNozzle = 0) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-x2d-safety-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, sliced ? "cube.gcode.3mf" : "cube.3mf");
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>');
  if (sliced) {
    zip.file("Metadata/plate_1.gcode", `; filament_map = ${physicalNozzle + 1}\n; physical_extruder_map = 0,1\n` + "; printer_model = Bambu Lab X2D\n; nozzle_diameter = 0.4;0.4\n; filament_type = PLA\n; curr_bed_type = Textured PEI Plate\n; filament_colour = #FFFFFF\nG1 X0 Y0\n");
    zip.file("Metadata/plate_1.json", JSON.stringify({ filament_ids: [0] }));
  }
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  return { dir, file };
}

test("X2D direct print methods reject model and serial identities before upload or connection", async (t) => {
  const { file } = await fixture(t);
  const printer = new BambuImplementation();
  const effects = [];
  printer.ftpUpload = async () => { effects.push("upload"); };
  printer.getPrinter = async () => {
    effects.push("connect");
    return { publish: async () => { effects.push("publish"); } };
  };
  for (const [model, serial] of [["x2d", "UNKNOWN"], [undefined, "20PTEST"], ["h2d", "20PTEST"]]) {
    await assert.rejects(() => printer.print3mf("127.0.0.1", serial, "DUMMY", {
      projectName: "cube", filePath: file, bambuModel: model, useAMS: true, amsSlots: [0],
    }), unsupportedX2D);
    await assert.rejects(() => printer.startJob("127.0.0.1", serial, "DUMMY", "cube.gcode", model), unsupportedX2D);
    await assert.rejects(() => printer.uploadFile("127.0.0.1", serial, "DUMMY", file, "cube.gcode", true, model), unsupportedX2D);
  }
  assert.deepEqual(effects, [], "unsupported requests must never contact the printer");
});

test("X2D MCP print requests stop before slicing, status, uploads, and connections", async (t) => {
  const { dir, file } = await fixture(t, false);
  const effectsFile = path.join(dir, "effects.jsonl");
  await fs.writeFile(effectsFile, "");
  const preload = `
    import { appendFileSync } from 'node:fs';
    import { BambuImplementation } from ${JSON.stringify(new URL("../dist/printers/bambu.js", import.meta.url).href)};
    import { STLManipulator } from ${JSON.stringify(new URL("../dist/stl/stl-manipulator.js", import.meta.url).href)};
    for (const method of ['getPrinter', 'getStatus', 'ftpUpload']) {
      BambuImplementation.prototype[method] = async () => {
        appendFileSync(${JSON.stringify(effectsFile)}, method + '\\n');
        throw new Error('Unexpected printer side effect: ' + method);
      };
    }
    STLManipulator.prototype.sliceSTL = async () => {
      appendFileSync(${JSON.stringify(effectsFile)}, 'slice\\n');
      throw new Error('Unexpected slicing');
    };
    BambuImplementation.prototype.getSafetyStatus = async (_host, serial) => ({
      connected:true, serial, model:'x2d', status:'IDLE',
      raw:{model:'x2d',vir_slot:[{id:254,tray_type:'PLA'},{id:255,tray_type:'PLA'}],gcode_state:'IDLE',print_error:0,hms:[],nozzle_diameter:['0.4','0.4']},
      observation:{source:'mqtt',requestedAt:Date.now()-1,receivedAt:Date.now(),identitySource:'report'}
    });
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, path.join(ROOT, "dist/index.js")],
    cwd: dir,
    env: {
      ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", BAMBU_PRINTER_MODEL: "",
      BAMBU_PRINTER_HOST: "127.0.0.1", BAMBU_PRINTER_SERIAL: "UNKNOWN", BAMBU_PRINTER_ACCESS_TOKEN: "DUMMY",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "x2d-print-safety", version: "0" }, { capabilities: { elicitation: { form: {} } } });
  let elicitations = 0;
  client.setRequestHandler(ElicitRequestSchema, async request => {
    if (request.params.requestedSchema.properties.confirmed) return { action: "accept", content: { confirmed: true } };
    elicitations += 1;
    return { action: "accept", content: { bambu_model: "x2d" } };
  });
  t.after(() => transport.close());
  await client.connect(transport);

  const requests = [
    ["print_collar_charm", { source_path: file }],
    ["start_print", { filename: "cube.gcode" }],
    ["start_print_job", { filename: "cube.gcode" }],
    ["upload_file", { file_path: file, filename: "cube.gcode", print: true }],
  ];
  for (const [name, args] of requests) {
    for (const identity of [{ bambu_model: "x2d" }, { bambu_model: "h2d", bambu_serial: "20PTEST" }, {}]) {
      const result = await client.callTool({ name, arguments: { ...args, ...identity } });
      assert.equal(result.isError, true, `${name} must reject direct X2D printing`);
      assert.match(result.content?.[0]?.text || "", unsupportedX2D, `${name}: ${JSON.stringify(identity)}`);
    }
  }
  assert.equal(elicitations, requests.length, "an elicited X2D model must receive the same guard");
  assert.equal(await fs.readFile(effectsFile, "utf8"), "", "preflight must not contact printers or invoke slicing");

  // The BambuNetwork bridge was removed; its connection mode is no longer a valid route.
  const removed = await client.callTool({ name: "print_3mf", arguments: {
    three_mf_path: file, bambu_model: "x2d", bambu_serial: "20PTEST", use_ams: false, connection_mode: "bambu_network",
  } });
  assert.equal(removed.isError, true);
  assert.match(removed.content?.[0]?.text || "", /Unsupported connection_mode/);
  assert.equal(await fs.readFile(effectsFile, "utf8"), "", "an unsupported mode must not contact printers or invoke slicing");
});

// Dual external spools: 255 (right/main nozzle) and 254 (left/deputy nozzle) must reach the
// native helper unchanged and still pass through the fresh per-nozzle material check.
test("X2D native prints encode verified external spools using the official virtual-slot contract", async (t) => {
  const { dir, file: slicedFile } = await fixture(t);
  const helperFile = path.join(dir, "helper.jsonl");
  const virSlotFile = path.join(dir, "vir_slot.json");
  const helper = path.join(dir, "helper.mjs");
  await fs.writeFile(helperFile, "");
  await fs.writeFile(virSlotFile, JSON.stringify([{ id: "254", tray_type: "PLA" }, { id: "255", tray_type: "PLA" }]));
  await fs.writeFile(helper, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const e = process.env;
appendFileSync(${JSON.stringify(helperFile)}, JSON.stringify({ mode: process.argv[2], file: e.BAMBU_NATIVE_FILE, useAMS: e.BAMBU_NATIVE_USE_AMS,
  mapping: e.BAMBU_NATIVE_AMS_MAPPING, mapping2: e.BAMBU_NATIVE_AMS_MAPPING2, projectName: e.BAMBU_NATIVE_PROJECT_NAME, destination: e.BAMBU_NATIVE_DST_FILE }) + '\\n');
const input = createInterface({ input: process.stdin });
const authorization = new Promise(resolve => input.once('line', resolve));
console.log('native_dispatch_request=1');
if (await authorization !== 'native_dispatch_authorized=1') process.exit(21);
console.log('native_print result=0');
process.exit(0);
`, { mode: 0o755 });
  const preload = `
    import { readFileSync } from 'node:fs';
    import { BambuImplementation } from ${JSON.stringify(new URL("../dist/printers/bambu.js", import.meta.url).href)};
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    for (const method of ['getPrinter', 'getStatus', 'ftpUpload']) {
      BambuImplementation.prototype[method] = async () => { throw new Error('Unexpected printer side effect: ' + method); };
    }
    BambuImplementation.prototype.disconnectAll = async () => {};
    BambuImplementation.prototype.getSafetyStatus = async (_host, serial) => ({
      connected:true, serial, model:'x2d', status:'IDLE',
      raw:{model:'x2d',gcode_state:'IDLE',print_error:0,hms:[],nozzle_diameter:['0.4','0.4'],
        device:{nozzle:{info:[{id:0,diameter:0.4,type:'HH01',stat:0},{id:1,diameter:0.4,type:'HH01',stat:0}]}},
        vir_slot: JSON.parse(readFileSync(${JSON.stringify(virSlotFile)}, 'utf8'))},
      observation:{source:'mqtt',requestedAt:Date.now()-1,receivedAt:Date.now(),identitySource:'report'}
    });
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, path.join(ROOT, "dist/index.js")],
    cwd: dir,
    env: {
      ...process.env, MCP_TRANSPORT: "stdio", BAMBU_MODEL: "", BAMBU_PRINTER_MODEL: "",
      BAMBU_PRINTER_HOST: "127.0.0.1", BAMBU_PRINTER_SERIAL: "UNKNOWN", BAMBU_PRINTER_ACCESS_TOKEN: "DUMMY",
      BAMBU_NATIVE_HELPER: helper, BAMBU_NATIVE_HOME: createFakeNativeHome(dir), ...UNPINNED_PLUGIN_ENV,
      BAMBU_DEFAULT_CONNECTION_MODE: "", BAMBU_NATIVE_TRY_EMMC_PRINT: undefined,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "x2d-dual-external", version: "0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { confirmed: true } }));
  t.after(() => transport.close());
  await client.connect(transport);
  const print = (extra) => client.callTool({ name: "print_3mf", arguments: {
    three_mf_path: slicedFile, bambu_model: "x2d", bambu_serial: "20PTEST", connection_mode: "bambu_native", ...extra,
  } });
  const helperCalls = async () => (await fs.readFile(helperFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);

  const left = await fixture(t, true, 1);
  for (const [index, args] of [{ ams_mapping: [255] }, { ams_slots: [255] }, { ams_mapping: [254], three_mf_path: left.file }, { ams_mapping: [255], use_ams: false }].entries()) {
    const result = await print(args);
    assert.notEqual(result.isError, true, `${JSON.stringify(args)}: ${result.content?.[0]?.text}`);
    const calls = await helperCalls();
    assert.equal(calls.length, index + 1);
    assert.equal(calls[index].mode, "--print-authorized");
    assert.equal(calls[index].mapping, "[-1]", "flat mapping uses the vendor virtual-tray sentinel");
    assert.equal(calls[index].useAMS, String(args.use_ams !== false));
    assert.deepEqual(JSON.parse(calls[index].mapping2), [{ams_id:index === 2 ? 254 : 255,slot_id:0}]);
    assert.notEqual(calls[index].file, slicedFile, "the helper must receive a checked private snapshot");
    // The plug-in names the stored file and printer job from the project name; resume binds to this checked name.
    assert.match(calls[index].projectName, /^checked-[0-9a-f-]{36}-/);
    assert.equal(calls[index].destination.replace(/(?:\.gcode)?\.3mf$/i, ""), calls[index].projectName);
  }
  const before = (await helperCalls()).length;
  for (const args of [{ ams_mapping: [254], use_ams: false }, { ams_slots: [254], use_ams: false }]) {
    const result = await print(args);
    assert.equal(result.isError, true, 'explicit wrong-nozzle spool must not be silently replaced');
    assert.match(result.content?.[0]?.text || '', /nozzle|binding|spool/i);
  }
  for (const args of [{ ams_mapping: [256] }, { ams_slots: [256] }]) {
    const result = await print(args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content?.[0]?.text || "", /255/);
  }
  await fs.writeFile(virSlotFile, JSON.stringify([{ id: "254", tray_type: "PLA" }, { id: "255", tray_type: "PETG" }]));
  const contradicted = await print({ ams_mapping: [255] });
  assert.equal(contradicted.isError, true);
  assert.match(contradicted.content?.[0]?.text || "", /PETG|material/i);
  await fs.writeFile(virSlotFile, JSON.stringify([{ id: "254", tray_type: "PLA" }]));
  const missing = await print({ ams_mapping: [255] });
  assert.equal(missing.isError, true);
  assert.match(missing.content?.[0]?.text || "", /255/);
  assert.equal((await helperCalls()).length, before, "rejected mappings must never reach the helper");
});
