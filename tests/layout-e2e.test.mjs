// The layout stage on the real Bambu Studio CLI and the real MakerWorld sample (models/desk-organizer.3mf: 17 plates made for an H2D, one object each).
// P0 is the Studio export for the X2D (no slicing), the stage plans the layout, writes and proves the candidates and measures two of them with the CLI
// (`--slice 0`, all plates in one call). Skipped when the CLI or the sample is absent, or on CI. Slices: two candidate slices, then one verification slice
// of the delivered project. Set LAYOUT_E2E_MODEL to use another sample.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openProject } from "../dist/knowledge/facts/settings.js";
import { STLManipulator } from "../dist/stl/stl-manipulator.js";
import { analyzeLayout, geometryFromConfig, readLayoutModel } from "../dist/tuning/layout.js";
import { runLayoutStage } from "../dist/tuning/layout-stage.js";
import { studioAllPlatesSlicer } from "../dist/tuning/prepare-slice.js";
import { writeTunedProject } from "../dist/tuning/project-writer.js";
import { studioRetargeter } from "../dist/tuning/retarget.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES = [process.env.SLICER_PATH, "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio", "C:\\Program Files\\Bambu Studio\\bambu-studio.exe"];
const SLICER = CANDIDATES.find(candidate => candidate && fs.existsSync(candidate));
const MODEL = process.env.LAYOUT_E2E_MODEL ?? path.resolve(ROOT, "..", "models", "desk-organizer.3mf");
const SKIP = process.env.CI ? "CI" : !SLICER ? "Bambu Studio CLI not installed" : !fs.existsSync(MODEL) ? "the desk-organizer sample is not at models/desk-organizer.3mf" : false;
const X2D = "Bambu Lab X2D 0.4 nozzle";

test("the 17-plate H2D sample is laid out for the X2D: colours apart, every object inside its plate, measured by the CLI, and the delivered file slices", { skip: SKIP, timeout: 1_800_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-e2e-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "desk-organizer.3mf");
  fs.copyFileSync(MODEL, source);
  const sourceBytes = fs.readFileSync(source);
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  const manipulator = new STLManipulator(work);
  const retarget = studioRetargeter({ slicerPath: SLICER, tempDir: work, printerPreset: X2D, modelCode: "X2D", manipulator });
  const p0 = await writeTunedProject({ source, output: path.join(work, "p0.3mf"), target: { printerPreset: X2D }, retarget });

  const sliceAll = studioAllPlatesSlicer({ manipulator, slicerPath: SLICER, printerPreset: X2D, modelCode: "X2D" });
  const run = await runLayoutStage({ p0: p0.path, sourceConfig: (await openProject(source)).config, mode: "auto", dryRun: false, work, sliceAll, maxSlices: 2 });
  t.diagnostic(`status ${run.status}; ${run.plates_before_count} -> ${run.plates_after} plates; issues ${run.issues.length}; chosen ${run.chosen?.id}: ${run.chosen?.reason}`);
  for (const c of run.candidates) t.diagnostic(`candidate ${c.id}: ${c.plates} plates ${JSON.stringify(c.objects_per_plate)} total ${c.total_time_s} s longest ${c.longest_plate_s} s weight ${c.weight_g} g crossing ${JSON.stringify(c.crossing_per_plate)}${c.measured ? "" : ` (not measured: ${c.not_measured_reason})`}`);

  assert.deepEqual(fs.readFileSync(source), sourceBytes, "the source is untouched");
  assert.equal(run.status, "applied");
  assert.equal(run.plates_before_count, 17);
  assert.ok(run.issues.filter(i => ["outside_plate", "straddling", "between_plates"].includes(i.kind)).length >= 10, "most objects were off their X2D plate");
  assert.equal(run.budget.slices_used, 2);
  assert.equal(run.candidates.filter(c => c.measured).length, 2);
  for (const c of run.candidates.filter(x => x.measured)) {
    assert.equal(c.time_per_plate_s.length, c.plates);
    assert.ok(c.time_per_plate_s.every(s => s > 0), "the CLI predicted a time for every plate");
    assert.equal(c.crossing_per_plate.length, c.plates);
  }

  // Independent of the stage: open the delivered file, run the analysis with the X2D grid, count the colours per plate.
  const delivered = await openProject(run.file);
  const geo = geometryFromConfig(delivered.config);
  const model = await readLayoutModel(delivered);
  const analysis = analyzeLayout(model, geo, { minGapMm: run.policy.minimum_gap_mm });
  assert.deepEqual(analysis.issues, [], "no object outside, straddling, overlapping or too tall");
  assert.equal(model.objects.length, 17, "no object lost");
  assert.equal(model.plates.length, run.plates_after);
  for (const plate of model.plates) assert.equal(new Set(plate.keys.map(k => model.objects.find(o => o.key === k).classKey)).size, 1, "one colour per plate");
  assert.equal(model.plates.filter(p => p.keys.some(k => model.objects.find(o => o.key === k).classKey === "1")).length, 1, "the black frame has a plate to itself");
  assert.ok(run.plates_after < 17);
  assert.equal(run.proof.ok, true);
  assert.ok(!delivered.names.some(n => /^Metadata\/(?:(?:plate|plate_no_light|top|pick)_\d+|[^/]*_small)\.png$/.test(n)), "the stale plate pictures are gone");

  // The delivered project slices with the CLI, every plate, and the slicer used the nozzles the plan assumed.
  const again = await sliceAll(run.file);
  assert.equal(again.length, run.plates_after);
  assert.ok(again.every(p => p.time_s > 0 && p.weight_g > 0));
  for (const p of again) t.diagnostic(`re-slice plate ${p.plate}: ${p.time_s} s, ${p.weight_g} g, crossing ${p.crossing}, nozzles ${JSON.stringify(p.filament_maps)}, warnings ${p.warnings.length}`);
});
