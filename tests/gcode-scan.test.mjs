// The streaming G-code scanner (src/tuning/gcode-scan.ts) against analyzer-spec.md section 5:
//  - hand-written G-code per detector (lift kinds, unprotected travel and crossing, support islands, [N] markers, config-off zeros);
//  - the real X2D plate: the head fixture and, when present, the 41 MB plate_1.gcode of out/desk-organizer_sliced.3mf, against the numbers the
//    reference probe froze (kb/tuning/fixtures/plate1-probe-full.json, plate1-head-probe.json);
//  - transport: LF/CRLF, any chunking, a cut file, long lines, hostile words, memory that does not grow with the file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GCODE_SCAN_FACTS, scanGcodeFile, scanGcodeStream, scanPlateGcode } from "../dist/tuning/gcode-scan.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEAD = path.join(ROOT, "tests/fixtures/gcode/plate1-head.gcode");
const SAMPLE_3MF = process.env.BAMBU_SAMPLE_SLICED_3MF ?? "/Users/max/dev/pessoal/3dprint/out/desk-organizer_sliced.3mf"; // the real X2D plate; the test skips without it

const CONFIG = {
  retraction_minimum_travel: "1", filament_map: "1", filament_diameter: "1.75", filament_density: "1.26", filament_max_volumetric_speed: "21",
  extruder_printable_area: "0x0,256x0,256x256,0x256", enable_support: "0", ironing_type: "no ironing", brim_type: "no_brim", enable_prime_tower: "0",
  z_hop_types: "Normal Lift", spiral_mode: "0", print_sequence: "by layer",
};
/** A Bambu-shaped G-code: header, config block, executable block between the machine start and end markers. */
function gcode(exec, config = {}, { end = true, eol = "\n" } = {}) {
  const cfg = { ...CONFIG, ...config };
  const lines = [
    "; HEADER_BLOCK_START", "; BambuStudio 02.08.04.57", "; model printing time: 1m 0s; total estimated time: 1m 30s", "; total layer number: 2",
    "; total filament weight [g] : 1.00", "; filament_density: 1.26", "; filament_diameter: 1.75", "; HEADER_BLOCK_END", "",
    "; CONFIG_BLOCK_START", ...Object.entries(cfg).filter(([, v]) => v !== null).map(([k, v]) => `; ${k} = ${v}`), "; CONFIG_BLOCK_END", "",
    "; EXECUTABLE_BLOCK_START", "M83", "G90", "G1 Z5 F1200", "; MACHINE_START_GCODE_END", ...exec, "; MACHINE_END_GCODE_START", "M104 S0",
    ...(end ? ["; EXECUTABLE_BLOCK_END", ""] : []),
  ];
  return lines.join(eol);
}
const scan = (text, options) => scanGcodeStream([Buffer.from(text)], options);
const layer = (z, h = 0.2) => ["; CHANGE_LAYER", `; Z_HEIGHT: ${z}`, `; LAYER_HEIGHT: ${h}`];
const feature = (name, width = 0.42, f = 3000) => [`; FEATURE: ${name}`, `; LINE_WIDTH: ${width}`, `G1 F${f}`];
const ext = (x, y, e = 0.3) => `G1 X${x} Y${y} E${e}`;
const travel = (x, y) => `G1 X${x} Y${y} F60000`;
const square = (x0, y0, x1, y1) => [ext(x1, y0), ext(x1, y1), ext(x0, y1), ext(x0, y0)];
/** First layer: Z set like the real change-layer code, then a travel (the layer-change travel) to the first point. */
const first = (x, y) => [...layer(0.2), "G1 Z.2", travel(x, y)];
const PROTECT = ["; WIPE_START", "G1 E-.8 F1800", "; WIPE_END"];

test("a spiral lift (G3 Z without XY) is one lift, and the G1 X Y Z line that follows is not a slope", async () => {
  const r = await scan(gcode([
    ...first(10, 10), ...feature("Outer wall"), ext(20, 10), ext(20, 20),
    ...PROTECT, "G17", "G3 Z.6 I1 J0 P1 F60000", "G1 X50 Y50 Z.6 F60000", "G1 Z.2", "G1 E.8 F1800",
    ...feature("Inner wall"), ext(60, 50),
  ], { z_hop_types: "Spiral Lift" }));
  assert.equal(r.complete, true);
  assert.deepEqual(r.details.lifts, { spiral: 1, normal: 0, slope: 0, layerChange: 0, withoutRetract: 0 });
  assert.equal(r.facts["gcode.zhop_lift_count"], 1);
  assert.equal(r.facts["gcode.zhop_type_mismatch"], false); // Spiral Lift configured, spiral dominant
  assert.equal(r.facts["gcode.unprotected_travel_count"], 0); // protected: retraction and lift
});

test("a normal lift (G1 Z up) and the dominant style against a different machine z_hop_types", async () => {
  const exec = [
    ...first(10, 10), ...feature("Outer wall"), ext(20, 10), ext(20, 20),
    ...PROTECT, "G1 Z.6 F1200", travel(50, 50), "G1 Z.2", "G1 E.8 F1800", ext(60, 50),
  ];
  const same = await scan(gcode(exec, { z_hop_types: "Normal Lift" }));
  assert.equal(same.details.lifts.normal, 1);
  assert.equal(same.facts["gcode.zhop_type_mismatch"], false);
  const other = await scan(gcode(exec, { z_hop_types: "Spiral Lift" }));
  assert.equal(other.facts["gcode.zhop_type_mismatch"], true);
  assert.match(other.evidence["gcode.zhop_type_mismatch"].notes, /dominant Normal Lift/);
  const auto = await scan(gcode(exec, { z_hop_types: "Auto Lift" }));
  assert.equal(auto.facts["gcode.zhop_type_mismatch"], false); // nothing explicit to disagree with
});

test("a slope lift rises with XY against the previous Z; a G1 X Y Z that does not rise is not one", async () => {
  const slope = await scan(gcode([
    ...first(10, 10), ...feature("Outer wall"), ext(20, 10),
    ...PROTECT, "G1 X50 Y50 Z.6 F60000", "G1 Z.2", "G1 E.8 F1800", ext(60, 50),
  ], { z_hop_types: "Slope Lift" }));
  assert.equal(slope.details.lifts.slope, 1);
  assert.equal(slope.facts["gcode.zhop_type_mismatch"], false);
  const flat = await scan(gcode([
    ...first(10, 10), ...feature("Outer wall"), ext(20, 10),
    ...PROTECT, "G1 X50 Y50 Z.2 F60000", "G1 E.8 F1800", ext(60, 50), // Z word, same Z
    ...PROTECT, "G1 X70 Y70 Z.1 F60000", "G1 E.8 F1800", ext(80, 70), // Z word, going down
  ]));
  assert.equal(flat.details.lifts.slope, 0);
  assert.equal(flat.facts["gcode.zhop_lift_count"], 0);
  // Z already above the layer and unchanged: the Z word alone is not a slope (compare with the previous Z)
  const high = await scan(gcode([
    ...first(10, 10), ...feature("Outer wall"), ext(20, 10),
    ...PROTECT, "G1 Z.6 F1200", travel(30, 30), "G1 E.8 F1800", ext(40, 30), // a normal lift whose Z is never lowered
    ...PROTECT, "G1 X50 Y50 Z.6 F60000", "G1 E.8 F1800", ext(60, 50),
  ]));
  assert.deepEqual(high.details.lifts, { spiral: 0, normal: 1, slope: 0, layerChange: 0, withoutRetract: 0 });
});

