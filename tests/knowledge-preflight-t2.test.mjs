// preflight_check tier 2: box and count facts per plate, project flags, the volume / tower / cut blockers, and the accounting.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { openProject } from "../dist/knowledge/facts/settings.js";
import { sliceProvider } from "../dist/knowledge/facts/slice.js";
import { fitsVolume, structureProvider, UNCONFIRMED_FACTS } from "../dist/knowledge/facts/structure.js";
import { getKb } from "../dist/knowledge/loader.js";
import { factTier, preflightCheck } from "../dist/knowledge/preflight.js";
import { KNOWLEDGE_TOOLS } from "../dist/knowledge/tools.js";
import { STLManipulator } from "../dist/stl/stl-manipulator.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_KB_DIR = process.env.BAMBU_KB_DIR;
process.env.BAMBU_KB_DIR = path.join(ROOT, "knowledge");
test.after(() => { if (REAL_KB_DIR === undefined) delete process.env.BAMBU_KB_DIR; else process.env.BAMBU_KB_DIR = REAL_KB_DIR; });

const MODELS = ["p1s", "x1c", "a1", "a1mini", "h2d", "h2s", "h2c", "x2d"];
const SAMPLE = process.env.BAMBU_SAMPLE_3MF || path.join(ROOT, "..", "models", "desk-organizer.3mf"); // the user's MakerWorld H2D project; skipped when absent

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight t2 "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Settings of an X2D project that fire nothing; tests override the keys they care about. */
const BASE = {
  printer_model: "Bambu Lab X2D", nozzle_diameter: ["0.4", "0.4"], printable_area: ["0x0", "256x0", "256x256", "0x256"], printable_height: "261",
  filament_type: ["PLA", "PLA"], filament_settings_id: ["Bambu PLA Basic @BBL X2D", "Bambu PLA Basic @BBL X2D"], curr_bed_type: "Textured PEI Plate",
  z_hop: ["0.4", "0.4"], z_hop_types: ["Normal Lift", "Normal Lift"], layer_height: "0.2", enable_support: "0", enable_prime_tower: "1", print_sequence: "by layer",
};

function boxObject(id, [x, y, z], paint = "") {
  const v = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
  const tri = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return `<object id="${id}" type="model"><mesh><vertices>${v.map(([a, b, c]) => `<vertex x="${a}" y="${b}" z="${c}"/>`).join("")}</vertices>`
    + `<triangles>${tri.map(([a, b, c], i) => `<triangle v1="${a}" v2="${b}" v3="${c}"${i === 0 ? paint : ""}/>`).join("")}</triangles></mesh></object>`;
}

/**
 * A 3MF with real geometry. item: { size, matrix?, parts?, printable?, of?, layerHeight?, overrides?, extruder?, paint? }
 * (parts = sizes of separate component meshes, of = build index of the object this item is another instance of);
 * plates: build indices per plate; file extras: { designer, files: {name: text}, sliced: [[seconds, grams]] }.
 */
async function geometry(t, { items, plates, config = {}, extras = {}, name = "part.3mf" }) {
  const zip = new JSZip();
  const objects = [], build = [], settings = [], instance = new Map();
  items.forEach((item, i) => {
    const oid = item.of === undefined ? i + 1 : item.of + 1;
    const n = instance.get(oid) ?? 0;
    instance.set(oid, n + 1);
    instance.set(`item${i}`, [oid, n]);
    if (item.of === undefined) {
      if (item.parts) {
        item.parts.forEach((part, k) => zip.file(`3D/Objects/o${oid}_${k}.model`, `<model><resources>${boxObject(k + 1, part.size ?? part)}</resources></model>`));
        objects.push(`<object id="${oid}" type="model"><components>${item.parts.map((part, k) => `<component p:path="/3D/Objects/o${oid}_${k}.model" objectid="${k + 1}" transform="1 0 0 0 1 0 0 0 1 ${part.dx ?? k * 500} 0 0"/>`).join("")}</components></object>`);
      } else {
        objects.push(boxObject(oid, item.size, item.paint));
      }
      const meta = Object.entries({ ...(item.layerHeight ? { layer_height: item.layerHeight } : {}), ...item.overrides }).map(([k, v]) => `<metadata key="${k}" value="${v}"/>`).join("");
      settings.push(`<object id="${oid}"><metadata key="name" value="o${oid}"/><metadata key="extruder" value="${item.extruder ?? 1}"/>${meta}${(item.parts ?? [{}]).map((part, k) => `<part id="${item.parts ? k + 1 : 1}" subtype="${part.subtype ?? "normal_part"}"><metadata key="name" value="p"/><metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>${k === 0 ? item.partOverrides ?? "" : ""}</part>`).join("")}</object>`);
    }
    build.push(`<item objectid="${oid}" transform="${item.matrix ?? "1 0 0 0 1 0 0 0 1"} ${i * 700} 0 0" printable="${item.printable === false ? 0 : 1}"/>`);
  });
  const head = extras.designer ? `<metadata name="Designer">${extras.designer}</metadata><metadata name="Origin">profile</metadata>` : `<metadata name="Designer" /><metadata name="Origin" />`;
  zip.file("3D/3dmodel.model", `<?xml version="1.0"?><model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">${head}<resources>${objects.join("")}</resources><build>${build.join("")}</build></model>`);
  const plateXml = (plates ?? []).map((list, p) => `<plate><metadata key="plater_id" value="${p + 1}"/>${list.map((i) => {
    const [oid, n] = instance.get(`item${i}`);
    return `<model_instance><metadata key="object_id" value="${oid}"/><metadata key="instance_id" value="${n}"/></model_instance>`;
  }).join("")}</plate>`).join("");
  zip.file("Metadata/model_settings.config", `<?xml version="1.0"?><config>${settings.join("")}${plateXml}</config>`);
  zip.file("Metadata/project_settings.config", JSON.stringify({ ...BASE, ...config }));
  const sliced = (extras.sliced ?? []).map(([s, g], p) => `<plate><metadata key="index" value="${p + 1}"/><metadata key="prediction" value="${s}"/><metadata key="weight" value="${g}"/></plate>`).join("");
  zip.file("Metadata/slice_info.config", `<?xml version="1.0"?><config><header><header_item key="X-BBL-Client-Version" value="02.08.04.57"/></header>${sliced}</config>`);
  for (const [file, text] of Object.entries(extras.files ?? {})) zip.file(file, text);
  const file = path.join(scratch(t), name);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return file;
}

