// The guarantee the writer exists for, on the real Bambu Studio CLI (headless): a project written by writeTunedProject, sliced through the
// existing slice pipeline with project_settings "keep" for the target printer, gives a G-code whose CONFIG_BLOCK shows every tuned key at its
// tuned value (process keys, one of them absent from the process preset, the machine keys z_hop and z_hop_types, a filament key, a list written with 'elements' for the aux Bowden nozzle)
// and whose walls show the per-object override. Skipped when the CLI is absent or on CI. Two slices: the STL baseline and the verification.
//
// BAMBU_E2E_H2D_3MF=<an H2D project> adds an opt-in case: retarget to the X2D, tune, slice plate 1 (one more slice).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { loadSafe3mfArchive } from "../dist/safety/archive.js";
import { STLManipulator } from "../dist/stl/stl-manipulator.js";
import { checkBlockValue, readConfigBlock } from "../dist/tuning/config-block.js";
import { writeTunedProject } from "../dist/tuning/project-writer.js";
import { studioRetargeter } from "../dist/tuning/retarget.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES = [process.env.SLICER_PATH, "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio", "C:\\Program Files\\Bambu Studio\\bambu-studio.exe"];
const SLICER = CANDIDATES.find(candidate => candidate && fs.existsSync(candidate));
const SKIP = process.env.CI ? "CI" : !SLICER ? "Bambu Studio CLI not installed" : false;
const X2D = "Bambu Lab X2D 0.4 nozzle";

/** Slice through the pipeline exactly as slice_stl does for project_settings "keep"; returns the G-code text and the sliced project's config. */
async function sliceKeep(input, tempDir, slicePlate) {
  const manipulator = new STLManipulator(tempDir);
  const projectPlan = await manipulator.planProjectSettings(input, SLICER, X2D, "X2D");
  const out = await manipulator.sliceSTL(input, "bambustudio", SLICER, undefined, undefined, X2D, { projectPlan, ...(slicePlate ? { slicePlate } : {}) });
  const zip = await loadSafe3mfArchive(fs.readFileSync(out));
  const gcode = Object.keys(zip.files).find(name => /^Metadata\/plate_\d+\.gcode$/.test(name));
  return { text: await zip.file(gcode).async("string"), projectPlan };
}
async function projectConfig(file) {
  return JSON.parse(await (await JSZip.loadAsync(fs.readFileSync(file))).file("Metadata/project_settings.config").async("string"));
}
/** Extrusion moves of "Inner wall" blocks on one layer: one loop of a cube is 4 moves. */
function innerWallMoves(gcode, layer) {
  let current = 0;
  let feature = "";
  let moves = 0;
  for (const line of gcode.split("\n")) {
    if (line.startsWith("; CHANGE_LAYER")) current++;
    else if (line.startsWith("; FEATURE: ")) feature = line.slice(11).trim();
    else if (current === layer && feature === "Inner wall" && /^G1 .*X.*Y.*E[0-9.]/.test(line)) moves++;
  }
  return moves;
}
function report(t, label, checks) {
  for (const c of checks) t.diagnostic(`${label} ${c.key}: tuned ${JSON.stringify(c.expected)} -> G-code "${c.actual}" (${c.ok === true ? "ok" : c.ok === false ? "MISMATCH" : "unverified"})`);
}