test("an unprotected travel over the retraction threshold is counted; retracted, lifted, short and layer-change travels are not", async () => {
  const r = await scan(gcode([
    ...first(10, 10), ...feature("Outer wall"), ...square(10, 10, 20, 20),
    ...PROTECT, travel(12, 12), "G1 E.8 F1800", // protected (retraction)
    ...feature("Sparse infill"), ext(18, 12),
    travel(30, 12), // 12 mm, no retraction, no lift: unprotected, crosses the wall at x=20
    ...feature("Outer wall"), ext(40, 12),
    travel(40.5, 12), ext(45, 12), // 0.5 mm: below the 1 mm threshold
    ...layer(0.4), travel(100, 100), ...feature("Outer wall"), ext(110, 100), // layer-change travel, no retraction or lift: excluded
  ]));
  assert.equal(r.facts["gcode.unprotected_travel_count"], 1);
  assert.equal(r.facts["gcode.unprotected_travel_crossing_count"], 1);
  assert.deepEqual(r.facts["gcode.unprotected_travels_by_origin"], ["Sparse infill: 1 unprotected, 1 crossing"]);
  assert.equal(r.facts["gcode.unprotected_travel_over_20mm_count"], 0);
  assert.equal(r.facts["gcode.unprotected_travel_curl_risk_count"], 0);
  assert.equal(r.details.unprotected.layerChange, 2); // the travel into layer 1 and the one into layer 2: neither is counted
  assert.equal(r.facts["gcode.unprotected_travel_max_mm"], 12);
});

test("crossing needs the interior of a printed obstacle: sparse infill and touching an end do not count", async () => {
  // a travel across a sparse infill line crosses nothing that matters
  const infill = await scan(gcode([
    ...first(10, 10), ...feature("Outer wall"), ...square(10, 10, 20, 20),
    ...PROTECT, travel(30, 2), "G1 E.8 F1800", ...feature("Sparse infill"), ext(30, 8),
    ...PROTECT, travel(24, 5), "G1 E.8 F1800", ...feature("Outer wall"), ext(25, 5),
    travel(36, 5), // 11 mm, unprotected, crosses the infill line at x=30
    ext(37, 5),
  ]));
  assert.equal(infill.facts["gcode.unprotected_travel_count"], 1);
  assert.equal(infill.facts["gcode.unprotected_travel_crossing_count"], 0);
  // a travel that ends exactly on the end point of a printed wall touches it; it does not cross it
  const touch = await scan(gcode([
    ...first(30, 10), ...feature("Outer wall"), ext(40, 10), // wall segment (30,10)-(40,10)
    ...PROTECT, travel(40, 0), "G1 E.8 F1800", ext(40, 2),
    travel(40, 10), ext(40, 12), // (40,2) -> (40,10): ends on the wall's end point
  ]));
  assert.equal(touch.facts["gcode.unprotected_travel_count"], 1);
  assert.equal(touch.facts["gcode.unprotected_travel_crossing_count"], 0);
  // the same travel pushed 1 mm further goes through the wall
  const through = await scan(gcode([
    ...first(30, 10), ...feature("Outer wall"), ext(40, 10),
    ...PROTECT, travel(35, 0), "G1 E.8 F1800", ext(35, 2),
    travel(35, 12), ext(35, 14), // (35,2) -> (35,12) crosses (30,10)-(40,10)
  ]));
  assert.equal(through.facts["gcode.unprotected_travel_crossing_count"], 1);
  // a wall printed AFTER the travel is not an obstacle for it
  const later = await scan(gcode([
    ...first(10, 10), ...feature("Inner wall"), ext(11, 10),
    travel(35, 2), ext(35, 3), ...feature("Outer wall"), ext(35, 13),
  ]));
  assert.equal(later.facts["gcode.unprotected_travel_crossing_count"], 0);
});

test("curl risk: crossing Overhang wall, Bridge or Top surface; crossing a plain wall is a crossing but not curl risk", async () => {
  const body = role => [
    ...first(10, 10), ...feature(role), ...square(10, 10, 20, 20),
    ...PROTECT, travel(12, 12), "G1 E.8 F1800", ...feature("Sparse infill"), ext(18, 12), travel(30, 12), ...feature("Outer wall"), ext(40, 12),
  ];
  for (const [role, curl] of [["Overhang wall", 1], ["Bridge", 1], ["Top surface", 1], ["Inner wall", 0]]) {
    const r = await scan(gcode(body(role)));
    assert.equal(r.facts["gcode.unprotected_travel_crossing_count"], 1, role);
    assert.equal(r.facts["gcode.unprotected_travel_curl_risk_count"], curl, role);
  }
});

test("a travel longer than 20 mm is counted separately and its origin is the feature of the extrusion before it", async () => {
  const r = await scan(gcode([
    ...first(10, 10), ...feature("Floating vertical shell"), ext(20, 10),
    travel(60, 10), ...feature("Outer wall"), ext(70, 10),
  ]));
  assert.equal(r.facts["gcode.unprotected_travel_over_20mm_count"], 1);
  assert.deepEqual(r.facts["gcode.unprotected_travels_by_origin"], ["Floating vertical shell: 1 unprotected, 0 crossing"]);
});