const deps = (extra = {}) => ({
  defaultModel: "x2d", validModels: MODELS,
  askModel: async () => { throw new Error("must not ask"); },
  meshInfo: (file) => new STLManipulator(os.tmpdir()).getSTLInfo(file),
  studioVersion: async () => "02.08.04.57", studioInfo: async () => ({ changed_since_last_seen: false }),
  ...extra,
});
const run = (file, args = {}, extra = {}) => preflightCheck({ file_path: file, ...args }, deps(extra));
const ids = (r) => r.findings.map((f) => f.rule_id);
const find = (r, id) => r.findings.find((f) => f.rule_id === id);
const reasons = (r) => Object.keys(r.unchecked.by_reason).join(" | ");
const sum = (a) => a.findings + a.checklist + a.not_fired + a.unchecked + a.hidden;

/** Facts of the structure provider for a file, as preflight would ask for them. */
async function facts(file, names, { plateIndex = 0, target = "x2d", kind = "3mf" } = {}) {
  const project = kind === "3mf" ? await openProject(file) : undefined;
  return structureProvider.collect({ filePath: file, kind, meshInfo: deps().meshInfo, project, plateIndex, targetPrinter: target, installedStudio: async () => null }, names);
}
const BOX = ["mesh.size_x_mm", "mesh.size_y_mm", "mesh.height_mm", "mesh.max_object_height_mm", "mesh.footprint_area_mm2", "mesh.height_to_footprint", "mesh.bbox_max_dim_mm", "mesh.exceeds_build_volume", "mesh.triangle_count"];

test("box facts describe the objects of the chosen plate, not the whole project", async (t) => {
  const file = await geometry(t, {
    items: [{ size: [40, 30, 20] }, { size: [200, 100, 50] }, { size: [10, 10, 80] }], plates: [[0], [1, 2]],
  });
  const first = await facts(file, BOX);
  assert.deepEqual(first, {
    "mesh.size_x_mm": 40, "mesh.size_y_mm": 30, "mesh.height_mm": 20, "mesh.max_object_height_mm": 20, "mesh.footprint_area_mm2": 1200,
    "mesh.height_to_footprint": 0.577, "mesh.bbox_max_dim_mm": 40, "mesh.exceeds_build_volume": false, "mesh.triangle_count": 12,
  });
  const second = await facts(file, BOX, { plateIndex: 1 });
  assert.equal(second["mesh.size_x_mm"], 200, "largest object of plate 2");
  assert.equal(second["mesh.height_mm"], 80, "tallest object of plate 2");
  assert.equal(second["mesh.footprint_area_mm2"], 100, "the smallest footprint of the plate");
  assert.equal(second["mesh.height_to_footprint"], 8, "the tallest-for-its-base object (80 over a 10 x 10 base)");
  assert.equal(second["mesh.triangle_count"], 24);
  assert.deepEqual(await facts(file, BOX, { plateIndex: 5 }), {}, "a plate the file does not have: nothing is guessed");
});

test("build item transforms count (a quarter turn swaps Y and Z), component meshes of one object are one box, non-printable items are skipped", async (t) => {
  const file = await geometry(t, {
    items: [{ size: [10, 20, 30], matrix: "1 0 0 0 0 1 0 -1 0" }, { parts: [[10, 10, 10], [20, 20, 20]] }, { size: [999, 999, 999], printable: false }],
    plates: [[0, 1, 2]],
  });
  const f = await facts(file, BOX);
  assert.equal(f["mesh.size_y_mm"], 30, "the 20 mm side now stands up and the 30 mm side lies along Y: y=30, z=20");
  assert.equal(f["mesh.size_x_mm"], 520, "x of the two-part object: part 2 (20 wide) starts 500 mm to the right of part 1, one box");
  assert.equal(f["mesh.height_mm"], 20);
  assert.equal(f["mesh.triangle_count"], 12 + 24, "the non-printable item adds nothing");
});

