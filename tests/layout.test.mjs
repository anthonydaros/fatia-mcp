// src/tuning/layout.ts: the target printer's plate grid, the project's objects with their world boxes and colour classes, and the analysis that finds
// what is wrong (outside, straddling, between plates, overlap, too tall, out of a nozzle's reach, locked plate, bed changed). Synthetic projects, no Studio.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openProject } from "../dist/knowledge/facts/settings.js";
import {
  MAX_LAYOUT_OBJECTS, LayoutLimitError, analyzeLayout, bedChange, classKeyOf, geometryFromConfig, gridColumns, plateOrigin, plateRect, readLayoutModel,
} from "../dist/tuning/layout.js";
import { MeshReadError } from "../dist/tuning/mesh-read.js";
import { buildLayoutProject, gridOrigin, h2dConfig, tiltX, x2dConfig } from "./fixtures/layout-project.mjs";

async function modelOf(t, spec) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "layout-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "p.3mf");
  await fs.writeFile(file, await buildLayoutProject(spec));
  return { file, project: await openProject(file) };
}
const geo = (extra) => geometryFromConfig(x2dConfig(extra));
const issuesOf = (analysis, kind) => analysis.issues.filter(i => i.kind === kind);

test("the plate grid is Studio's: cols = ceil(sqrt(count)), cell = bed x 1.2, origin (col x cellX, -row x cellY)", () => {
  const h2d = geometryFromConfig(h2dConfig());
  assert.deepEqual([h2d.strideX, h2d.strideY], [420, 384], "350 x 320 times 1.2");
  assert.equal(gridColumns(17), 5);
  assert.equal(gridColumns(1), 1);
  assert.equal(gridColumns(4), 2);
  assert.equal(gridColumns(5), 3);
  // the 17-plate H2D sample: plate centres at x = 175 + 420 * col, y = 160 - 384 * row
  for (const i of [0, 1, 4, 5, 16]) {
    const r = plateRect(i, 17, h2d);
    assert.deepEqual([(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2], [175 + 420 * (i % 5), 160 - 384 * Math.floor(i / 5)]);
  }
  const x2d = geo();
  assert.ok(Math.abs(x2d.strideX - 307.2) < 1e-9);
  for (let i = 0; i < 6; i++) assert.deepEqual(plateOrigin(i, 6, x2d), { x: gridOrigin(i, 6).x, y: gridOrigin(i, 6).y }, "agrees with the tests' own arithmetic");
  assert.deepEqual(plateOrigin(5, 6, x2d), { x: 614.4, y: -307.2 }, "6 plates: 3 columns, plate 6 is column 3 of row 2");
  assert.deepEqual(plateOrigin(3, 6, x2d), { x: 0, y: -307.2 });
});

test("geometry: nozzle areas and heights, the filament-to-nozzle map, a bed that is not a rectangle, missing keys", () => {
  const g = geo({ filament_map: ["1", "2"] });
  assert.deepEqual(g.bed, { x0: 0, y0: 0, x1: 256, y1: 256 });
  assert.deepEqual(g.nozzles.map(n => [n.rect.x0, n.rect.x1, n.height]), [[0, 256, 261], [20.5, 256, 256]]);
  assert.deepEqual(g.filamentMap, [0, 1]);
  assert.equal(g.mapMode, "Auto For Flush");
  assert.equal(geometryFromConfig({}), undefined, "no printable_area");
  assert.equal(geometryFromConfig({ printable_area: ["0x0", "0x0", "0x0"] }), undefined, "degenerate");
  const odd = geometryFromConfig({ printable_area: ["0x0", "100x0", "100x100", "0x100"], extruder_printable_area: ["0x0,100x0,50x100,0x100"] });
  assert.match(odd.notes.join(), /not a rectangle/);
  const bare = geometryFromConfig({ printable_area: ["0x0", "100x0", "100x100", "0x100"] });
  assert.equal(bare.nozzles.length, 1);
  assert.equal(bare.height, Infinity, "no height limit is applied, and the geometry says so");
  assert.match(bare.notes.join(), /printable_height/);
});

test("objects: world box from the item transform (tilt included), slots from object and part extruders, painted = its own class", async t => {
  const { project } = await modelOf(t, {
    objects: [
      { id: 2, name: "Tilted", size: [40, 30, 20], at: [50, 60], matrix: tiltX(45), extruder: 1 },
      { id: 4, name: "Multi", size: [10, 10, 10], at: [120, 60], extruder: 1, parts: [1, 2] },
      { id: 6, name: "Painted", size: [10, 10, 10], at: [160, 60], extruder: 2, painted: true },
      { id: 8, name: "Grey", size: [10, 10, 10], at: [200, 60], extruder: 2 },
    ],
    plates: [["2:0", "4:0", "6:0", "8:0"]],
  });
  const model = await readLayoutModel(project);
  const by = Object.fromEntries(model.objects.map(o => [o.name, o]));
  const tilted = by.Tilted;
  assert.ok(Math.abs((tilted.box.x0 + tilted.box.x1) / 2 - 50) < 1e-6 && Math.abs((tilted.box.y0 + tilted.box.y1) / 2 - 60) < 1e-6);
  assert.ok(Math.abs(tilted.box.x1 - tilted.box.x0 - 40) < 1e-6);
  assert.ok(Math.abs(tilted.box.y1 - tilted.box.y0 - (30 + 20) * Math.SQRT1_2) < 1e-6, "the 45 degree tilt widens the depth");
  assert.ok(Math.abs(tilted.box.z0) < 1e-9, "sits on the bed");
  assert.ok(Math.abs(tilted.volume_mm3 - 40 * 30 * 20) < 1e-6, "volume is the mesh's, whatever the tilt");
  assert.deepEqual([tilted.key, tilted.objectId, tilted.instance, tilted.itemIndex, tilted.plates], ["2:0", "2", 0, 0, [0]]);
  assert.deepEqual([by.Multi.slots, by.Multi.classKey], [[1, 2], "1+2"]);
  assert.deepEqual([by.Painted.slots, by.Painted.painted, by.Painted.classKey], [[2], true, "2+paint"]);
  assert.equal(by.Grey.classKey, "2");
  assert.equal(classKeyOf([2, 1], false), "1+2");
});

test("readLayoutModel: no geometry is a MeshReadError, and too many objects is refused before anything else", async t => {
  const { project } = await modelOf(t, { objects: [{ id: 2, name: "A", size: [10, 10, 10], at: [50, 50] }], plates: [["2:0"]] });
  const empty = { ...project, read: async name => (name === "3D/3dmodel.model" ? Buffer.from("<model/>") : project.read(name)) };
  await assert.rejects(readLayoutModel(empty), MeshReadError);
  const many = Array.from({ length: MAX_LAYOUT_OBJECTS + 1 }, (_, i) => ({ id: 2 + 2 * i, name: `O${i}`, size: [1, 1, 1], at: [5, 5] }));
  const big = await modelOf(t, { objects: many, plates: [many.map(o => `${o.id}:0`)] });
  await assert.rejects(readLayoutModel(big.project), LayoutLimitError);
});

test("readLayoutModel refuses more than 500 plates", async t => {
  const { project } = await modelOf(t, { objects: [{ id: 2, name: "A", size: [10, 10, 10], at: [50, 50] }], plates: [["2:0"], ...Array.from({ length: MAX_LAYOUT_OBJECTS }, () => [])], images: false });
  await assert.rejects(readLayoutModel(project), /501 plates/);
});

test("a clean plate: nothing is reported, and the utilisation is the boxes over the bed", async t => {
  const { project } = await modelOf(t, { objects: [{ id: 2, name: "A", size: [100, 100, 50], at: [60, 60] }, { id: 4, name: "B", size: [100, 100, 50], at: [190, 190] }], plates: [["2:0", "4:0"]] });
  const a = analyzeLayout(await readLayoutModel(project), geo(), { minGapMm: 2 });
  assert.equal(a.clean, true);
  assert.deepEqual(a.issues, []);
  assert.deepEqual([a.plates[0].objects, a.plates[0].classes, a.plates[0].utilisation], [["A", "B"], ["1"], 0.31]);
});

test("outside_plate, straddling and between_plates are told apart, with the evidence (which edge, by how much, which plate it stands on)", async t => {
  const o = gridOrigin(1, 4);
  const { project } = await modelOf(t, {
    objects: [
      { id: 2, name: "Home", size: [50, 50, 20], at: [60, 60] },
      { id: 4, name: "OnOther", size: [50, 50, 20], at: [o.x + 60, o.y + 60] }, // belongs to plate 1, stands on plate 2
      { id: 6, name: "Edge", size: [60, 60, 20], at: [240, 128] }, // sticks out of plate 1's right edge by 14 mm
      { id: 8, name: "Gap", size: [20, 20, 20], at: [281.6, 128] }, // in the 51.2 mm gap between plates 1 and 2: touches neither
      { id: 10, name: "Void", size: [20, 20, 20], at: [1500, 1500] },
      { id: 12, name: "Both", size: [90, 20, 20], at: [281.6, 60] }, // reaches both plates, inside neither
    ],
    plates: [["2:0", "4:0", "6:0", "8:0", "10:0", "12:0"], [], [], []],
  });
  const a = analyzeLayout(await readLayoutModel(project), geo(), { minGapMm: 2 });
  const kind = name => a.issues.find(i => i.objects.includes(name))?.kind;
  assert.equal(kind("Home"), undefined);
  assert.equal(kind("OnOther"), "outside_plate");
  assert.equal(a.issues.find(i => i.objects[0] === "OnOther").evidence.standing_on_plate, 2);
  assert.equal(kind("Edge"), "straddling");
  const edge = a.issues.find(i => i.objects[0] === "Edge").evidence;
  assert.deepEqual([edge.beyond.right_mm, edge.beyond.left_mm], [14, 0]);
  assert.equal(kind("Gap"), "outside_plate", "in the gap, standing on no plate");
  assert.equal(a.issues.find(i => i.objects[0] === "Gap").evidence.standing_on_plate, null);
  assert.equal(kind("Void"), "outside_plate");
  assert.equal(kind("Both"), "straddling", "it overlaps its own plate too, so it straddles its edge");
  assert.deepEqual(a.issues.find(i => i.objects[0] === "Both").evidence.also_touches_plates, [2]);
  assert.equal(a.clean, false);
});

test("between_plates: an object of plate 1 that sits half on plate 2 and half in the gap, touching no part of its own plate", async t => {
  const { project } = await modelOf(t, { objects: [{ id: 2, name: "Wedge", size: [60, 20, 20], at: [307.2 - 5, 60] }, { id: 4, name: "Anchor", size: [10, 10, 10], at: [20, 20] }], plates: [["2:0", "4:0"], [], [], []] });
  const a = analyzeLayout(await readLayoutModel(project), geo(), { minGapMm: 2 });
  const wedge = a.issues.find(i => i.objects[0] === "Wedge");
  assert.equal(wedge.kind, "between_plates");
  assert.deepEqual(wedge.evidence.touches_plates, [2]);
});

test("overlap: neighbours closer than the minimum, with the gap; exactly at the minimum is fine", async t => {
  const make = gap => modelOf(t, { objects: [{ id: 2, name: "A", size: [50, 50, 20], at: [60, 60] }, { id: 4, name: "B", size: [50, 50, 20], at: [60 + 50 + gap, 60] }], plates: [["2:0", "4:0"]] });
  const tight = analyzeLayout(await readLayoutModel((await make(5)).project), geo(), { minGapMm: 10 });
  assert.deepEqual(tight.issues.map(i => [i.kind, i.evidence.gap_mm, i.evidence.minimum_mm]), [["overlap", 5, 10]]);
  const ok = analyzeLayout(await readLayoutModel((await make(10)).project), geo(), { minGapMm: 10 });
  assert.deepEqual(ok.issues, []);
  const inter = analyzeLayout(await readLayoutModel((await make(-20)).project), geo(), { minGapMm: 2 });
  assert.ok(inter.issues[0].evidence.gap_mm < 0, "intersecting boxes have a negative gap");
});

test("too_tall uses the lowest height limit of the nozzles the object prints on; outside_nozzle_area uses the nozzle's own area", async t => {
  const { project } = await modelOf(t, {
    objects: [
      { id: 2, name: "Tall1", size: [30, 30, 258], at: [100, 100], extruder: 1 }, // fine for nozzle 1 (261), too tall for nozzle 2 (256)
      { id: 4, name: "Tall2", size: [30, 30, 258], at: [180, 100], extruder: 2 },
      { id: 6, name: "Left", size: [30, 30, 20], at: [15, 200], extruder: 2 }, // x 0..30: inside the bed, outside nozzle 2's reach (x >= 20.5)
      { id: 8, name: "LeftOk", size: [30, 30, 20], at: [15, 150], extruder: 1 },
    ],
    plates: [["2:0", "4:0", "6:0", "8:0"]],
  });
  const g = geo({ filament_map: ["1", "2"] });
  const a = analyzeLayout(await readLayoutModel(project), g, { minGapMm: 2 });
  assert.deepEqual(issuesOf(a, "too_tall").map(i => i.objects[0]), ["Tall2"]);
  assert.deepEqual(issuesOf(a, "too_tall")[0].evidence, { height_mm: 258, limit_mm: 256, nozzles: [2] });
  assert.deepEqual(issuesOf(a, "outside_nozzle_area").map(i => i.objects[0]), ["Left"]);
  assert.deepEqual(issuesOf(a, "outside_nozzle_area")[0].evidence.nozzles, [2]);
});

test("a locked plate is reported and left alone (its objects are not judged); an instance on no plate, or on two, is a plate_assignment error", async t => {
  const { project } = await modelOf(t, {
    objects: [{ id: 2, name: "A", size: [10, 10, 10], at: [50, 50] }, { id: 4, name: "Lost", size: [10, 10, 10], at: [90, 50] }, { id: 6, name: "Twice", size: [10, 10, 10], at: [130, 50] }],
    plates: [["2:0", "6:0"], ["6:0"]], locked: [1],
  });
  const a = analyzeLayout(await readLayoutModel(project), geo(), { minGapMm: 2 });
  assert.deepEqual(issuesOf(a, "locked_plate").map(i => [i.plate, i.severity]), [[1, "warning"]]);
  assert.deepEqual(issuesOf(a, "plate_assignment").map(i => [i.objects[0], i.evidence.plates]).sort(), [["Lost", []], ["Twice", [1, 2]]]);
});

test("bed_changed: the source printer's bed against the target's, with the fix", () => {
  const issue = bedChange(h2dConfig(), geo());
  assert.equal(issue.kind, "bed_changed");
  assert.equal(issue.severity, "warning", "the source bed is larger");
  assert.deepEqual([issue.evidence.source_bed_mm, issue.evidence.target_bed_mm], [[350, 320], [256, 256]]);
  assert.match(issue.fix, /layout: auto/);
  assert.equal(bedChange(x2dConfig(), geo()), undefined, "same bed");
  assert.equal(bedChange(undefined, geo()), undefined);
  assert.equal(bedChange(x2dConfig({ printable_area: ["0x0", "200x0", "200x200", "0x200"] }), geo()).severity, "info", "a smaller source bed cannot push an object off the new plate");
});

test("the 17-plate H2D case on the X2D: every object keeps its H2D world position, so most lie outside their X2D plate", async t => {
  const objects = [];
  const plates = [];
  for (let i = 0; i < 17; i++) {
    const h = { x: 420 * (i % 5), y: -384 * Math.floor(i / 5) };
    objects.push({ id: 2 + 2 * i, name: `Part ${i + 1}`, size: [100, 100, 60], at: [h.x + 175, h.y + 160], extruder: i === 0 ? 1 : 2 });
    plates.push([`${2 + 2 * i}:0`]);
  }
  const { project } = await modelOf(t, { objects, plates, config: x2dConfig({ filament_map: ["1", "1"] }) });
  const model = await readLayoutModel(project);
  const a = analyzeLayout(model, geo(), { minGapMm: 2 });
  // The tests' own arithmetic: object i is inside X2D plate i only if its H2D-grid box fits that plate's rectangle.
  const expected = objects.filter((o, i) => {
    const r = gridOrigin(i, 17);
    const [cx, cy] = o.at;
    return !(cx - 50 >= r.x && cx + 50 <= r.x + 256 && cy - 50 >= r.y && cy + 50 <= r.y + 256);
  }).length;
  assert.ok(expected >= 12, "the premise: most are off");
  assert.equal(a.issues.filter(i => ["outside_plate", "straddling", "between_plates"].includes(i.kind)).length, expected);
  assert.equal(a.plates.length, 17);
});