test("support: labels and interface counted, weight from E, and unprotected travels count only inside one support island", async () => {
  const exec = [
    ...first(10, 10), ...feature("Support", 0.4),
    ext(20, 10), ext(20, 10.4), ext(10, 10.4), ext(10, 14), // a continuous path: one island
    travel(20, 14), ext(20, 10.4), // unprotected, 10 mm; the next line touches the island at (20,10.4): same island
    travel(100, 100), ext(110, 100), // unprotected, to an isolated support line: another island
    ...feature("Support interface", 0.4), travel(130, 100), ext(140, 100), // unprotected, onto an interface line far from it
  ];
  const r = await scan(gcode(exec, { enable_support: "1" }));
  assert.equal(r.facts["gcode.support_line_count"], 7); // 4 + 1 + 1 support, 1 interface
  assert.equal(r.facts["gcode.support_interface_line_count"], 1);
  const grams = (7 * 0.3 * Math.PI * (1.75 / 2) ** 2 * 1.26) / 1000; // 0.3 mm of 1.75 mm filament per segment, 1.26 g/cm3
  assert.ok(Math.abs(r.facts["gcode.support_weight_g"] - grams) < 0.001, `${r.facts["gcode.support_weight_g"]} vs ${grams}`);
  assert.equal(r.facts["gcode.unprotected_travel_count"], 3);
  assert.equal(r.facts["gcode.unprotected_travels_in_support"], 1); // only the first travel stays inside one island
  assert.deepEqual(r.details.unprotected.byOrigin["Support"], { unprotected: 3, crossing: 0 });
  const apart = await scan(gcode([...first(10, 10), ...feature("Support", 0.4), ext(20, 10), travel(100, 100), ext(110, 100)], { enable_support: "1" }));
  assert.equal(apart.facts["gcode.unprotected_travel_count"], 1);
  assert.equal(apart.facts["gcode.unprotected_travels_in_support"], 0);
});

test("the [N] roles: a zero needs the config (or slice_info) to say the feature is off; a marker in the file is counted as it is", async () => {
  const plain = [...first(10, 10), ...feature("Outer wall"), ext(20, 10), ext(20, 20)];
  const off = await scan(gcode(plain));
  assert.equal(off.facts["gcode.support_line_count"], 0);
  assert.equal(off.facts["gcode.ironing_line_count"], 0);
  assert.equal(off.facts["gcode.tower_g"], 0);
  assert.equal(off.facts["gcode.first_layer_brim_present"], false);
  assert.equal(off.facts["plate.tool_changes"], 0);
  assert.equal(off.facts["gcode.purge_g"], 0);
  // support, ironing, brim and tower are configured but no label is in the file: unknown, never 0
  const on = await scan(gcode(plain, { enable_support: "1", ironing_type: "top surface", brim_type: "auto_brim", enable_prime_tower: "1" }));
  for (const name of ["gcode.support_line_count", "gcode.support_interface_line_count", "gcode.support_weight_g", "gcode.ironing_line_count", "gcode.tower_g", "gcode.tower_height_mm", "gcode.first_layer_brim_present", "gcode.unprotected_travels_in_support", "plate.waste_weight_g"]) {
    assert.equal(name in on.facts, false, name);
    assert.ok(on.blind.includes(name), name);
    assert.ok(on.evidence[name].notes.length > 10, name);
  }
  // slice_info saying "no support used" is enough for support, still not for the rest
  const hinted = await scan(gcode(plain, { enable_support: "1" }), { supportUsed: false });
  assert.equal(hinted.facts["gcode.support_line_count"], 0);
  // labels present: counted
  const seen = await scan(gcode([
    ...first(10, 10), ...feature("Brim"), ext(20, 10), ...feature("Outer wall"), ext(20, 20),
    ...layer(0.4), "G1 Z.4", ...feature("Prime tower"), travel(100, 100), ext(110, 100, 1), ext(110, 110, 1),
    ...feature("Ironing"), ext(120, 110, 0.0002), ext(120, 120, 0.0002),
    ...feature("Support interface"), ext(130, 120), ext(130, 130),
  ], { enable_support: "1", ironing_type: "top surface", brim_type: "auto_brim", enable_prime_tower: "1" }));
  assert.equal(seen.facts["gcode.first_layer_brim_present"], true);
  assert.equal(seen.facts["gcode.ironing_line_count"], 2);
  assert.equal(seen.facts["gcode.support_line_count"], 2);
  assert.equal(seen.facts["gcode.support_interface_line_count"], 2);
  assert.equal(seen.facts["gcode.tower_height_mm"], 0.4);
  const towerG = (2 * Math.PI * (1.75 / 2) ** 2 * 1.26) / 1000;
  assert.ok(Math.abs(seen.facts["gcode.tower_g"] - towerG) < 0.001);
  assert.equal(seen.facts["plate.waste_weight_g"], seen.facts["gcode.tower_g"]);
  assert.deepEqual(seen.details.unknownFeatures, []);
});

test("an unrecognised feature label is reported, not guessed", async () => {
  const r = await scan(gcode([...first(10, 10), ...feature("Mystery"), ext(20, 10)]));
  assert.deepEqual(r.details.unknownFeatures, ["Mystery"]);
  assert.match(r.evidence["gcode.layer_count"].notes, /Mystery/);
});

test("first layer: speed is the maximum, wall and infill apart, Custom is left out, area is length x width", async () => {
  const r = await scan(gcode([
    ...layer(0.2), "G1 Z.2", ...feature("Custom", 0.5, 12000), ext(5, 5), ext(5, 6), travel(10, 10),
    ...feature("Outer wall", 0.4, 3000), ext(20, 10), ...feature("Bottom surface", 0.5, 6300), ext(20, 14),
    ...layer(0.4), "G1 Z.4", ...feature("Outer wall", 0.4, 9000), ext(30, 14),
  ]));
  assert.equal(r.facts["gcode.first_layer_speed_mm_s"], 105);
  assert.equal(r.facts["gcode.first_layer_wall_speed_mm_s"], 50);
  assert.equal(r.facts["gcode.first_layer_infill_speed_mm_s"], 105);
  assert.equal(r.facts["gcode.first_layer_height_mm"], 0.2);
  // wall 10 mm x 0.4 + bottom 4 mm x 0.5 (the first Custom segments and the second layer are out)
  assert.equal(r.facts["gcode.first_layer_area_mm2"], 6);
  assert.equal(r.evidence["gcode.first_layer_area_mm2"].approx, true);
});

test("flow share, minimum wall width and top layers", async () => {
  const r = await scan(gcode([
    ...first(10, 10), ...feature("Inner wall", 0.3, 3000), ext(20, 10, 0.05),
    ...feature("Gap infill", 0.1, 3000), ext(30, 10, 0.05), // Gap infill is not a wall
    ...feature("Outer wall", 0.5, 6000), ext(40, 10, 2), // 10 mm, E 2: (2 x 2.405 / 10) x 100 mm/s = 48 mm3/s, over the 21 limit
    ...layer(0.4), "G1 Z.4", ...feature("Top surface"), ext(50, 10, 0.1),
    ...layer(0.6), "G1 Z.6", ...feature("Top surface"), ext(60, 10, 0.1), ext(70, 10, 0.1),
    ...layer(0.8), "G1 Z.8", ...feature("Top surface"), ext(80, 10, 0.1),
  ]));
  // total flow length 10 (Inner) + 10 (Gap) + 10 (Outer) + 10 + 20 + 10 = 70 mm; 10 mm over
  assert.ok(Math.abs(r.facts["gcode.flow_limit_exceeded_share"] - 10 / 70) < 1e-5);
  assert.equal(r.facts["gcode.min_line_width_mm"], 0.3);
  assert.equal(r.facts["gcode.top_layer_count"], 3);
});