test("two instances of one object on different plates map to their own plate; a file with no plates is one plate", async (t) => {
  const file = await geometry(t, { items: [{ size: [10, 10, 10] }, { of: 0, size: [0, 0, 0] }, { size: [50, 50, 50] }], plates: [[0], [1, 2]] });
  assert.equal((await facts(file, ["mesh.size_x_mm", "mesh.triangle_count"], { plateIndex: 0 }))["mesh.triangle_count"], 12);
  const second = await facts(file, ["mesh.size_x_mm", "mesh.triangle_count"], { plateIndex: 1 });
  assert.deepEqual(second, { "mesh.size_x_mm": 50, "mesh.triangle_count": 24 }, "instance 1 of object 1 and object 3");
  const flat = await geometry(t, { items: [{ size: [10, 10, 10] }, { size: [30, 5, 5] }] });
  assert.equal((await facts(flat, ["mesh.size_x_mm"]))["mesh.size_x_mm"], 30);
});

test("fitsVolume: faces down, footprint turned about Z (Carver); cross-checked against a brute-force rotation sweep", () => {
  const volume = [256, 256, 260];
  assert.equal(fitsVolume([200, 200, 200], volume), true);
  assert.equal(fitsVolume([300, 300, 10], volume), false);
  assert.equal(fitsVolume([300, 20, 10], volume), true, "a long part lies diagonally");
  assert.equal(fitsVolume([20, 20, 300], volume), true, "a tall part lies down");
  assert.equal(fitsVolume([360, 10, 10], volume), false, "longer than the bed diagonal allows");
  assert.equal(fitsVolume([100, 100, 261], volume), true, "261 stands the other way");
  assert.equal(fitsVolume([300, 300, 300], volume), false);
  // Reference: try every face down, and every turn of the footprint about Z in 0.02 degree steps.
  const turns = (p, q, a, b) => { for (let d = 0; d <= 90; d += 0.02) { const r = d * Math.PI / 180; if (p * Math.cos(r) + q * Math.sin(r) <= a + 1e-9 && p * Math.sin(r) + q * Math.cos(r) <= b + 1e-9) return true; } return false; };
  const reference = (size, [a, b, c]) => [0, 1, 2].some((down) => size[down] <= c && turns(...size.filter((_, i) => i !== down), a, b));
  let seed = 7;
  const rnd = (lo, hi) => { seed = (seed * 16807) % 2147483647; return lo + (seed / 2147483647) * (hi - lo); };
  let fit = 0;
  for (let i = 0; i < 400; i++) {
    const size = [rnd(5, 380), rnd(5, 380), rnd(5, 300)], vol = [rnd(200, 300), rnd(100, 250), 260];
    const want = reference(size, vol);
    fit += want;
    assert.equal(fitsVolume(size, vol), want, `${size} in ${vol}`);
  }
  assert.ok(fit > 40 && fit < 360, `the sample has both outcomes (${fit} fit)`);
});

test("blocker bambu.x2d.main-volume-exceeded: fires above 256 x 256 x 261, silent below; a project made for another printer is judged for the target", async (t) => {
  const rule = "bambu.x2d.main-volume-exceeded";
  const big = await run(await geometry(t, { items: [{ size: [300, 100, 50] }], plates: [[0]] }));
  const finding = find(big, rule);
  assert.ok(finding, ids(big).join(", "));
  assert.equal(finding.severity, "blocker");
  assert.equal(finding.confidence, "preset");
  assert.deepEqual(finding.evidence, { "printer.model": "Bambu Lab X2D", "mesh.size_x_mm": 300, "mesh.size_y_mm": 100, "mesh.height_mm": 50 });
  assert.equal(big.findings[0].severity, "blocker", "blockers first");
  assert.ok(!ids(await run(await geometry(t, { items: [{ size: [256, 256, 261] }], plates: [[0]] }))).includes(rule), "exactly the limit fits");
  assert.ok(ids(await run(await geometry(t, { items: [{ size: [100, 100, 262] }], plates: [[0]] }))).includes(rule), "262 mm tall");
  assert.ok(ids(await run(await geometry(t, { items: [{ size: [100, 257, 10] }], plates: [[0]] }))).includes(rule), "257 mm deep");
  const h2d = await geometry(t, { items: [{ size: [300, 100, 50] }], plates: [[0]], config: { printer_model: "Bambu Lab H2D", printable_area: ["0x0", "350x0", "350x320", "0x320"], printable_height: "325" } });
  assert.ok(ids(await run(h2d)).includes(rule), "an H2D project sliced for the X2D must be judged by the X2D");
  assert.ok(!ids(await run(h2d, { bambu_model: "h2d" })).includes(rule), "the H2D rule set does not include it");
});

