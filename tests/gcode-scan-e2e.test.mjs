// The scanner on G-code the real Bambu Studio CLI (headless) just produced, for the roles no sample file had shown: a mushroom (a plate on a
// stem, a 90 degree overhang) sliced with tree support, brim and ironing, and again with all three off. Skipped when the CLI is absent or on CI.
// Two slices per case (the baseline project of the writer's retarget, then the delivered project), a few seconds each.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSafe3mfArchive } from "../dist/safety/archive.js";
import { STLManipulator } from "../dist/stl/stl-manipulator.js";
import { scanPlateGcode } from "../dist/tuning/gcode-scan.js";
import { writeTunedProject } from "../dist/tuning/project-writer.js";
import { studioRetargeter } from "../dist/tuning/retarget.js";

const CANDIDATES = [process.env.SLICER_PATH, "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio", "C:\\Program Files\\Bambu Studio\\bambu-studio.exe"];
const SLICER = CANDIDATES.find(candidate => candidate && fs.existsSync(candidate));
const SKIP = process.env.CI ? "CI" : !SLICER ? "Bambu Studio CLI not installed" : false;
const X2D = "Bambu Lab X2D 0.4 nozzle";

function mushroomStl() {
  const box = (x0, y0, z0, x1, y1, z1) => {
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    return [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]].map(t => t.map(i => v[i]));
  };
  const facets = [...box(-5, -5, 0, 5, 5, 10), ...box(-25, -25, 10, 25, 25, 14)];
  return `solid m\n${facets.map(t => ` facet normal 0 0 0\n  outer loop\n${t.map(p => `   vertex ${p.join(" ")}\n`).join("")}  endloop\n endfacet\n`).join("")}endsolid m\n`;
}
/** Slice the mushroom with `changes` through the writer and the keep pipeline; scan plate 1 of the sliced project. */
async function sliceAndScan(t, changes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-e2e-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stl = path.join(dir, "mushroom.stl");
  fs.writeFileSync(stl, mushroomStl());
  const work = path.join(dir, "work");
  const written = await writeTunedProject({
    source: stl, output: path.join(dir, "out", "mushroom.3mf"), target: { printerPreset: X2D },
    changes: changes.map(([key, value]) => ({ key, value, scope: "process" })),
    retarget: studioRetargeter({ slicerPath: SLICER, tempDir: work, printerPreset: X2D, modelCode: "X2D" }),
  });
  const manipulator = new STLManipulator(work);
  const projectPlan = await manipulator.planProjectSettings(written.path, SLICER, X2D, "X2D");
  const sliced = await manipulator.sliceSTL(written.path, "bambustudio", SLICER, undefined, undefined, X2D, { projectPlan });
  const scan = await scanPlateGcode(sliced, 0);
  const zip = await loadSafe3mfArchive(fs.readFileSync(sliced));
  const text = await zip.file("Metadata/plate_1.gcode").async("string");
  return { scan, text };
}

test("support, brim and ironing: the labels Studio really writes are the ones the scan counts", { skip: SKIP, timeout: 300000 }, async t => {
  const { scan, text } = await sliceAndScan(t, [["enable_support", "1"], ["support_type", "tree(auto)"], ["brim_type", "outer_only"], ["brim_width", "5"], ["ironing_type", "top"]]);
  const labels = new Set([...text.matchAll(/^; FEATURE: (.*)$/gm)].map(m => m[1].trim()));
  t.diagnostic(`FEATURE labels in the real G-code: ${[...labels].sort().join(", ")}`);
  for (const label of ["Support", "Support interface", "Brim", "Ironing"]) assert.ok(labels.has(label), `Studio wrote '${label}'`);
  assert.deepEqual(scan.details.unknownFeatures, []);
  assert.equal(scan.complete, true);
  const f = scan.facts;
  assert.equal(f["gcode.first_layer_brim_present"], true);
  assert.ok(f["gcode.support_line_count"] > 0 && f["gcode.support_interface_line_count"] > 0);
  assert.ok(f["gcode.support_interface_line_count"] < f["gcode.support_line_count"]);
  assert.ok(f["gcode.support_weight_g"] > 0);
  assert.ok(f["gcode.ironing_line_count"] > 0);
  assert.equal(f["gcode.tower_g"], 0); // enable_prime_tower = 0 in the file's own config
  assert.equal(typeof f["gcode.unprotected_travels_in_support"], "number");
  // the scan's own totals against the header the Studio wrote
  assert.equal(f["gcode.layer_count"], scan.details.header.layers);
  assert.ok(Math.abs(f["gcode.extruded_weight_g"] - scan.details.header.weightG) < 0.05, `${f["gcode.extruded_weight_g"]} g vs header ${scan.details.header.weightG} g`);
  t.diagnostic(`support ${f["gcode.support_line_count"]} segments (${f["gcode.support_interface_line_count"]} interface, ${f["gcode.support_weight_g"]} g), ironing ${f["gcode.ironing_line_count"]}, unprotected ${f["gcode.unprotected_travel_count"]}, in support ${f["gcode.unprotected_travels_in_support"]}`);
});

test("support, brim and ironing off: a known zero from the file's own config, not from a missing label", { skip: SKIP, timeout: 300000 }, async t => {
  const { scan } = await sliceAndScan(t, [["enable_support", "0"], ["brim_type", "no_brim"], ["ironing_type", "no ironing"]]);
  const f = scan.facts;
  assert.equal(scan.complete, true);
  assert.equal(f["gcode.support_line_count"], 0);
  assert.equal(f["gcode.support_interface_line_count"], 0);
  assert.equal(f["gcode.ironing_line_count"], 0);
  assert.equal(f["gcode.first_layer_brim_present"], false);
  assert.match(scan.evidence["gcode.support_line_count"].notes, /enable_support = 0/);
  assert.equal(f["gcode.layer_count"], scan.details.header.layers);
});