test("tool_xy_outside_area_count counts end points outside the printable area with a 0.01 mm tolerance", async () => {
  const r = await scan(gcode([
    ...first(10, 10), ...feature("Outer wall"), ext(256.005, 10), ext(257, 10),
    ...PROTECT, "G1 X-5 Y20 F60000", "G1 E.8 F1800", ext(0, 20),
  ]));
  assert.equal(r.facts["gcode.tool_xy_outside_area_count"], 2); // (257,10) and (-5,20)
  const none = await scan(gcode([...first(10, 10), ...feature("Outer wall"), ext(256.005, 10)]));
  assert.equal(none.facts["gcode.tool_xy_outside_area_count"], 0);
});

test("a multi-filament G-code: travel facts are unknown, tool changes are counted, aux maxima follow filament_map", async () => {
  const exec = [
    "T0 H-1", ...first(10, 10), ...feature("Outer wall", 0.4, 3000), "M204 S5000", ext(20, 10),
    "M620 S1A", "T1 H0", "M621 S1A", "M204 S1000", ...feature("Outer wall", 0.4, 7200), ext(30, 10),
  ];
  const r = await scan(gcode(exec, { filament_map: "1,2", filament_diameter: "1.75,1.75", filament_density: "1.26,1.26", filament_max_volumetric_speed: "21,21" }));
  assert.equal(r.facts["plate.tool_changes"], 1);
  assert.equal(r.evidence["plate.tool_changes"].approx, true);
  assert.equal(r.facts["gcode.aux_nozzle_max_extrusion_feedrate_mm_s"], 120);
  assert.equal(r.facts["gcode.aux_nozzle_max_extrusion_accel_mm_s2"], 1000);
  assert.equal(r.evidence["gcode.aux_nozzle_max_extrusion_feedrate_mm_s"].approx, true);
  for (const name of ["gcode.unprotected_travel_count", "gcode.unprotected_travel_crossing_count", "gcode.unprotected_travel_curl_risk_count", "gcode.unprotected_travels_by_origin", "gcode.zhop_lift_count"]) {
    assert.equal(name in r.facts, false, name);
    assert.match(r.evidence[name].notes, /multi-filament/);
  }
  // wipe tower / flush markers without a T<n> change block the travel facts too
  const tower = await scan(gcode([...first(10, 10), ...feature("Outer wall"), ext(20, 10), "; WIPE_TOWER_START", "; WIPE_TOWER_END"]));
  assert.equal("gcode.unprotected_travel_count" in tower.facts, false);
});

test("aux maxima are a known zero only when slice_info says no used filament is on extruder 2", async () => {
  const text = gcode([...first(10, 10), ...feature("Outer wall"), ext(20, 10)]);
  const unknown = await scan(text);
  assert.equal("gcode.aux_nozzle_max_extrusion_feedrate_mm_s" in unknown.facts, false);
  const known = await scan(text, { auxExtruderUsed: false });
  assert.equal(known.facts["gcode.aux_nozzle_max_extrusion_feedrate_mm_s"], 0);
  assert.equal(known.facts["gcode.aux_nozzle_max_extrusion_accel_mm_s2"], 0);
  const used = await scan(text, { auxExtruderUsed: true });
  assert.equal("gcode.aux_nozzle_max_extrusion_feedrate_mm_s" in used.facts, false);
});

test("flush commands: purge weight is approximate and the mismatch count stays unknown; none in a single-filament file is a known zero", async () => {
  const r = await scan(gcode([...first(10, 10), ...feature("Outer wall"), ext(20, 10), "M620.10 A0 L50 F523 H0.4 T240 P220 S1", "M620.10 A1 L30 F523 H0.4 T240 P220 S1"], { enable_prime_tower: "0" }));
  const g = (80 * Math.PI * (1.75 / 2) ** 2 * 1.26) / 1000;
  assert.ok(Math.abs(r.facts["gcode.purge_g"] - g) < 0.002);
  assert.equal(r.evidence["gcode.purge_g"].approx, true);
  assert.equal("gcode.flush_length_mismatch_count" in r.facts, false);
  assert.ok(Math.abs(r.facts["plate.waste_weight_g"] - r.facts["gcode.purge_g"]) < 1e-9);
});

test("absolute extrusion (M82, G92 E0) uses the E difference", async () => {
  const rel = await scan(gcode([...first(10, 10), ...feature("Outer wall"), ext(20, 10, 0.5), ext(30, 10, 0.5), ext(40, 10, 0.5)]));
  const abs = await scan(gcode(["M82", "G92 E0", ...first(10, 10), ...feature("Outer wall"), "G1 X20 Y10 E.5", "G1 X30 Y10 E1", "G1 X40 Y10 E1.5"]));
  assert.equal(abs.facts["gcode.extruded_weight_g"], rel.facts["gcode.extruded_weight_g"]);
  assert.equal(abs.details.features["Outer wall"].segments, 3);
});

test("CRLF and LF give the same facts, and so does any chunking of the bytes", async () => {
  const exec = [
    ...first(10, 10), ...feature("Outer wall"), ...square(10, 10, 20, 20), ...PROTECT, travel(12, 12), "G1 E.8 F1800",
    ...feature("Sparse infill"), ext(18, 12), travel(30, 12), ...feature("Outer wall"), ext(40, 12),
  ];
  const lf = await scan(gcode(exec));
  const crlf = await scan(gcode(exec, {}, { eol: "\r\n" }));
  assert.deepEqual(crlf.facts, lf.facts);
  assert.equal(crlf.complete, true);
  const bytes = Buffer.from(gcode(exec, {}, { eol: "\r\n" }));
  const pieces = [];
  for (let i = 0; i < bytes.length; i += 7) pieces.push(bytes.subarray(i, i + 7));
  const chunked = await scanGcodeStream(pieces);
  assert.deepEqual(chunked.facts, lf.facts);
  assert.equal(chunked.stats.lines, crlf.stats.lines);
  // multi-byte text in a comment survives a chunk boundary inside the character
  const utf = Buffer.from(gcode(exec).replace("; BambuStudio 02.08.04.57", "; BambuStudio 02.08.04.57\n; filament_settings_id: \"Bambu PLA éçãoè\""));
  const cut = utf.indexOf(Buffer.from("ç")) + 1;
  const parts = await scanGcodeStream([utf.subarray(0, cut), utf.subarray(cut)]);
  assert.deepEqual(parts.facts, lf.facts);
});