test("modifier, negative and support-blocker volumes are not part of the object: only normal parts are sized and counted", async (t) => {
  const rules = ["bambu.x2d.main-volume-exceeded", "bambu.cut.exceeds-build-volume"];
  const names = ["mesh.size_x_mm", "mesh.size_y_mm", "mesh.height_mm", "mesh.triangle_count"];
  const model = { size: [100, 100, 100], dx: 0 };
  for (const [subtype, size] of [["support_blocker", [100, 100, 400]], ["modifier_part", [300, 300, 50]], ["negative_part", [300, 40, 40]], ["support_enforcer", [100, 100, 400]]]) {
    const file = await geometry(t, { items: [{ parts: [model, { size, subtype, dx: 0 }] }], plates: [[0]] });
    assert.deepEqual(await facts(file, names), { "mesh.size_x_mm": 100, "mesh.size_y_mm": 100, "mesh.height_mm": 100, "mesh.triangle_count": 12 }, subtype);
    const result = await run(file, { min_severity: "tip" });
    for (const rule of rules) assert.ok(!ids(result).includes(rule), `${subtype} must not trigger ${rule}`);
  }
  const apart = await geometry(t, { items: [{ parts: [model, { size: [100, 100, 100], dx: 200 }, { size: [100, 100, 400], subtype: "support_blocker", dx: 0 }] }], plates: [[0]] });
  assert.equal((await facts(apart, names))["mesh.size_x_mm"], 300, "two normal parts 200 mm apart are one 300 mm object");
  assert.ok(ids(await run(apart)).includes("bambu.x2d.main-volume-exceeded"), "and that one does not fit");
});

test("blocker bambu.cut.exceeds-build-volume: no orientation fits; shows the box and the volume it was judged against", async (t) => {
  const rule = "bambu.cut.exceeds-build-volume";
  const result = await run(await geometry(t, { items: [{ size: [300, 300, 10] }], plates: [[0]] }));
  const finding = find(result, rule);
  assert.ok(finding, ids(result).join(", "));
  assert.equal(finding.confidence, "hipotese");
  assert.deepEqual(finding.evidence, { "mesh.exceeds_build_volume": true, "mesh.size_x_mm": 300, "mesh.size_y_mm": 300, "mesh.height_mm": 10, "printer.build_volume_mm": [256, 256, 261] });
  for (const size of [[300, 20, 10], [20, 20, 300], [255, 255, 260]]) {
    const fits = await run(await geometry(t, { items: [{ size }], plates: [[0]] }));
    assert.ok(!ids(fits).includes(rule), `${size} fits in some orientation`);
  }
  const tall = await run(await geometry(t, { items: [{ size: [20, 20, 300] }], plates: [[0]] }));
  assert.ok(ids(tall).includes("bambu.x2d.main-volume-exceeded"), "but it is too tall in the current orientation");
  const other = await geometry(t, { items: [{ size: [200, 200, 10] }], plates: [[0]], config: { printer_model: "Bambu Lab A1 mini", printable_area: ["0x0", "180x0", "180x180", "0x180"], printable_height: "180" } });
  assert.ok(ids(await run(other)).includes(rule) === false, "the X2D volume is used, not the file's A1 mini one");
  assert.ok(ids(await run(other, { bambu_model: "a1mini" })).includes(rule), "for an A1 mini target the file's own 180 mm volume applies");
});

test("blocker bambu.a1.volume-exceeded: fires for an A1 target, is hidden for the X2D", async (t) => {
  const rule = "bambu.a1.volume-exceeded";
  const file = await geometry(t, { items: [{ size: [300, 100, 50] }], plates: [[0]], config: { printer_model: "Bambu Lab A1", printable_area: ["0x0", "256x0", "256x256", "0x256"], printable_height: "256" } });
  const a1 = await run(file, { bambu_model: "a1" });
  const finding = find(a1, rule);
  assert.ok(finding, ids(a1).join(", "));
  assert.equal(finding.confidence, "relato");
  assert.equal(finding.evidence["mesh.size_x_mm"], 300);
  const small = await geometry(t, { items: [{ size: [250, 100, 50] }], plates: [[0]], config: { printer_model: "Bambu Lab A1" } });
  assert.ok(!ids(await run(small, { bambu_model: "a1" })).includes(rule));
  const x2d = await run(file);
  assert.ok(!ids(x2d).includes(rule) && !reasons(x2d).includes("a1.volume"), "hidden by the printer, not reported");
  assert.ok(x2d.hidden.other_printers > 0);
});

