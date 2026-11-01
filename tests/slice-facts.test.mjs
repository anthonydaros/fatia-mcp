// plate.* and slicer.* facts (src/tuning/slice-facts.ts) from slice_info.config, result.json, filament_sequence.json and the G-code scan.
// The XML is the real slice_info.config of the X2D sample (out/desk-organizer_sliced.3mf), parsed the way src/3mf_parser.ts parses it.
import assert from "node:assert/strict";
import test from "node:test";
import { parseStringPromise } from "xml2js";
import { scanGcodeStream } from "../dist/tuning/gcode-scan.js";
import { scanHints, sliceFacts } from "../dist/tuning/slice-facts.js";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="02.08.04.57"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="35467"/>
    <metadata key="weight" value="234.76"/>
    <metadata key="support_used" value="false"/>
    <metadata key="filament_maps" value="1 1"/>
    <object identify_id="404" name="Frame" skipped="false" />
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#000000" used_m="77.46" used_g="234.76" group_id="0" nozzle_diameter="0.40" volume_type="Standard" used_for_object="true" used_for_support="false" total_load_time="29.00" total_unload_time="0.00"/>
  </plate>
</config>`;
const parse = async xml => (await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true })).config;
const RESULT = { plate_index: 1, sliced_plates: [{ id: 1, total_predication: 35467.1953125, filament_change_times: 0, warning_message: "", filaments: [{ id: 1, main_used_g: 234.7579, total_used_g: 234.7579 }] }] };
const SEQUENCE = { plate_1: { nozzle_sequence: [0], optimal_assignment: [0, 0], sequence: [1] }, plate_2: { optimal_assignment: [] } };

test("the sample plate: time, weight, no warnings, one filament so grouping is fine; tool changes come from result.json without a scan", async () => {
  const f = sliceFacts({ plateIndex: 0, sliceInfo: await parse(SAMPLE), result: RESULT, filamentSequence: SEQUENCE, source: "sample.3mf" });
  assert.equal(f.facts["plate.time_s"], 35467);
  assert.equal(f.facts["plate.weight_g"], 234.76);
  assert.equal(f.evidence["plate.time_s"].source, "sample.3mf (slice_info.config)");
  assert.equal(f.facts["slicer.warning_count"], 0);
  assert.deepEqual(f.facts["slicer.warnings"], []);
  assert.equal(f.facts["slicer.grouping_not_ideal_warning"], false);
  assert.equal(f.facts["plate.tool_changes"], 0);
  assert.equal(f.evidence["plate.tool_changes"].approx, true); // result.json's counter was never checked on a multi-filament plate
  assert.deepEqual(f.blind, ["plate.waste_weight_g"]); // only the G-code can say
});

test("with the G-code scan: tool changes and waste are the measured ones, and a disagreeing result.json is noted", async () => {
  const gcode = await scanGcodeStream([Buffer.from([
    "; HEADER_BLOCK_START", "; BambuStudio 02.08.04.57", "; total layer number: 1", "; HEADER_BLOCK_END", "; CONFIG_BLOCK_START", "; retraction_minimum_travel = 1",
    "; filament_map = 1", "; filament_diameter = 1.75", "; filament_density = 1.26", "; enable_prime_tower = 0", "; CONFIG_BLOCK_END", "; EXECUTABLE_BLOCK_START",
    "; MACHINE_START_GCODE_END", "; CHANGE_LAYER", "; Z_HEIGHT: 0.2", "; FEATURE: Outer wall", "G1 X10 Y10 E.1", "; MACHINE_END_GCODE_START", "; EXECUTABLE_BLOCK_END", "",
  ].join("\n"))]);
  const sliceInfo = await parse(SAMPLE);
  const f = sliceFacts({ plateIndex: 0, sliceInfo, result: RESULT, filamentSequence: SEQUENCE, gcode });
  assert.equal(f.facts["plate.tool_changes"], 0);
  assert.equal(f.evidence["plate.tool_changes"].approx, false);
  assert.equal(f.facts["plate.waste_weight_g"], 0);
  assert.deepEqual(f.blind, []);
  const disagree = sliceFacts({ plateIndex: 0, sliceInfo, result: { ...RESULT, sliced_plates: [{ ...RESULT.sliced_plates[0], filament_change_times: 3 }] }, gcode });
  assert.equal(disagree.facts["plate.tool_changes"], 0); // the G-code count wins
  assert.match(disagree.evidence["plate.tool_changes"].notes, /result\.json says 3/);
  assert.equal(disagree.evidence["plate.tool_changes"].approx, true);
});

test("a grouping warning in the slicing result is the fact; the proxy is flagged approximate; nothing to compare is blind", async () => {
  const two = SAMPLE.replace('<metadata key="filament_maps" value="1 1"/>', '<metadata key="filament_maps" value="1 2"/>')
    .replace("</plate>", '<filament id="2" type="PLA" used_g="10.00" used_for_support="false"/></plate>');
  const sliceInfo = await parse(two);
  const warned = await parse(two.replace("</plate>", '<warning msg="Your filament grouping method in the sliced file is not optimal." level="1" error_code ="1"/></plate>'));
  const w = sliceFacts({ plateIndex: 0, sliceInfo: warned, filamentSequence: SEQUENCE });
  assert.equal(w.facts["slicer.grouping_not_ideal_warning"], true);
  assert.equal(w.evidence["slicer.grouping_not_ideal_warning"].approx, false);
  assert.equal(w.facts["slicer.warning_count"], 1);
  assert.match(w.facts["slicer.warnings"][0], /grouping method/);
  const viaResult = sliceFacts({ plateIndex: 0, sliceInfo, result: { sliced_plates: [{ id: 1, warning_message: "Cost 12g filament and 3 changes more than optimal grouping." }] } });
  assert.equal(viaResult.facts["slicer.grouping_not_ideal_warning"], true);
  const differ = sliceFacts({ plateIndex: 0, sliceInfo, filamentSequence: SEQUENCE }); // maps [0,1] against optimal [0,0]
  assert.equal(differ.facts["slicer.grouping_not_ideal_warning"], true);
  assert.equal(differ.evidence["slicer.grouping_not_ideal_warning"].approx, true);
  const equal = sliceFacts({ plateIndex: 0, sliceInfo, filamentSequence: { plate_1: { optimal_assignment: [0, 1] } } });
  assert.equal(equal.facts["slicer.grouping_not_ideal_warning"], false);
  assert.equal(equal.evidence["slicer.grouping_not_ideal_warning"].approx, true);
  const none = sliceFacts({ plateIndex: 0, sliceInfo });
  assert.equal("slicer.grouping_not_ideal_warning" in none.facts, false);
  assert.ok(none.blind.includes("slicer.grouping_not_ideal_warning"));
});

test("an unsliced plate, a missing slice_info and a malformed one are unknown, never 0, and never throw", async () => {
  const sliceInfo = await parse(SAMPLE);
  for (const input of [{ plateIndex: 1, sliceInfo }, { plateIndex: 0 }, { plateIndex: 0, sliceInfo: "not xml" }, { plateIndex: 0, sliceInfo: { plate: 7 } }]) {
    const f = sliceFacts(input);
    for (const name of ["plate.time_s", "plate.weight_g", "slicer.warning_count", "slicer.grouping_not_ideal_warning"]) {
      assert.equal(name in f.facts, false, `${name} for ${JSON.stringify(input.plateIndex)}`);
      assert.ok(f.blind.includes(name));
      assert.ok(f.evidence[name].notes);
    }
  }
});

test("time and weight fall back to result.json, then to the G-code header", async () => {
  const gcode = await scanGcodeStream([Buffer.from("; HEADER_BLOCK_START\n; BambuStudio 02.08.04.57\n; model printing time: 9h 45m 58s; total estimated time: 9h 51m 7s\n; total filament weight [g] : 234.76\n; HEADER_BLOCK_END\n")]);
  const fromResult = sliceFacts({ plateIndex: 0, result: RESULT });
  assert.equal(fromResult.facts["plate.time_s"], 35467);
  assert.equal(fromResult.evidence["plate.time_s"].source, "slice result (result.json)");
  assert.ok(Math.abs(fromResult.facts["plate.weight_g"] - 234.7579) < 1e-9);
  const fromHeader = sliceFacts({ plateIndex: 0, gcode });
  assert.equal(fromHeader.facts["plate.time_s"], 35467);
  assert.equal(fromHeader.facts["plate.weight_g"], 234.76);
  assert.match(fromHeader.evidence["plate.time_s"].source, /G-code header/);
});

test("scanHints: support unused and no used filament on extruder 2 are what let the scan call a zero known", async () => {
  assert.deepEqual(scanHints(await parse(SAMPLE), 0), { supportUsed: false, auxExtruderUsed: false });
  assert.deepEqual(scanHints(await parse(SAMPLE), 1), {}); // plate 2 was not sliced
  const aux = SAMPLE.replace('value="1 1"', 'value="1 2"').replace("</plate>", '<filament id="2" type="PLA" used_g="3.00" used_for_support="false"/></plate>');
  assert.equal(scanHints(await parse(aux), 0).auxExtruderUsed, true);
  const unusedAux = SAMPLE.replace('value="1 1"', 'value="1 2"').replace("</plate>", '<filament id="2" type="PLA" used_g="0.00" used_for_support="false"/></plate>');
  assert.equal(scanHints(await parse(unusedAux), 0).auxExtruderUsed, false);
  const supported = SAMPLE.replace('used_for_support="false"', 'used_for_support="true"'); // support_used says false, a filament says it is used for support
  assert.equal("supportUsed" in scanHints(await parse(supported), 0), false);
  assert.equal(scanHints(await parse(SAMPLE.replace('support_used" value="false"', 'support_used" value="true"')), 0).supportUsed, true);
  assert.deepEqual(scanHints(undefined, 0), {});
});