test("a cut file is incomplete: no facts by default, lower bounds with allowPartial, and a cut command is never read", async () => {
  const exec = [...first(10, 10), ...feature("Outer wall"), ext(20, 10), ext(20, 20), travel(60, 60), ext(70, 60)];
  const whole = gcode(exec);
  const cut = whole.slice(0, whole.indexOf("; MACHINE_END_GCODE_START")) + "G1 X999 Y9"; // ends mid-command, no EXECUTABLE_BLOCK_END
  const r = await scan(cut);
  assert.equal(r.complete, false);
  assert.deepEqual(r.facts, {});
  assert.equal(r.blind.length, GCODE_SCAN_FACTS.length);
  assert.match(r.evidence["gcode.unprotected_travel_count"].notes, /truncated/);
  const partial = await scan(cut, { allowPartial: true });
  assert.equal(partial.complete, false);
  assert.equal(partial.facts["gcode.unprotected_travel_count"], 1);
  assert.equal(partial.evidence["gcode.unprotected_travel_count"].approx, true);
  assert.match(partial.evidence["gcode.unprotected_travel_count"].notes, /lower bound/);
  assert.equal("gcode.support_line_count" in partial.facts, false); // a zero needs the whole file
  assert.equal(partial.details.header.layers, 2);
  assert.ok(partial.blind.includes("gcode.tool_xy_outside_area_count")); // a zero of a partial scan is not shown (see the absence test below)
  // the cut command (X999) was not read: with one real outside move in front, the count is that one move
  const outsideWhole = gcode([...first(10, 10), ...feature("Outer wall"), ext(300, 10), ext(20, 20)]);
  const outside = await scan(outsideWhole.slice(0, outsideWhole.indexOf("; MACHINE_END_GCODE_START")) + "G1 X999 Y9", { allowPartial: true });
  assert.equal(outside.facts["gcode.tool_xy_outside_area_count"], 1);
  // no config block read: not complete either
  const noConfig = await scan(whole.replace(/; CONFIG_BLOCK_START[\s\S]*; CONFIG_BLOCK_END/, ""));
  assert.equal(noConfig.complete, false);
});

test("a config block at the end of the file needs a fallbackConfig for the travel facts", async () => {
  const text = gcode([...first(10, 10), ...feature("Outer wall"), ext(20, 10), travel(60, 10), ext(70, 10)]);
  const [head, rest] = [text.slice(0, text.indexOf("; CONFIG_BLOCK_START")), text.slice(text.indexOf("; CONFIG_BLOCK_START"))];
  const configEnd = rest.indexOf("; CONFIG_BLOCK_END") + "; CONFIG_BLOCK_END".length;
  const moved = head + rest.slice(configEnd) + rest.slice(0, configEnd) + "\n";
  const late = await scan(moved);
  assert.equal(late.complete, true);
  assert.equal("gcode.unprotected_travel_count" in late.facts, false);
  assert.match(late.evidence["gcode.unprotected_travel_count"].notes, /no config block before the executable block/);
  const withFallback = await scan(moved, { fallbackConfig: { ...CONFIG } });
  assert.equal(withFallback.facts["gcode.unprotected_travel_count"], 1);
});

test("lines up to 64 KB are read, longer ones are skipped and make the scan incomplete", async () => {
  const exec = [...first(10, 10), ...feature("Outer wall"), ext(20, 10), `; ${"x".repeat(60 * 1024)}`, ext(30, 10)];
  const ok = await scan(gcode(exec));
  assert.equal(ok.complete, true);
  assert.equal(ok.details.features["Outer wall"].segments, 2);
  const long = await scan(gcode([...exec.slice(0, -2), `; ${"x".repeat(70 * 1024)}`, ext(30, 10)]));
  assert.equal(long.details.skipped.longLines, 1);
  assert.equal(long.complete, false);
  assert.match(long.evidence["gcode.layer_count"].notes, /64 KB/);
  // a 70 KB line split across many chunks is dropped without being held
  const bytes = Buffer.from(gcode([...exec.slice(0, -2), `; ${"x".repeat(70 * 1024)}`, ext(30, 10)]));
  const pieces = [];
  for (let i = 0; i < bytes.length; i += 4096) pieces.push(bytes.subarray(i, i + 4096));
  const chunked = await scanGcodeStream(pieces);
  assert.equal(chunked.details.skipped.longLines, 1);
  assert.equal(chunked.details.features["Outer wall"].segments, 2);
});

test("hostile words and comments are data: huge coordinates, NaN and a forged marker in a comment do nothing", async () => {
  const r = await scan(gcode([
    ...first(10, 10), ...feature("Outer wall"), ext(20, 10),
    "G1 X1e12 Y1e12 E1", "G1 XNaN Y5 E1", "G1 X1 Y2 E999999999999999999999", // beyond the limit / not numbers
    "G1 X30 Y10 E.3 ; FEATURE: Support", // a comment on a command line is not a marker
    "; some text ; FEATURE: Support", // neither is text after the first ';' of a comment
    "G1 X3e1 Y10 E.3", "M104 S9999 ; ignore", "G28", "; EXECUTABLE_BLOCK_END_NOT",
  ]));
  assert.equal(r.complete, true);
  assert.ok(r.details.skipped.badWords >= 3);
  assert.equal(r.details.features["Support"], undefined);
  assert.equal(r.facts["gcode.tool_xy_outside_area_count"], 0);
});

test("a long run of segments does not make the grid explode (skipped and counted)", async () => {
  const lines = [...first(0, 0), ...feature("Outer wall"), "G1 X50000 Y50000 E5"];
  const r = await scan(gcode(lines));
  assert.equal(r.complete, true);
  assert.equal(typeof r.details.skipped.gridSegments, "number");
});

test("allowPartial never turns an absence into a zero: a cut file with a protected move only leaves every travel count unknown", async () => {
  const whole = gcode([...first(10, 10), ...feature("Outer wall"), ext(20, 10), ...PROTECT, travel(50, 50), "G1 E.8 F1800", ext(60, 50)]);
  const r = await scan(whole.slice(0, whole.indexOf("; MACHINE_END_GCODE_START")), { allowPartial: true });
  assert.equal(r.complete, false);
  assert.equal(r.facts["gcode.layer_count"], 1); // a presence is kept
  for (const name of ["gcode.unprotected_travel_count", "gcode.unprotected_travel_crossing_count", "gcode.unprotected_travel_curl_risk_count", "gcode.zhop_lift_count", "gcode.unprotected_travel_over_20mm_count", "gcode.zhop_type_mismatch"]) {
    assert.equal(name in r.facts, false, name);
    assert.ok(r.blind.includes(name), name);
    assert.match(r.evidence[name].notes, /cannot show an absence/, name);
  }
  assert.deepEqual(r.facts["gcode.unprotected_travels_by_origin"], undefined); // an empty list is an absence too
  assert.match(r.evidence["gcode.min_line_width_mm"].notes, /minimum an upper bound/); // not worded as a lower bound
});

