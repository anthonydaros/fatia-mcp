// prepare_print_project's loop on the real Bambu Studio CLI (headless), with the real tuning data, writer, scanner and preflight_check: a small STL goes
// in, a NEW unsliced X2D project comes out, and that project is sliced once more to prove it carries the tuned values. Skipped when the CLI is absent or on CI.
// Real slices: the STL's one-off retarget slice, the baseline, round 0 (max_slices 3), then the verification slice: four in all.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { preflightCheck } from "../dist/knowledge/preflight.js";
import { STLManipulator } from "../dist/stl/stl-manipulator.js";
import { checkBlockValue } from "../dist/tuning/config-block.js";
import { getTuning } from "../dist/tuning/loader.js";
import { prepareProject } from "../dist/tuning/prepare.js";
import { studioSlicer } from "../dist/tuning/prepare-slice.js";
import { studioRetargeter } from "../dist/tuning/retarget.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES = [process.env.SLICER_PATH, "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio", "C:\\Program Files\\Bambu Studio\\bambu-studio.exe"];
const SLICER = CANDIDATES.find(candidate => candidate && fs.existsSync(candidate));
const SKIP = process.env.CI ? "CI" : !SLICER ? "Bambu Studio CLI not installed" : false;
const X2D = "Bambu Lab X2D 0.4 nozzle";
const MODELS = ["p1s", "p1p", "p2s", "x1c", "x1e", "a1", "a1mini", "h2d", "h2dpro", "h2s", "h2c", "x2d"];

test("the real loop turns a cube STL into a new unsliced X2D project whose slice shows the tuned values", { skip: SKIP, timeout: 900000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-e2e-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "cube.stl");
  fs.copyFileSync(path.join(ROOT, "test", "sample_cube.stl"), source);
  const before = fs.readFileSync(source);
  const work = path.join(dir, "work");
  const manipulator = new STLManipulator(work);
  const slice = studioSlicer({ manipulator, slicerPath: SLICER, printerPreset: X2D, modelCode: "X2D", plateIndex: 0 });
  const opened = [];
  const deps = {
    tuning: getTuning(), printerPreset: X2D, tempDir: work,
    retarget: studioRetargeter({ slicerPath: SLICER, tempDir: work, printerPreset: X2D, modelCode: "X2D", manipulator }),
    slice, installedStudio: async () => null,
    preflight: args => preflightCheck(args, { defaultModel: "x2d", validModels: MODELS, askModel: async () => "x2d", meshInfo: file => manipulator.getSTLInfo(file), studioVersion: async () => null, studioInfo: async () => ({}) }),
    openInStudio: async file => { opened.push(file); },
  };
  const progress = [];
  const r = await prepareProject({
    path: source, plateIndex: 0, model: "x2d", partContext: { mold_kind: "rigid" }, maxSlices: 3, maxMinutes: 15, outputDir: path.join(dir, "out"), openInStudio: false, apply: "recommended", dryRun: false,
    onProgress: p => progress.push(p.message),
  }, deps);

  t.diagnostic(`stop ${r.stop.reason} (${r.stop.detail}); slices ${JSON.stringify(r.stop.slices_used)}; verdict ${r.verdict}; ${r.diff.tuning.length} tuned keys; rounds ${r.history.map(h => h.round)}`);
  t.diagnostic(`metrics: ${r.metrics.rows.map(m => `${m.fact} ${m.before} -> ${m.after}`).join("; ")}`);
  assert.deepEqual(fs.readFileSync(source), before, "the source is untouched");
  assert.equal(r.source.unchanged, true);
  assert.deepEqual(opened, [], "open_in_studio false never opens");
  assert.ok(r.stop.slices_used.total <= 3, "the budget includes the STL's retarget slice");
  assert.equal(r.stop.slices_used.retarget, 1);
  assert.ok(progress.length >= 3, "progress is reported: the project, the baseline, round 0");
  assert.ok(r.metrics.rows.some(m => m.fact === "plate.time_s" && m.before > 0 && m.after > 0), "baseline and delivered round were measured");
  assert.ok(["ready", "ready_with_caveats", "not_ready"].includes(r.verdict));

  // the deliverable: a new, unsliced 3MF for the X2D, outside the source's folder
  assert.ok(r.delivered, "a measured round was delivered");
  assert.equal(path.dirname(r.delivered.path), path.join(dir, "out"));
  assert.equal(path.basename(r.delivered.path), "cube_tuned.3mf");
  const zip = await JSZip.loadAsync(fs.readFileSync(r.delivered.path));
  assert.ok(!Object.keys(zip.files).some(name => /^Metadata\/plate_\d+\.gcode/.test(name)), "unsliced: no G-code in the deliverable");
  const config = JSON.parse(await zip.file("Metadata/project_settings.config").async("string"));
  assert.equal(config.printer_settings_id, X2D);
  // Declared as a rigid mold: its relato rules are written by default (the strength ones are hipotese, so only suggestions). With the cube's mesh the
  // ironing and wall-order choices may join them, so the check is that these two are there, from and to.
  const byKey = Object.fromEntries(r.diff.tuning.map(c => [c.key, c]));
  assert.deepEqual([byKey.wall_loops?.from, byKey.wall_loops?.to, byKey.bottom_shell_layers?.from, byKey.bottom_shell_layers?.to], ["2", "4", "3", "5"]);
  assert.equal(byKey.wall_loops.action, "tune.mold.wall-loops-floor");
  assert.equal(config.wall_loops, "4");
  assert.ok(r.suggestions_not_applied.length > 0, "weak rules stay suggestions");
  for (const c of r.diff.tuning.filter(x => x.scope !== "object")) {
    assert.deepEqual([c.to].flat(), [config[c.key]].flat(), `${c.key} carries the tuned value`);
    assert.notEqual(c.reached_slice, false, `${c.key}: the round's own slice used another value than the tuned one`);
    assert.ok(c.confidence && c.src.length && c.rules.length && c.action, `${c.key} says who asked for it and why`);
  }
  assert.ok(r.diff.tuning.every(c => c.verified === false || c.verification.by.length > 0));

  // the deliverable slices again, through the same pipeline, and shows the tuned values in its CONFIG_BLOCK
  const again = await slice(r.delivered.path);
  assert.ok(again.block, "the re-slice has a CONFIG_BLOCK");
  const checks = r.diff.tuning.filter(c => c.scope !== "object").map(c => checkBlockValue(config, again.block, c.key, c.scope));
  for (const c of checks) t.diagnostic(`re-slice ${c.key}: tuned ${JSON.stringify(c.expected)} -> G-code "${c.actual}" (${c.ok === true ? "ok" : c.ok === false ? "MISMATCH" : "unverified"})`);
  assert.deepEqual(checks.filter(c => c.ok === false), [], "no tuned key was ignored by the slicer");
  assert.ok(checks.some(c => c.ok === true), "at least one tuned key is confirmed in the G-code");
});