test("blocker bambu.tower.layer-height-mismatch: two filaments, tower on, objects with different layer heights", async (t) => {
  const rule = "bambu.tower.layer-height-mismatch";
  const two = (a, b, config = {}, extra = {}) => geometry(t, { items: [{ size: [20, 20, 20], layerHeight: a, extruder: 1 }, { size: [20, 20, 20], layerHeight: b, extruder: 2 }], plates: [[0, 1]], config, ...extra });
  const result = await run(await two("0.1", "0.2"));
  const finding = find(result, rule);
  assert.ok(finding, ids(result).join(", "));
  assert.equal(finding.severity, "blocker");
  assert.deepEqual(finding.evidence, { "project.filament_count": 2, "settings.enable_prime_tower": "1", "project.layer_heights_differ": true });
  assert.ok(ids(await run(await two("0.1", undefined))).includes(rule), "one overrides, the other uses the project's 0.2");
  assert.ok(!ids(await run(await two("0.2", "0.2"))).includes(rule), "same height");
  assert.ok(!ids(await run(await two(undefined, undefined))).includes(rule), "no overrides");
  assert.ok(!ids(await run(await two("0.1", "0.2", { enable_prime_tower: "0" }))).includes(rule), "no tower");
  const single = await geometry(t, { items: [{ size: [20, 20, 20], layerHeight: "0.1" }, { size: [20, 20, 20] }], plates: [[0, 1]] });
  assert.ok(!ids(await run(single)).includes(rule), "one filament: no tower is built");
  const apart = await geometry(t, { items: [{ size: [20, 20, 20], layerHeight: "0.1", extruder: 1 }, { size: [20, 20, 20], extruder: 2 }], plates: [[0], [1]] });
  assert.ok(!ids(await run(apart, { plate_index: 0 })).includes(rule), "the other object is on another plate");
  // A variable layer height profile is not read: with no override that differs the answer is unknown, never "same".
  const profile = await two("0.2", "0.2", {}, { extras: { files: { "Metadata/layer_heights_profile.txt": "object_id=1|0 0.2" } } });
  const variable = await run(profile);
  assert.ok(!ids(variable).includes(rule));
  assert.match(reasons(variable), /fato ausente no 3MF: project\.layer_heights_differ/);
});

test("blocker bambu.x2d.aux-volume-exceeded stays unknown: the 3MF key for the auxiliary nozzle is not confirmed", async (t) => {
  const rule = "bambu.x2d.aux-volume-exceeded";
  assert.ok(UNCONFIRMED_FACTS.has("object.uses_aux_nozzle") && !structureProvider.provides("object.uses_aux_nozzle"));
  const oversize = await run(await geometry(t, { items: [{ size: [240, 100, 50] }], plates: [[0]] }));
  assert.ok(!ids(oversize).includes(rule), "240 mm is over the auxiliary 235.5 mm but it is unknown which nozzle prints it");
  assert.ok(oversize.unchecked.by_reason["chave do 3MF ainda nao confirmada numa X2D real: object.uses_aux_nozzle"] >= 1, reasons(oversize));
  const small = await run(await geometry(t, { items: [{ size: [100, 100, 50] }], plates: [[0]] }));
  assert.ok(small.accounting.not_fired > 0 && !reasons(small).includes("object.uses_aux_nozzle"), "an object that fits is false whichever nozzle prints it");
  for (const fact of ["project.nozzle2_used", "project.ams_type", "project.has_cut_objects", "project.aux_nozzle_filament_types"]) assert.ok(UNCONFIRMED_FACTS.has(fact), fact);
});

test("blocker blender.cut.part-exceeds-bed is a Blender rule: it stays unchecked, whatever the part measures", async (t) => {
  const result = await run(await geometry(t, { items: [{ size: [600, 600, 600] }], plates: [[0]] }));
  assert.ok(!ids(result).includes("blender.cut.part-exceeds-bed"));
  assert.ok(result.unchecked.by_reason["sonda do Blender não implementada no preflight; instalar a ponte não habilita estes checks"] >= 107);
  assert.ok(factTier("mesh.bbox_max_dim_mm") === 2 && factTier("printer.bed_size_mm") === 2, "its facts are cheap: only the domain keeps it back");
});