const WALL = [ // a square wall, then a travel from (6,15) through its left side at x=10
  ...first(10, 10), ...feature("Outer wall"), ...square(10, 10, 20, 20),
  ...PROTECT, travel(5, 15), "G1 E.8 F1800", ext(6, 15), travel(15, 15), ext(16, 15),
];
const CROSS = "gcode.unprotected_travel_crossing_count";
test("a cap that trips makes the crossing facts approximate or unknown, never a quiet zero", async () => {
  const full = await scan(gcode(WALL));
  assert.equal(full.facts[CROSS], 1);
  assert.equal(full.evidence[CROSS].approx, false);
  assert.deepEqual(full.details.skipped, { longLines: 0, badWords: 0, gridSegments: 0, crossingRuns: 0, blockLines: 0 });
  assert.ok(full.details.unprotected.work > 0);
  // obstacle segments per layer and grid cells per layer: the wall's left side is not entered, the crossing is not seen, 0 is not shown
  for (const limits of [{ layerSegments: 3 }, { layerCells: 4 }]) {
    const r = await scan(gcode(WALL), { limits });
    assert.ok(r.details.skipped.gridSegments > 0, JSON.stringify(limits));
    assert.equal(r.facts["gcode.unprotected_travel_count"], 1);
    for (const name of [CROSS, "gcode.unprotected_travel_curl_risk_count", "gcode.unprotected_travels_in_support"]) {
      assert.ok(r.blind.includes(name), `${name} ${JSON.stringify(limits)}`);
      assert.match(r.evidence[name].notes, /work caps.*capped scan cannot show an absence/);
    }
    assert.equal(r.evidence["gcode.unprotected_travels_by_origin"].approx, true);
    assert.match(r.evidence["gcode.unprotected_travels_by_origin"].notes, /work caps/);
  }
  // points per run: the long run gets no crossing test (counted), the travel itself is still counted
  const run = [...WALL.slice(0, -2), "G1 X8 Y16 F60000", "G1 X12 Y17", "G1 X15 Y15", ext(16, 15)];
  const kept = await scan(gcode(run));
  assert.equal(kept.facts[CROSS], 1);
  const cut = await scan(gcode(run), { limits: { runPoints: 2 } });
  assert.equal(cut.facts["gcode.unprotected_travel_count"], 1);
  assert.equal(cut.details.skipped.crossingRuns, 1);
  assert.ok(cut.blind.includes(CROSS));
  // work budget: the test that spends it is cut short, a crossing it did find is kept and marked approximate
  const spent = await scan(gcode(WALL), { limits: { work: 1 } });
  assert.equal(spent.details.skipped.crossingRuns, 1);
  assert.equal(spent.facts[CROSS], 1);
  assert.equal(spent.evidence[CROSS].approx, true);
  assert.match(spent.evidence[CROSS].notes, /lower bounds/);
});

test("the printable-area polygon and the header/config keys are capped", async () => {
  const ring = n => Array.from({ length: n }, (_, i) => `${Math.round(128 + 100 * Math.cos((2 * Math.PI * i) / n))}x${Math.round(128 + 100 * Math.sin((2 * Math.PI * i) / n))}`).join(",");
  const exec = [...first(130, 130), ...feature("Outer wall"), ext(140, 130)];
  const small = await scan(gcode(exec, { extruder_printable_area: ring(12) }));
  assert.equal(small.facts["gcode.tool_xy_outside_area_count"], 0);
  const big = await scan(gcode(exec, { extruder_printable_area: ring(300) }));
  assert.ok(big.blind.includes("gcode.tool_xy_outside_area_count"));
  assert.match(big.evidence["gcode.tool_xy_outside_area_count"].notes, /more than 256 vertices/);
  assert.equal((await scan(gcode(exec, { extruder_printable_area: ring(300) }), { limits: { polyVertices: 400 } })).facts["gcode.tool_xy_outside_area_count"], 0);
  // keys: only the first two config keys (retraction_minimum_travel, filament_map) are stored; the cap is not silent, the config counts as unread
  const keyed = await scan(gcode(exec), { limits: { keys: 2 } });
  assert.equal(keyed.complete, false);
  assert.ok(keyed.details.skipped.blockLines > 0);
  assert.equal(keyed.facts["gcode.unprotected_travel_count"], undefined);
  assert.ok(keyed.blind.includes("gcode.unprotected_travel_count"));
  assert.match(keyed.evidence["gcode.unprotected_travel_count"].notes, /passed their cap/);
});