test("a written STL project slices through the keep pipeline with every tuned key in the CONFIG_BLOCK", { skip: SKIP, timeout: 300000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writer-e2e-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stl = path.join(dir, "cube.stl");
  fs.copyFileSync(path.join(ROOT, "test", "sample_cube.stl"), stl);
  const changes = [
    { key: "sparse_infill_pattern", value: "gyroid", scope: "process" },
    { key: "wall_sequence", value: "inner-outer-inner wall", scope: "process" }, // in no process preset of the X2D chain: the plan must overlay it
    { key: "z_hop", value: "0.8", scope: "printer" },
    { key: "z_hop_types", value: "Slope Lift", scope: "printer" },
    { key: "filament_flow_ratio", value: "0.93", scope: "filament" },
    { key: "outer_wall_speed", value: "150", scope: "process", elements: { index_by: "print_extruder_variant", starts_with: "Bowden" } },
  ];
  const work = path.join(dir, "work");
  const written = await writeTunedProject({
    source: stl, output: path.join(dir, "out", "cube.3mf"), target: { printerPreset: X2D }, changes,
    objectOverrides: { settings: { wall_loops: "5" } },
    retarget: studioRetargeter({ slicerPath: SLICER, tempDir: work, printerPreset: X2D, modelCode: "X2D" }), // slice 1: the baseline project
  });
  assert.deepEqual(written.changed_keys.map(c => c.key), changes.map(c => c.key));
  assert.deepEqual(written.object_overrides.map(o => [o.key, o.to]), [["wall_loops", "5"]]);
  assert.ok(written.dropped_entries.some(name => name.endsWith(".gcode")), "the baseline slice's G-code is not in the deliverable");
  const config = await projectConfig(written.path);

  const { text, projectPlan } = await sliceKeep(written.path, work); // slice 2: the delivered project
  assert.deepEqual(Object.keys(projectPlan.machineOverlay).sort(), ["z_hop", "z_hop_types"], "the plan carries the tuned printer keys");
  assert.equal(projectPlan.overlay.wall_sequence, "inner-outer-inner wall", "and the tuned process key the preset lacks");
  const block = readConfigBlock(text);
  assert.ok(block, "the G-code has a CONFIG_BLOCK");
  const checks = changes.map(c => checkBlockValue(config, block, c.key, c.scope));
  report(t, "cube", checks);
  assert.deepEqual(checks.map(c => [c.key, c.ok]), changes.map(c => [c.key, true]));
  assert.equal(block.z_hop, "0.8,0.8");
  assert.equal(block.z_hop_types, "Slope Lift,Slope Lift");
  assert.equal(block.outer_wall_speed.split(",")[1], "150", "the aux Bowden element");
  assert.notEqual(block.outer_wall_speed.split(",")[0], "150", "the main nozzle's element is not touched");
  const moves = innerWallMoves(text, 25);
  t.diagnostic(`cube inner-wall extrusion moves on layer 25: ${moves} (wall_loops 2 gives 4, 5 gives 16)`);
  assert.ok(moves >= 12, "the per-object wall_loops reached the slice");
});

test("an H2D project is retargeted to the X2D, tuned, and slices with the tuned keys (opt-in: BAMBU_E2E_H2D_3MF)", { skip: SKIP || (!process.env.BAMBU_E2E_H2D_3MF && "BAMBU_E2E_H2D_3MF not set"), timeout: 600000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writer-e2e-h2d-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = process.env.BAMBU_E2E_H2D_3MF;
  const before = fs.readFileSync(source);
  const work = path.join(dir, "work");
  const retarget = studioRetargeter({ slicerPath: SLICER, tempDir: work, printerPreset: X2D, modelCode: "X2D" });
  // Different values per filament slot, so a slot that received another slot's tuning shows. A project list holds one entry per slot, or per
  // slot and extruder variant: learn its length from the retargeted project (one export, no slice), then give each slot its own value.
  const p0 = await projectConfig((await writeTunedProject({ source, output: path.join(dir, "p0.3mf"), target: { printerPreset: X2D }, retarget })).path);
  const slots = p0.filament_settings_id.length;
  assert.ok(slots >= 2, "the sample has two filament slots");
  const perSlot = (key, values) => p0[key].map((_, i) => values[Math.floor(i / (p0[key].length / slots))] ?? values[0]);
  const changes = [
    { key: "sparse_infill_pattern", value: "honeycomb", scope: "process" },
    { key: "brim_type", value: "outer_only", scope: "process" },
    { key: "wall_sequence", value: "inner-outer-inner wall", scope: "process" },
    { key: "z_hop", value: "0.8", scope: "printer" },
    { key: "nozzle_temperature", value: perSlot("nozzle_temperature", ["215", "205"]), scope: "filament" },
    { key: "fan_min_speed", value: perSlot("fan_min_speed", ["60", "90"]), scope: "filament" },
  ];
  const written = await writeTunedProject({ source, output: path.join(dir, "h2d-tuned.3mf"), target: { printerPreset: X2D }, changes, retarget });
  assert.equal(written.retarget.reason, "printer-differs");
  assert.ok(written.retarget.changed_keys.length > 0 && written.combined_diff.length >= written.retarget.changed_keys.length);
  assert.ok(Buffer.compare(fs.readFileSync(source), before) === 0, "the original is untouched");
  const config = await projectConfig(written.path);
  t.diagnostic(`retarget ${JSON.stringify(written.retarget.printer_ids.before)} -> ${JSON.stringify(written.retarget.printer_ids.after)}; ${written.retarget.changed_keys.length} retarget keys, ${written.changed_keys.length} tuned keys`);
  const { text } = await sliceKeep(written.path, work, 1);
  const block = readConfigBlock(text);
  const checks = changes.map(c => checkBlockValue(config, block, c.key, c.scope));
  report(t, "h2d", checks);
  assert.deepEqual(checks.map(c => [c.key, c.ok]), changes.map(c => [c.key, true]));
  assert.deepEqual([block.nozzle_temperature, block.fan_min_speed], ["215,205", "60,90"], "each filament slot kept its own value");
});
