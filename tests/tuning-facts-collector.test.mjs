// The per-round fact collector (src/tuning/facts.ts): providers merged, nothing from the slice leaks into round 0, facts are not carried between
// rounds, the retargeted base and the original project are told apart, and `unavailable` is exactly what the engine can never get.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseStringPromise } from "xml2js";
import { openProject } from "../dist/knowledge/facts/settings.js";
import { applyTuning, initialState, nextRound } from "../dist/tuning/engine.js";
import { collectFacts } from "../dist/tuning/facts.js";
import { scanGcodeStream } from "../dist/tuning/gcode-scan.js";
import { meshFactsFromProject, meshFactsFromRead } from "../dist/tuning/mesh-facts.js";
import { factsRead } from "../dist/tuning/part-context.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = process.env.BAMBU_SAMPLE_3MF || path.join(ROOT, "..", "models", "desk-organizer.3mf");
const SAMPLE_SLICED = process.env.BAMBU_SAMPLE_SLICED_3MF || path.join(ROOT, "..", "out", "desk-organizer_sliced.3mf");
const TUNING = JSON.parse(fs.readFileSync(path.join(ROOT, "knowledge/tuning/tuning.json"), "utf8"));
const READ = new Set(TUNING.flatMap((a) => [...factsRead(a)])); // what the actions actually read
const parse = async (xml) => (await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true })).config;

const SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?><config><header><header_item key="X-BBL-Client-Version" value="02.08.04.57"/></header>
<plate><metadata key="index" value="1"/><metadata key="prediction" value="35467"/><metadata key="weight" value="234.76"/><metadata key="support_used" value="false"/><metadata key="filament_maps" value="1 1"/>
<filament id="1" type="PLA" used_m="77.46" used_g="234.76" used_for_object="true" used_for_support="false"/></plate></config>`;
const RESULT = { plate_index: 1, sliced_plates: [{ id: 1, total_predication: 35467.2, filament_change_times: 0, warning_message: "", filaments: [{ id: 1, total_used_g: 234.76 }] }] };
const GCODE = [
  "; HEADER_BLOCK_START", "; BambuStudio 02.08.04.57", "; total layer number: 1", "; HEADER_BLOCK_END", "; CONFIG_BLOCK_START", "; retraction_minimum_travel = 1",
  "; filament_map = 1", "; filament_diameter = 1.75", "; filament_density = 1.26", "; enable_prime_tower = 0", "; enable_support = 0", "; CONFIG_BLOCK_END", "; EXECUTABLE_BLOCK_START",
  "; MACHINE_START_GCODE_END", "; CHANGE_LAYER", "; Z_HEIGHT: 0.2", "; FEATURE: Outer wall", "G1 X10 Y10 E.1", "; MACHINE_END_GCODE_START", "; EXECUTABLE_BLOCK_END", "",
].join("\n");

const BASE = { printer_model: "Bambu Lab X2D", nozzle_diameter: ["0.4", "0.4"], filament_type: ["PLA"], filament_settings_id: ["Bambu PLA Basic @BBL X2D"], layer_height: "0.2", enable_support: "0", support_type: "tree(auto)" };
async function project() {
  const sliceInfo = await parse(SLICE_INFO);
  const modelSettings = { plate: { metadata: [{ key: "plater_id", value: "1" }], model_instance: { metadata: [{ key: "object_id", value: "2" }, { key: "instance_id", value: "0" }] } }, object: { id: "2", metadata: [{ key: "extruder", value: "1" }], part: { id: "1", subtype: "normal_part" } } };
  return { config: { ...BASE, printer_model: "Bambu Lab H2D", nozzle_diameter: ["0.4"] }, sliceInfo, modelSettings, names: [], read: async () => undefined };
}
const MESH = meshFactsFromRead({ objects: [{ name: "x", soup: { pos: Float64Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0]), idx: Uint32Array.from([0, 1, 2]) } }], triangles: 1 });
/** A mushroom: a 10 x 10 pillar (only its bed face is modelled) under a 50 x 50 flat cap at z 10, 2400 mm2 of free flat ceiling. */
function mushroom() {
  const tris = [[[-5, -5, 0], [-5, 5, 0], [5, 5, 0]], [[-5, -5, 0], [5, 5, 0], [5, -5, 0]]]; // faces down
  for (let x = -25; x < 25; x += 5) for (let y = -25; y < 25; y += 5) {
    if (Math.abs(x + 2.5) < 5 && Math.abs(y + 2.5) < 5) continue;
    tris.push([[x, y, 10], [x, y + 5, 10], [x + 5, y + 5, 10]], [[x, y, 10], [x + 5, y + 5, 10], [x + 5, y, 10]]);
  }
  const pos = new Float64Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((v, j) => pos.set(v, i * 9 + j * 3)));
  return meshFactsFromRead({ objects: [{ name: "mushroom", soup: { pos, idx: Uint32Array.from({ length: tris.length * 3 }, (_, i) => i) } }], triangles: tris.length });
}
const group = (collected, prefix) => Object.keys(collected.facts).filter((k) => k.startsWith(prefix));

test("round 0: providers merged, base facts from the base settings, the original project's printer kept, and no slice facts even from a sliced project", async () => {
  const c = await collectFacts({ project: await project(), targetModel: "x2d", settingsBase: BASE, mesh: MESH, actions: TUNING, installedStudio: async () => "02.08.04.57" });
  assert.equal(c.facts["printer.model"], "Bambu Lab X2D");
  assert.deepEqual(c.facts["printer.nozzle_diameter"], ["0.4", "0.4"]); // the retargeted base says two nozzles; the original file said one
  assert.equal(c.facts["printer.nozzle_count"], 2);
  assert.equal(c.facts["project.source_printer"], "Bambu Lab H2D"); // the ORIGINAL project's
  assert.equal(c.facts["project.target_printer"], "Bambu Lab X2D");
  assert.deepEqual(c.facts["project.filament_types"], ["PLA"]);
  assert.deepEqual(c.facts["filament.profile_name"], ["Bambu PLA Basic @BBL X2D"]);
  assert.equal(c.facts["project.object_count"], 1);
  assert.equal(c.facts["studio.version"], "02.08.04.57"); // the Studio that saved the project
  const installed = await collectFacts({ project: await project(), targetModel: "x2d", wanted: ["studio.installed_version", "studio.meets_x2d_minimum"], installedStudio: async () => "02.08.04.57" });
  assert.deepEqual([installed.facts["studio.installed_version"], installed.facts["studio.meets_x2d_minimum"]], ["02.08.04.57", true]);
  assert.equal(c.facts["mesh.triangle_count"], 1);
  assert.equal(c.evidence["mesh.triangle_count"].provenance, "mesh");
  assert.equal(c.evidence["printer.model"].provenance, "project");
  assert.deepEqual(group(c, "gcode.").concat(group(c, "plate."), group(c, "slicer.")), []); // slice_info.config of the project has a plate: still not a fact of round 0
  assert.deepEqual(group(c, "settings."), []); // the engine's own
  assert.ok(c.unavailable.includes("mesh.min_feature_mm"));
  assert.match(c.evidence["mesh.min_feature_mm"].notes, /not implemented/);
  assert.equal(c.evidence["mesh.min_feature_mm"].provenance, "unavailable");
  assert.ok(c.unavailable.includes("project.support_painted")); // nobody ran that analyzer
  assert.ok(!c.unavailable.some((n) => /^(gcode|plate|slicer)\./.test(n)), "post-slice facts are pending in round 0, not unavailable");
  assert.ok(!c.unavailable.some((n) => n.startsWith("object.") && n.startsWith("object.load_class")), "an undeclared declarable fact is missing, not unavailable");
  assert.deepEqual([...c.unavailable].sort(), c.unavailable);
});

test("round 0 and round 1 differ only by that round's own measurements; round 1's facts are not carried to a round that has none", async () => {
  const gcode = await scanGcodeStream([Buffer.from(GCODE)]);
  const slice = { sliceInfo: await parse(SLICE_INFO), result: RESULT };
  const p = await project();
  const r1 = await collectFacts({ project: p, targetModel: "x2d", settingsBase: BASE, mesh: MESH, actions: TUNING, slice, gcode });
  assert.equal(r1.facts["plate.time_s"], 35467);
  assert.equal(r1.facts["plate.weight_g"], 234.76);
  assert.equal(r1.evidence["plate.time_s"].provenance, "slice");
  assert.ok(r1.facts["plate.tool_changes"] === 0 && r1.evidence["plate.tool_changes"].provenance === "gcode");
  for (const [name, value] of Object.entries(gcode.facts)) if (!name.startsWith("plate.")) {
    assert.deepEqual(r1.facts[name], value, name);
    assert.equal(r1.evidence[name].provenance, "gcode");
  }
  for (const name of gcode.blind) if (READ.has(name)) assert.ok(r1.unavailable.includes(name) || r1.facts[name] !== undefined, `${name} must be unavailable or known`);
  const again = await collectFacts({ project: p, targetModel: "x2d", settingsBase: BASE, mesh: MESH, actions: TUNING });
  assert.equal(again.facts["plate.time_s"], undefined);
  assert.equal(again.facts["gcode.support_line_count"], undefined);
  // the base facts are the same in both rounds
  for (const name of ["printer.model", "project.source_printer", "mesh.triangle_count", "project.filament_types"]) assert.deepEqual(again.facts[name], r1.facts[name]);
});

test("after a slice, a missing G-code scan makes every gcode.* fact unavailable (with the reason); a scan's blind facts are too", async () => {
  const slice = { sliceInfo: await parse(SLICE_INFO), result: RESULT };
  const noScan = await collectFacts({ project: await project(), targetModel: "x2d", settingsBase: BASE, actions: TUNING, slice });
  assert.equal(noScan.facts["plate.time_s"], 35467);
  const gcodeNames = [...READ].filter((n) => n.startsWith("gcode."));
  assert.ok(gcodeNames.length > 10);
  for (const n of gcodeNames) { assert.ok(noScan.unavailable.includes(n), n); assert.match(noScan.evidence[n].notes, /no G-code scan/); }
  const gcode = await scanGcodeStream([Buffer.from(GCODE)]);
  assert.ok(gcode.blind.length > 0);
  const withScan = await collectFacts({ project: await project(), targetModel: "x2d", settingsBase: BASE, actions: TUNING, slice, gcode });
  const blindAndWanted = gcode.blind.filter((n) => READ.has(n));
  assert.ok(blindAndWanted.length > 0);
  for (const n of blindAndWanted) { assert.ok(withScan.unavailable.includes(n), n); assert.equal(withScan.evidence[n].notes, gcode.evidence[n].notes); }
});

test("a blind mesh analysis is unavailable with its reason; declared facts win, carry provenance and are never unavailable; extra analyzers fill the gaps", async () => {
  const blind = await meshFactsFromProject({ names: [], read: async () => undefined }, 0);
  const c = await collectFacts({
    project: await project(), targetModel: "x2d", settingsBase: BASE, mesh: blind, actions: TUNING,
    declared: { kind: "keychain", is_tall_narrow: false, load_class: "functional" },
    extra: { facts: { "project.support_painted": false, "object.is_tall_narrow": true }, evidence: { "project.support_painted": { source: "analyzer A", method: "paint_supports scan", approx: false, notes: "" } } },
  });
  for (const n of ["mesh.unsupported_overhang_area_mm2", "mesh.top_surface_levels", "mesh.max_object_height_mm"]) {
    assert.ok(c.unavailable.includes(n), n);
    assert.match(c.evidence[n].notes, /no 3D\/3dmodel\.model/);
  }
  assert.equal(c.facts["object.kind"], "keychain");
  assert.equal(c.evidence["object.kind"].provenance, "declared");
  assert.equal(c.facts["object.is_tall_narrow"], false); // the declaration beats the analyzer's value
  assert.match(c.evidence["object.is_tall_narrow"].notes, /overrides the analyzer's value true/);
  assert.equal(c.facts["project.support_painted"], false);
  assert.equal(c.evidence["project.support_painted"].source, "analyzer A");
  assert.ok(!c.unavailable.includes("project.support_painted"));
  assert.ok(!c.unavailable.some((n) => n.startsWith("object.is_") || n === "object.load_class"));
  await assert.rejects(collectFacts({ targetModel: "x2d", wanted: [], declared: { kind: "nope" } }), /kind must be one of/);
  await assert.rejects(collectFacts({ targetModel: "ender3", wanted: [] }), /unknown target model/);
});

test("an STL has no project: printer.model is known, the 3MF facts are unavailable and say why", async () => {
  const c = await collectFacts({ targetModel: "x2d", mesh: MESH, actions: TUNING });
  assert.equal(c.facts["printer.model"], "Bambu Lab X2D");
  assert.equal(c.facts["mesh.height_mm"], 0);
  for (const n of ["project.filament_types", "project.layer_heights_differ", "filament.profile_name", "project.has_painted_colors"]) {
    assert.ok(c.unavailable.includes(n), n);
    assert.match(c.evidence[n].notes, /needs a 3MF project/);
  }
});

test("with the collector's `unavailable` the engine reports blind facts (not missing) and can reach done", async () => {
  const ladder = TUNING.filter((a) => a.id === "tune.support.enable-for-overhangs");
  const blind = await meshFactsFromProject({ names: [], read: async () => undefined }, 0);
  const gcode = await scanGcodeStream([Buffer.from(GCODE)]);
  const slice = { sliceInfo: await parse(SLICE_INFO), result: RESULT };
  const round = async (mesh, extra) => {
    const c = await collectFacts({ project: await project(), targetModel: "x2d", settingsBase: BASE, mesh, actions: ladder, slice, gcode, extra });
    const r0 = applyTuning(ladder, {}, BASE);
    return nextRound(ladder, r0.state, c.facts, { unavailable: c.unavailable, phase: "all" });
  };
  const painted = { facts: { "project.support_painted": false } };
  const unknown = await round(blind, painted);
  assert.deepEqual(unknown.unknown.map((u) => [u.where, u.missing, u.blind.includes("mesh.unsupported_overhang_area_mm2")]), [["trigger", [], true]]);
  assert.equal(unknown.done, true); // blind, not missing: it does not hold `done` back
  const nothingRan = await round(blind, undefined);
  assert.equal(nothingRan.done, true);
  assert.ok(nothingRan.unknown[0].blind.includes("project.support_painted"));
  const known = await round(MESH, painted);
  assert.equal(known.ladders[0].trigger, false); // no sloped face at all: a known zero, and no support lines
});

test("the sample (a sliced X2D 3MF): round 0 has no plate facts; the same file's slice artifacts give them in round 1", { skip: !fs.existsSync(SAMPLE_SLICED) && "sliced sample not present" }, async () => {
  const p = await openProject(SAMPLE_SLICED);
  assert.ok(p.sliceInfo, "the sample carries a slice");
  const mesh = await meshFactsFromProject(p, 0, { settings: p.config });
  const r0 = await collectFacts({ project: p, plateIndex: 0, targetModel: "x2d", settingsBase: p.config, mesh, actions: TUNING });
  assert.deepEqual(group(r0, "plate.").concat(group(r0, "gcode."), group(r0, "slicer.")), []);
  assert.equal(r0.facts["mesh.max_object_height_mm"], 179.248);
  assert.equal(r0.facts["printer.model"], "Bambu Lab X2D");
  assert.equal(r0.facts["project.filament_count"], 1);
  const r1 = await collectFacts({ project: p, plateIndex: 0, targetModel: "x2d", settingsBase: p.config, mesh, actions: TUNING, slice: { sliceInfo: p.sliceInfo } });
  assert.equal(r1.facts["plate.time_s"], 35467);
});

test("a flat cantilever (mushroom cap) is blind, not 0: tune.walls.fit-parts-order stays quiet; a naive 0 would have applied it", async () => {
  const action = TUNING.filter((a) => a.id === "tune.walls.fit-parts-order");
  const base = { ...BASE, wall_sequence: "inner wall/outer wall", precise_outer_wall: "0" };
  const mesh = mushroom();
  assert.equal(mesh.facts["mesh.flat_ceiling_area_mm2"], 2400);
  const c = await collectFacts({ targetModel: "x2d", settingsBase: base, mesh, declared: { has_fit_pins_and_holes: true }, actions: action });
  assert.equal(c.facts["object.has_fit_pins_and_holes"], true);
  assert.equal(c.facts["mesh.unsupported_overhang_area_mm2"], undefined);
  assert.ok(c.unavailable.includes("mesh.unsupported_overhang_area_mm2"));
  assert.match(c.evidence["mesh.unsupported_overhang_area_mm2"].notes, /2400 mm2 of flat ceiling.*cantilever/);
  const quiet = applyTuning(action, c.facts, base, { unavailable: c.unavailable });
  assert.deepEqual(quiet.applied, []);
  const naive = applyTuning(action, { ...c.facts, "mesh.unsupported_overhang_area_mm2": 0 }, base, { unavailable: [] });
  assert.deepEqual(naive.applied.map((x) => x.key), ["wall_sequence"]); // what the old 0 did
});

test("an STL has no project files but its settings base still gives printer.nozzle_* (the dual nozzle of the X2D)", async () => {
  const c = await collectFacts({ targetModel: "x2d", settingsBase: { nozzle_diameter: ["0.4", "0.4"], filament_settings_id: ["Bambu PLA Basic @BBL X2D"] }, mesh: MESH, actions: TUNING });
  assert.equal(c.facts["printer.nozzle_count"], 2);
  assert.deepEqual(c.facts["printer.nozzle_diameter"], ["0.4", "0.4"]);
  assert.equal(c.facts["printer.nozzle_diameters_differ"], false);
  assert.deepEqual(c.facts["filament.profile_name"], ["Bambu PLA Basic @BBL X2D"]);
  for (const n of ["printer.nozzle_count", "printer.nozzle_diameter", "printer.nozzle_diameters_differ"]) assert.ok(!c.unavailable.includes(n), n);
  // what only a project can tell stays unavailable, with the reason, and studio.version is not invented
  for (const n of ["project.filament_types", "project.object_count", "studio.version"]) {
    assert.ok(c.unavailable.includes(n), n);
    assert.equal(c.facts[n], undefined);
  }
  assert.match(c.evidence["project.filament_types"].notes, /needs a 3MF project/);
  // a base without nozzle_diameter cannot tell: unavailable, not a guess, and the reason is not "needs a project"
  const bare = await collectFacts({ targetModel: "x2d", settingsBase: {}, mesh: MESH, actions: TUNING });
  assert.ok(bare.unavailable.includes("printer.nozzle_count"));
  assert.match(bare.evidence["printer.nozzle_count"].notes, /not derivable/);
});