test("a header/config region past its byte budget is not stored and makes the scan incomplete (not read as a config without spiral_mode and the like)", async () => {
  const exec = [...first(130, 130), ...feature("Outer wall"), ext(140, 130)];
  const ok = await scan(gcode(exec));
  assert.equal(ok.complete, true);
  assert.equal(ok.details.skipped.blockLines, 0);
  // junk lines inside the config block, then the keys that matter (spiral_mode, print_sequence, enable_support) come after the budget
  const lines = gcode(exec, { spiral_mode: null, print_sequence: null, enable_support: null }).split("\n");
  lines.splice(lines.indexOf("; CONFIG_BLOCK_END"), 0, ...Array.from({ length: 200 }, (_, i) => `; junk${i} = ${"j".repeat(1000)}`), "; spiral_mode = 1", "; enable_support = 1");
  const r = await scan(lines.join("\n"), { limits: { blockBytes: 100_000 } });
  assert.equal(r.complete, false);
  assert.ok(r.details.skipped.blockLines >= 2);
  assert.equal(r.facts["gcode.unprotected_travel_count"], undefined);
  assert.match(r.evidence["gcode.unprotected_travel_count"].notes, /passed their cap \(100000 characters/);
  // the default budget (4 MiB) leaves the same file alone
  assert.equal((await scan(lines.join("\n"))).complete, true);
});

test("a 60 KB whitespace header line is read in linear time", async () => {
  const lines = gcode([...first(10, 10), ...feature("Outer wall"), ext(20, 10)]).split("\n");
  const at = lines.indexOf("; HEADER_BLOCK_END");
  lines.splice(at, 0, ...[1, 2, 3].map(() => `; ${" ".repeat(60_000)}`), `;${" ".repeat(60_000)}x : value`);
  const t0 = performance.now();
  const r = await scan(lines.join("\n"));
  assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`); // a lazy-group regex needed about 2 s per such line
  assert.equal(r.details.header.layers, 2); // the header keys around it still parse
  assert.equal(r.complete, true);
});

test("every fact name the scan can produce is either in facts or in blind, never both, with evidence for each", async () => {
  const r = await scan(gcode([...first(10, 10), ...feature("Outer wall"), ext(20, 10), ext(20, 20)]));
  for (const name of GCODE_SCAN_FACTS) {
    assert.ok((name in r.facts) !== r.blind.includes(name), name);
    assert.ok(r.evidence[name], name);
    assert.equal(typeof r.evidence[name].source, "string");
    assert.equal(typeof r.evidence[name].method, "string");
    assert.equal(typeof r.evidence[name].approx, "boolean");
  }
  assert.ok(r.blind.includes("gcode.missing_thin_feature_count")); // needs the mesh
  assert.equal(r.stats.lines > 20, true);
});

// ---- the real plate ----

test("the head of the real X2D plate reproduces the probe's head numbers (the cut last line is the one difference)", { timeout: 60000 }, async () => {
  const r = await scanGcodeFile(HEAD, { allowPartial: true });
  assert.equal(r.complete, false);
  assert.equal(r.stats.lines, 167619); // the probe saw 167 620 with the cut last line
  assert.equal(r.facts["gcode.layer_count"], 77);
  // probe: 749 unprotected, the 749th is the cut last line `G1 X116.11 Y109.74` (1.6 mm, no E yet): it is not a travel
  assert.equal(r.facts["gcode.unprotected_travel_count"], 748);
  assert.equal(r.facts["gcode.unprotected_travel_crossing_count"], 267);
  assert.equal(r.facts["gcode.unprotected_travel_curl_risk_count"], 7);
  assert.deepEqual(r.details.unprotected.byOrigin["Floating vertical shell"], { unprotected: 389, crossing: 258 });
  assert.deepEqual(r.details.unprotected.byOrigin["Sparse infill"], { unprotected: 310, crossing: 3 });
  assert.deepEqual(r.details.unprotected.byOrigin["Bridge"], { unprotected: 7, crossing: 3 });
  assert.deepEqual(r.details.unprotected.byOrigin["Internal solid infill"], { unprotected: 23, crossing: 3 });
  assert.equal(r.details.unprotected.afterSparseSevere, 1);
  assert.equal(r.details.lifts.spiral, 4239);
  assert.equal(r.facts["gcode.first_layer_speed_mm_s"], 105);
  assert.equal(r.facts["gcode.first_layer_area_mm2"], 1827.4);
  assert.equal(r.facts["gcode.min_line_width_mm"], 0.353325);
  assert.ok(r.blind.includes("gcode.tool_xy_outside_area_count")); // 0 outside moves in a partial scan: not shown
  assert.equal(r.details.features["Outer wall"].segments, 32182);
  assert.equal(r.details.features["Floating vertical shell"].segments, 5762);
  assert.ok(r.evidence["gcode.unprotected_travel_count"].approx);
  // not partial: nothing is claimed
  const strict = await scanGcodeFile(HEAD);
  assert.deepEqual(strict.facts, {});
});

test("the full real plate (41 MB, read as a stream from the sliced 3MF) reproduces the probe's frozen numbers", { skip: !fs.existsSync(SAMPLE_3MF) && "sample sliced 3MF not present", timeout: 120000 }, async () => {
  const r = await scanPlateGcode(SAMPLE_3MF, 0, { supportUsed: false, auxExtruderUsed: false });
  const f = r.facts;
  assert.equal(r.complete, true);
  assert.equal(r.stats.lines, 1777582);
  assert.equal(r.stats.bytes, 40977961);
  assert.equal(f["gcode.layer_count"], 896);
  assert.equal(f["gcode.extruded_weight_g"], 234.758); // header: 234.76
  // frozen by the probe: 7054 unprotected, 3097 crossing, 279 over 20 mm, 17 curl risk, longest 114.1 mm
  assert.equal(f["gcode.unprotected_travel_count"], 7054);
  assert.equal(f["gcode.unprotected_travel_crossing_count"], 3097);
  assert.equal(f["gcode.unprotected_travel_over_20mm_count"], 279);
  assert.equal(f["gcode.unprotected_travel_curl_risk_count"], 17);
  assert.equal(f["gcode.unprotected_travel_max_mm"], 114.139);
  assert.equal(r.details.unprotected.maxZ, 172.8);
  assert.equal(r.details.unprotected.crossingSevere, 3027);
  assert.equal(r.details.unprotected.afterSparseSevere, 19);
  assert.deepEqual(r.details.unprotected.byOrigin, {
    "Floating vertical shell": { unprotected: 3539, crossing: 3008 }, "Sparse infill": { unprotected: 3322, crossing: 27 },
    "Internal solid infill": { unprotected: 99, crossing: 54 }, "Bridge": { unprotected: 38, crossing: 6 },
    "Top surface": { unprotected: 36, crossing: 2 }, "Gap infill": { unprotected: 20, crossing: 0 },
  });
  assert.deepEqual(r.details.unprotected.crossedRoles, { "Floating vertical shell": 3014, "Bridge": 15, "Internal solid infill": 58, "Inner wall": 19, "Top surface": 2 });
  assert.deepEqual(f["gcode.unprotected_travels_by_origin"][0], "Floating vertical shell: 3539 unprotected, 3008 crossing");
  assert.equal(f["gcode.unprotected_travels_in_support"], 0);
  // the probe also counted the machine-start run and the end-of-print retract+lift as lifts (46 106, 896 at a layer change);
  // they are not travels of the part, so this scan has one fewer of each: 46 105 lifts, 895 at a layer change, 45 210 - 1 in the layer
  assert.equal(r.details.lifts.spiral, 46104);
  assert.equal(r.details.lifts.layerChange, 895);
  assert.equal(r.details.retractRuns, 46105);
  assert.equal(f["gcode.zhop_lift_count"], 45209);
  assert.equal(f["gcode.zhop_type_mismatch"], false); // z_hop_types is Auto Lift
  assert.equal(f["gcode.first_layer_speed_mm_s"], 105);
  assert.equal(f["gcode.first_layer_wall_speed_mm_s"], 50);
  assert.equal(f["gcode.first_layer_area_mm2"], 1827.4);
  assert.equal(f["gcode.min_line_width_mm"], 0.26657);
  assert.equal(f["gcode.top_layer_count"], 16);
  assert.ok(f["gcode.flow_limit_exceeded_share"] < 1e-6 && f["gcode.flow_limit_exceeded_share"] > 0);
  assert.equal(Math.round(r.details.flow.maxMm3s * 100) / 100, 22.56);
  assert.equal(f["gcode.tool_xy_outside_area_count"], 0);
  assert.equal(f["plate.tool_changes"], 0);
  assert.equal(f["plate.waste_weight_g"], 0);
  assert.equal(f["gcode.support_line_count"], 0);
  assert.equal(f["gcode.aux_nozzle_max_extrusion_feedrate_mm_s"], 0);
  assert.deepEqual(r.blind, ["gcode.first_layer_brim_present", "gcode.missing_thin_feature_count"]);
  assert.equal(r.details.header.estimatedTimeS, 35467);
  assert.equal(r.details.header.layers, 896);
  assert.ok(Math.abs(f["gcode.extruded_weight_g"] - r.details.header.weightG) < 0.05);
  // loose bound: the probe needed 0.9 s, this scan about 0.5 s; the requirement is 5 s
  assert.ok(r.stats.ms < 5000, `scan took ${r.stats.ms} ms`);
});

test("memory does not grow with the file: 140 MB of generated G-code is scanned while live memory stays flat", { timeout: 120000 }, () => {
  // live = heap + external (Buffers) right after a forced collection, sampled in the middle of the scan every 100 layers; a scanner that
  // kept the lines, the chunks or a segment per line would grow with the 140 MB, one that streams stays near the size of one chunk
  const script = `
    import { scanGcodeStream } from ${JSON.stringify(new URL("../dist/tuning/gcode-scan.js", import.meta.url).href)};
    const head = ["; HEADER_BLOCK_START","; HEADER_BLOCK_END","; CONFIG_BLOCK_START","; retraction_minimum_travel = 1","; filament_map = 1","; filament_diameter = 1.75","; filament_density = 1.26","; CONFIG_BLOCK_END","; EXECUTABLE_BLOCK_START","M83","; MACHINE_START_GCODE_END"].join("\\n") + "\\n";
    let peak = 0;
    async function* source() {
      yield head;
      for (let layer = 0; layer < 3000; layer++) {
        let text = "; CHANGE_LAYER\\n; Z_HEIGHT: " + (layer * 0.2 + 0.2) + "\\n; FEATURE: Outer wall\\n; LINE_WIDTH: 0.42\\n";
        for (let i = 0; i < 2500; i++) text += "G1 X" + (10 + (i % 100)) + " Y" + (10 + (i % 90)) + " E.04644\\n";
        text += "G1 X5 Y5 F60000\\n";
        yield text;
        if (layer % 100 === 99) { globalThis.gc(); const m = process.memoryUsage(); peak = Math.max(peak, m.heapUsed + m.external); }
      }
      yield "; MACHINE_END_GCODE_START\\n; EXECUTABLE_BLOCK_END\\n";
    }
    const r = await scanGcodeStream(source());
    console.log(JSON.stringify({ bytes: r.stats.bytes, layers: r.facts["gcode.layer_count"], complete: r.complete, peakMb: peak / 2 ** 20 }));
  `;
  const run = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8", maxBuffer: 1 << 20 });
  assert.equal(run.status, 0, run.stderr.slice(-500));
  const out = JSON.parse(run.stdout.trim().split("\n").pop());
  assert.ok(out.bytes > 100 * 2 ** 20, `scanned only ${out.bytes} bytes`);
  assert.equal(out.layers, 3000);
  assert.equal(out.complete, true);
  assert.ok(out.peakMb < 40, `live memory reached ${out.peakMb} MB while scanning ${Math.round(out.bytes / 2 ** 20)} MB`);
});

test("hostile header/config text does not pin memory in proportion to the input", { timeout: 120000 }, () => {
  // 1000 keys with values of 24 characters, each in a chunk with 240 KB of other comment lines (about 250 MB in all): a stored substring of such a
  // chunk keeps the whole chunk text alive (V8 sliced strings), so the values are copied. A: the junk lies inside the config block (the byte
  // budget stops it, the scan is incomplete); B: tiny blocks with the junk between them (nothing for the budget to count). D: 4000 config lines of 60 KB.
  const script = `
    import { scanGcodeStream } from ${JSON.stringify(new URL("../dist/tuning/gcode-scan.js", import.meta.url).href)};
    const junk = Buffer.from(Array.from({ length: 4000 }, (_, i) => "; junk line number " + i + " " + "j".repeat(40) + "\\n").join(""));
    const value = "x".repeat(24), long = "v".repeat(60000);
    const close = "; CONFIG_BLOCK_END\\n; EXECUTABLE_BLOCK_START\\n; MACHINE_START_GCODE_END\\n; MACHINE_END_GCODE_START\\n; EXECUTABLE_BLOCK_END\\n";
    const shapes = {
      A: function* () { yield Buffer.from("; CONFIG_BLOCK_START\\n"); for (let k = 0; k < 1000; k++) yield Buffer.concat([Buffer.from("; k" + k + " = " + value + "\\n"), junk]); yield Buffer.from(close); },
      B: function* () { for (let k = 0; k < 1000; k++) yield Buffer.concat([Buffer.from("; CONFIG_BLOCK_START\\n; k" + k + " = " + value + "\\n; CONFIG_BLOCK_END\\n"), junk]); yield Buffer.from("; EXECUTABLE_BLOCK_START\\n; EXECUTABLE_BLOCK_END\\n"); },
      D: function* () { yield Buffer.from("; CONFIG_BLOCK_START\\n"); for (let k = 0; k < 4000; k++) yield Buffer.from("; key" + k + " = " + long + "\\n"); yield Buffer.from(close); },
    };
    const out = {};
    for (const [name, make] of Object.entries(shapes)) {
      let live = 0;
      async function* source() { yield* make(); globalThis.gc(); globalThis.gc(); const m = process.memoryUsage(); live = (m.heapUsed + m.external) / 2 ** 20; }
      const r = await scanGcodeStream(source(), { maxBytes: 2 ** 31 });
      out[name] = { complete: r.complete, liveMb: live, mb: r.stats.bytes / 2 ** 20 };
    }
    console.log(JSON.stringify(out));
  `;
  const run = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8", maxBuffer: 1 << 20 });
  assert.equal(run.status, 0, run.stderr.slice(-500));
  const out = JSON.parse(run.stdout.trim().split("\n").pop());
  for (const name of ["A", "B", "D"]) assert.ok(out[name].mb > 200, `${name} fed only ${out[name].mb} MB`);
  assert.equal(out.A.complete, false);
  assert.equal(out.B.complete, true);
  assert.equal(out.D.complete, false);
  for (const name of ["A", "B", "D"]) assert.ok(out[name].liveMb < 60, `${name}: ${out[name].liveMb} MB live while the input was 200+ MB`);
});