test("an STL or OBJ is judged against the resolved printer's bed (MACHINE_LIMITS); an unknown printer is unchecked", async (t) => {
  const dir = scratch(t);
  const stl = (name, [x, y, z]) => {
    const file = path.join(dir, name);
    const facet = (a, b, c) => `facet normal 0 0 1\nouter loop\n${[a, b, c].map((p) => `vertex ${p.join(" ")}`).join("\n")}\nendloop\nendfacet\n`;
    fs.writeFileSync(file, `solid s\n${facet([0, 0, 0], [x, 0, 0], [x, y, z])}${facet([0, 0, 0], [x, y, z], [0, y, 0])}endsolid s\n`);
    return file;
  };
  const rule = "bambu.x2d.main-volume-exceeded";
  const big = await run(stl("big.stl", [300, 50, 40]));
  assert.ok(ids(big).includes(rule), ids(big).join(", "));
  assert.deepEqual(find(big, rule).evidence, { "printer.model": "Bambu Lab X2D", "mesh.size_x_mm": 300, "mesh.size_y_mm": 50, "mesh.height_mm": 40 });
  assert.ok(!ids(await run(stl("ok.stl", [200, 50, 40]))).includes(rule));
  assert.ok(ids(big).includes("bambu.cut.exceeds-build-volume") === false, "it lies diagonally");
  assert.ok(big.unchecked.by_reason["STL sem ajustes: fatie ou envie o 3MF do projeto"] > 20, "settings facts still need the 3MF");
  assert.deepEqual(await facts(stl("tri.stl", [10, 20, 30]), ["mesh.triangle_count", "mesh.bbox_max_dim_mm"], { kind: "mesh" }), { "mesh.triangle_count": 2, "mesh.bbox_max_dim_mm": 30 });

  const obj = path.join(dir, "cube.obj");
  fs.writeFileSync(obj, "# cube\nv 0 0 0\nv 10 0 0\nv 10 20 0\nv 0 20 30\nf 1 2 3 4\nf 1 2 3\n");
  assert.deepEqual(await facts(obj, BOX.slice(0, 3).concat("mesh.triangle_count"), { kind: "mesh" }), { "mesh.size_x_mm": 10, "mesh.size_y_mm": 20, "mesh.height_mm": 30, "mesh.triangle_count": 3 }, "a quad is two triangles");
  const hostile = path.join(dir, "hostile.obj");
  fs.writeFileSync(hostile, `v 0 0 0\nv 1 1 1\nf ${"1 ".repeat(200_000)}\n`);
  assert.deepEqual(await facts(hostile, ["mesh.size_x_mm", "mesh.triangle_count"], { kind: "mesh" }), {}, "a line no OBJ writer produces is refused, not split");
  assert.match(reasons(await run(hostile)), /sem geometria legivel neste arquivo: mesh\.size_x_mm/);
  const step = path.join(dir, "part.step");
  fs.writeFileSync(step, "ISO-10303-21;");
  assert.deepEqual(await facts(step, ["mesh.size_x_mm"], { kind: "mesh" }), {}, "STEP has no mesh");
  assert.match(reasons(await run(step)), /sem geometria legivel neste arquivo: mesh\.size_x_mm/);
  const broken = path.join(dir, "empty.stl");
  fs.writeFileSync(broken, "solid x\nendsolid x\n");
  assert.deepEqual(await facts(broken, ["mesh.size_x_mm"], { kind: "mesh" }), {});

  const unknown = await run(stl("big2.stl", [900, 900, 900]), { bambu_model: "zz9" }, { validModels: [...MODELS, "zz9"] });
  assert.ok(!ids(unknown).includes("bambu.cut.exceeds-build-volume"));
  assert.ok(unknown.unchecked.by_reason["modelo de impressora sem volume de impressao conhecido: zz9"] >= 1, reasons(unknown));
});

test("object.kind, object.mold_kind and object.origin come only from context: never from the file name", async (t) => {
  const file = await geometry(t, { items: [{ size: [30, 30, 5] }], plates: [[0]], name: "keychain pix_plate face_down_plate.3mf", config: { elefant_foot_compensation: "0.15" } });
  const bare = await run(file, { min_severity: "tip" });
  assert.ok(!ids(bare).includes("bambu.facedown.elephant-foot-zero"));
  for (const field of ["object_kind", "mold_kind"]) assert.ok(bare.unchecked.by_reason[`pergunte ao usuario: context.${field}`] >= 1, field);
  const declared = await run(file, { min_severity: "tip", context: { object_kind: "face_down_plate", origin: "download" } });
  assert.ok(declared.unchecked.by_reason["pergunte ao usuario: context.object_kind"] === undefined);
  const tool = KNOWLEDGE_TOOLS.find((x) => x.name === "preflight_check");
  assert.match(tool.description, /object\.kind, object\.mold_kind and object\.origin come ONLY from the context argument/);
  assert.match(tool.description, /never infer them from the file name/);
  assert.match(tool.inputSchema.properties.context.description, /never guess them from the file name/);
});

