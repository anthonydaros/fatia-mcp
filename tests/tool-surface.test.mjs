import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// This fork prepares models for Bambu Studio and never contacts or controls a printer.
const KEPT_TOOLS = [
  "blender_mcp_call", "blender_mcp_edit_model", "blender_mcp_status", "center_model", "consult_knowledge", "extend_stl_base",
  "get_slice_settings", "get_stl_info", "lay_flat", "list_3mf_plate_objects", "list_templates", "merge_vertices", "open_in_slicer",
  "prepare_print_project", "preflight_check", "rotate_stl", "save_template", "scale_stl", "slice_stl", "slice_with_template", "slicer_info",
].sort();
const REMOVED_TOOLS = [
  "get_printer_status", "get_printer_filaments", "resolve_3mf_ams_slots", "list_printer_files", "bambu_connect_import_file",
  "camera_snapshot", "delete_printer_file", "upload_gcode", "upload_file", "start_print", "start_print_job", "cancel_print",
  "pause_print", "resume_print", "x2d_native_control", "clear_hms_errors", "set_print_speed", "set_airduct_mode", "reread_ams_rfid",
  "set_temperature", "set_fan_speed", "set_light", "skip_objects", "set_ams_drying", "inspect_print_file", "print_3mf",
  "print_collar_charm", "print_3mf_bambu_network", "bambu_network_bridge_status", "bambu_network_call",
];

async function connect(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-tool-surface-"));
  const client = new Client({ name: "tool-surface-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, "dist/index.js")], cwd: tempDir, stderr: "pipe",
    // Explicit env: the developer's own .env must not change what the server registers.
    env: { PATH: process.env.PATH || "", MCP_TRANSPORT: "stdio", SLICER_TYPE: "bambustudio", TEMP_DIR: tempDir, BAMBU_MODEL: "" },
  });
  t.after(async () => { await client.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  await client.connect(transport);
  return client;
}

test("the server registers exactly the slicing, tuning, knowledge, STL/3MF and Blender tools", async (t) => {
  const client = await connect(t);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, KEPT_TOOLS);
  for (const removed of REMOVED_TOOLS) assert.ok(!names.includes(removed), `${removed} must not be registered`);
});

test("print-style tool names are unknown tools and no printer resources exist", async (t) => {
  const client = await connect(t);
  for (const name of ["print_3mf", "start_print", "upload_file", "get_printer_status", "set_temperature", "print_collar_charm"]) {
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, true, `${name} must fail`);
    assert.match(result.content[0].text, new RegExp(`Unknown tool: ${name}`));
  }
  assert.equal(client.getServerCapabilities()?.resources, undefined, "the server advertises no resources");
  await assert.rejects(client.readResource({ uri: "printer://127.0.0.1/status" }));
});

function distSources(directory = path.join(root, "dist")) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? distSources(file) : entry.name.endsWith(".js") ? [file] : [];
  });
}

test("compiled output imports no printer transport and the package declares none", () => {
  const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"'./][^"']*)["']/g;
  const imported = new Set();
  for (const file of distSources()) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(specifier)) imported.add(match[1]);
  }
  for (const name of imported) {
    assert.doesNotMatch(name, /^(?:node:)?(?:net|tls|dgram|dns|https|http2)$|mqtt|basic-ftp|bambu-node/, `dist must not import ${name}`);
  }
  assert.ok(imported.has("jszip") && imported.has("@modelcontextprotocol/sdk/server/index.js"), "the scan must see the real imports");

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  for (const name of ["mqtt", "basic-ftp", "bambu-node", "patch-package"]) {
    assert.equal(manifest.dependencies?.[name], undefined, `${name} must not be a dependency`);
    assert.equal(lock.packages[`node_modules/${name}`], undefined, `${name} must not be in the lockfile`);
  }
  assert.equal(manifest.scripts.postinstall, undefined, "nothing runs at install time");
  assert.deepEqual(Object.keys(manifest.bin), ["fatia-mcp"]);
  for (const name of ["native", "patches", "src/bambu-native.ts", "src/bambu-connect.ts", "src/printers"]) {
    assert.equal(fs.existsSync(path.join(root, name)), false, `${name} must not exist`);
  }
});