test("project flags: per-object overrides, filament overrides, custom profile, third party, painted colours", async (t) => {
  const names = ["project.has_per_object_overrides", "project.filament_override_count", "project.custom_filament_profile", "project.is_third_party", "project.has_painted_colors"];
  const plain = await geometry(t, { items: [{ size: [10, 10, 10] }], plates: [[0]] });
  assert.deepEqual(await facts(plain, names), {
    "project.has_per_object_overrides": false, "project.custom_filament_profile": false, "project.is_third_party": false, "project.has_painted_colors": false,
  }, "an own, plain X2D project: nothing is on, and the override count is unknown without the keys");

  const object = await geometry(t, { items: [{ size: [10, 10, 10], overrides: { wall_loops: "4" } }], plates: [[0]] });
  assert.equal((await facts(object, names))["project.has_per_object_overrides"], true, "an object-level config key");
  const part = await geometry(t, { items: [{ size: [10, 10, 10], partOverrides: '<metadata key="sparse_infill_density" value="40%"/><metadata key="source_file" value="x.3mf"/>' }], plates: [[0]] });
  assert.equal((await facts(part, names))["project.has_per_object_overrides"], true, "a part-level config key (source_* keys are not overrides)");
  const elsewhere = await geometry(t, { items: [{ size: [10, 10, 10], overrides: { wall_loops: "4" } }, { size: [10, 10, 10] }], plates: [[0], [1]] });
  assert.equal((await facts(elsewhere, names, { plateIndex: 1 }))["project.has_per_object_overrides"], false, "the lock icon is on an object of another plate");

  const nil = Object.fromEntries(["filament_z_hop", "filament_wipe", "filament_retraction_length"].map((k) => [k, ["nil", "nil"]]));
  assert.equal((await facts(await geometry(t, { items: [{ size: [1, 1, 1] }], plates: [[0]], config: nil }), names))["project.filament_override_count"], 0);
  const set = await geometry(t, { items: [{ size: [1, 1, 1] }], plates: [[0]], config: { ...nil, filament_wipe: ["1", "nil"], filament_retraction_length: ["0.4", "0.4"] } });
  assert.equal((await facts(set, names))["project.filament_override_count"], 2, "two parameters are overridden, whichever filament sets them");

  const custom = await geometry(t, { items: [{ size: [1, 1, 1] }], plates: [[0]], config: { filament_settings_id: ["Bambu PLA Basic @BBL X2D", "My eSun PLA"] } });
  assert.equal((await facts(custom, names))["project.custom_filament_profile"], true);

  const designer = await geometry(t, { items: [{ size: [1, 1, 1] }], plates: [[0]], extras: { designer: "St3rn Design" } });
  assert.equal((await facts(designer, names))["project.is_third_party"], true, "downloaded: a designer is named");
  const otherPrinter = await geometry(t, { items: [{ size: [1, 1, 1] }], plates: [[0]], config: { printer_model: "Bambu Lab H2D" } });
  assert.equal((await facts(otherPrinter, names))["project.is_third_party"], true, "saved for another printer");
  assert.equal((await facts(otherPrinter, names, { target: "h2d" }))["project.is_third_party"], false);

  const painted = await geometry(t, { items: [{ size: [10, 10, 10], paint: ' paint_color="4"' }], plates: [[0]] });
  assert.equal((await facts(painted, names))["project.has_painted_colors"], true);
  const hollow = await geometry(t, { items: [{ size: [1, 1, 1] }], plates: [[0]], extras: { files: { "3D/3dmodel.model": "<model><resources/><build/></model>" } } });
  assert.equal((await facts(hollow, names))["project.has_painted_colors"], undefined, "no geometry in the file: nothing can be said about paint");
});

test("plate.time_s and plate.weight_g come from slice_info.config for the chosen plate; tool changes need the G-code", async (t) => {
  const file = await geometry(t, { items: [{ size: [10, 10, 10] }, { size: [10, 10, 10] }], plates: [[0], [1]], extras: { sliced: [[3600, "12.50"], [7200, "30.25"]] } });
  const ctx = async (plateIndex) => ({ filePath: file, kind: "3mf", meshInfo: deps().meshInfo, project: await openProject(file), plateIndex, targetPrinter: "x2d", installedStudio: async () => null });
  assert.deepEqual(await sliceProvider.collect(await ctx(0), ["plate.time_s", "plate.weight_g"]), { "plate.time_s": 3600, "plate.weight_g": 12.5 });
  assert.deepEqual(await sliceProvider.collect(await ctx(1), ["plate.time_s", "plate.weight_g"]), { "plate.time_s": 7200, "plate.weight_g": 30.25 });
  assert.deepEqual(await sliceProvider.collect(await ctx(2), ["plate.time_s"]), {}, "a plate that was not sliced");
  assert.ok(!sliceProvider.provides("plate.tool_changes") && factTier("plate.tool_changes") === 3);
  const unsliced = await geometry(t, { items: [{ size: [10, 10, 10] }], plates: [[0]] });
  assert.deepEqual(await sliceProvider.collect({ ...(await ctx(0)), project: await openProject(unsliced) }, ["plate.time_s"]), {});

  const sliced = await run(file, { min_severity: "tip" });
  assert.equal(sliced.file.sliced, true);
  assert.ok(sliced.unchecked.by_reason["ative checks.gcode para analisar o G-code"] >= 1, reasons(sliced));
  const checklist = sliced.checklist.find((c) => c.rule_id === "bambu.versions.estimate-or-speeds-changed-after-sync");
  assert.deepEqual(checklist.current_values, { "plate.time_s": 3600 }, "the manual check shows the estimate to compare");
  const fresh = await run(unsliced, { min_severity: "tip" });
  assert.equal(fresh.checklist.find((c) => c.rule_id === "bambu.versions.estimate-or-speeds-changed-after-sync").current_values, undefined);
});

test("a 3MF without geometry (the GUI's G-code export) leaves the box unknown instead of guessing from plate_N.json", async (t) => {
  const file = await geometry(t, {
    items: [{ size: [10, 10, 10] }], plates: [[0]],
    extras: { files: { "3D/3dmodel.model": "<model><resources/><build/></model>", "Metadata/plate_1.json": '{"bbox_objects":[{"bbox":[0,0,300,300],"area":10,"id":1,"name":"x"}]}' } },
  });
  assert.deepEqual(await facts(file, BOX), {});
  const result = await run(file);
  assert.ok(!ids(result).includes("bambu.x2d.main-volume-exceeded"));
  assert.ok(result.unchecked.by_reason["sem geometria legivel neste arquivo: mesh.size_x_mm"] >= 1, reasons(result));
});

test("factTier follows the provider of a fact, else its area", () => {
  assert.deepEqual(["settings.layer_height", "printer.nozzle_count"].map(factTier), [1, 1]);
  assert.deepEqual(["mesh.size_x_mm", "project.is_third_party", "plate.time_s", "printer.model"].map(factTier), [2, 2, 2, 2]);
  assert.deepEqual(["gcode.purge_g", "plate.waste_weight_g", "plate.tool_changes"].map(factTier), [3, 3, 3]);
  assert.deepEqual(["mesh.open_edges", "mesh.min_feature_mm"].map(factTier), [4, 4]);
  assert.deepEqual(["blender.unit_scale", "blender.modifier_stack"].map(factTier), [5, 5]);
  assert.deepEqual(["object.kind", "project.nozzle2_used"].map(factTier), [2, 2]);
  for (const fact of getKb().facts) assert.ok(factTier(fact.name) >= 1, fact.name); // every declared fact has a tier
});

test("accounting: every rule of the base is in exactly one bucket (synthetic project)", async (t) => {
  const file = await geometry(t, { items: [{ size: [300, 300, 10] }, { size: [20, 20, 20] }], plates: [[0, 1]], config: { curr_bed_type: "Cool Plate", filament_type: ["PETG", "PETG"] } });
  const total = getKb().rules.length;
  for (const args of [{}, { min_severity: "tip" }, { min_severity: "blocker" }, { max_findings: 1, min_severity: "tip" }, { ignore: ["bambu.cut.exceeds-build-volume", "bambu.travel.zhop-disabled"] }, { bambu_model: "a1" }, { checks: { mesh: "fast", gcode: true, blender: true } }]) {
    const r = await run(file, args);
    assert.equal(r.accounting.candidates, total);
    assert.equal(sum(r.accounting), total, JSON.stringify([args, r.accounting]));
    assert.equal(r.accounting.findings, r.findings.length + r.hidden.over_max_findings);
    assert.equal(r.accounting.checklist, r.checklist.length);
    assert.equal(r.accounting.unchecked, r.unchecked.total);
    assert.equal(r.accounting.hidden, r.hidden.other_printers + r.hidden.ignored + r.hidden.below_min_severity);
  }
  const mesh = path.join(scratch(t), "p.stl");
  fs.writeFileSync(mesh, "solid x\nendsolid x\n");
  assert.equal(sum((await run(mesh)).accounting), total, "an STL too");
});

test("accounting on the sample project (an H2D MakerWorld file) for the X2D, plates 1 and 2", { skip: !fs.existsSync(SAMPLE) }, async () => {
  const total = getKb().rules.length;
  const seen = new Set();
  for (const plate_index of [0, 1]) {
    const r = await run(SAMPLE, { plate_index });
    assert.equal(sum(r.accounting), total, JSON.stringify(r.accounting));
    assert.equal(r.file.printer.saved_for, "Bambu Lab H2D");
    assert.ok(ids(r).includes("bambu.3mf.printer-switched-params-discarded") && ids(r).includes("bambu.3mf.third-party-checklist"));
    assert.ok(!ids(r).includes("bambu.x2d.main-volume-exceeded"), "every part of this project fits the X2D");
    assert.ok(r.accounting.not_fired > 40);
    for (const reason of Object.keys(r.unchecked.by_reason)) seen.add(reason);
    assert.ok(!seen.has("fato ainda nao implementado: mesh.size_x_mm"));
  }
  // The three tier phrases the plan asks for are all there, plus the user-declared and unconfirmed-key reasons.
  for (const phrase of ["precisa de G-code", "sonda do Blender não implementada", "ative checks.mesh=fast", "pergunte ao usuario: context.object_kind", "chave do 3MF ainda nao confirmada numa X2D real"]) {
    assert.ok([...seen].some((r) => r.includes(phrase)), phrase);
  }
  const one = await facts(SAMPLE, ["mesh.size_x_mm", "mesh.size_y_mm", "mesh.height_mm", "mesh.triangle_count"], { plateIndex: 0 });
  const two = await facts(SAMPLE, ["mesh.size_x_mm", "mesh.size_y_mm", "mesh.height_mm", "mesh.triangle_count"], { plateIndex: 1 });
  assert.deepEqual(one, { "mesh.size_x_mm": 119.254, "mesh.size_y_mm": 119.251, "mesh.height_mm": 179.248, "mesh.triangle_count": 10432 }, "plate 1 (the frame), recomputed by hand from the raw XML");
  assert.deepEqual(two, { "mesh.size_x_mm": 107.047, "mesh.size_y_mm": 50.431, "mesh.height_mm": 171.749, "mesh.triangle_count": 2184 }, "plate 2 is another object, not the whole project");
});
