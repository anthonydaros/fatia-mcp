// src/tuning/project-writer.ts and its text helpers, on in-test zips (no Bambu Studio needed): what is written, what is left alone,
// what is refused. The real-CLI proof that a written project slices with every tuned key in the G-code is tuning-project-writer-e2e.test.mjs.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { parseStringPromise } from "xml2js";
import { checkBlockValue, expectedBlockElements, readConfigBlock } from "../dist/tuning/config-block.js";
import { writeTunedProject } from "../dist/tuning/project-writer.js";
import { blankFilamentSequence, dropRelationships, listObjects, setMembers, setObjectSettings, stripSliceResults } from "../dist/tuning/project-text.js";
import { listSafe3mfEntries } from "../dist/safety/archive.js";

const X2D = "Bambu Lab X2D 0.4 nozzle";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const variants = ["Direct Drive Standard", "Direct Drive High Flow", "Bowden Standard"];

/** A small project in Studio's layout (4-space JSON, one list element per line): 2 filaments, 3 extruder variants. */
const baseConfig = (extra = {}) => ({
  printer_settings_id: X2D,
  print_settings_id: "0.20mm Standard @BBL X2D",
  filament_settings_id: ["Bambu PLA Basic @BBL X2D 0.4 nozzle", "Bambu PLA Basic @BBL X2D 0.4 nozzle"],
  print_extruder_variant: variants,
  print_extruder_id: ["1", "1", "2"],
  printer_extruder_variant: variants,
  printer_extruder_id: ["1", "1", "2"],
  filament_extruder_variant: [...variants, ...variants],
  outer_wall_speed: ["200", "500", "50"],
  z_hop: ["0.4", "0.4", "0.4"],
  nozzle_temperature: ["220", "220", "220", "220", "220", "220"],
  fan_min_speed: ["100", "100"],
  sparse_infill_pattern: "grid",
  wall_loops: "2",
  different_settings_to_system: ["", "", "", ""],
  ...extra,
});
const studioJson = (config, eol = "\n") => JSON.stringify(config, null, 4).replace(/\n/g, eol);

const MODEL_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="Cube A"/>
    <metadata key="extruder" value="1"/>
    <metadata face_count="12"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="Cube A"/>
    </part>
  </object>
  <object id="4">
    <metadata key="name" value="Cube B"/>
    <metadata key="extruder" value="2"/>
    <metadata key="wall_loops" value="3"/>
    <metadata face_count="12"/>
    <part id="3" subtype="normal_part">
      <metadata key="name" value="Cube B"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>
    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>
  </plate>
</config>
`;
const SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="02.08.04.57"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="546"/>
  </plate>
</config>
`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/Metadata/plate_1.gcode" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/>
</Relationships>`;
const SEQUENCE_EMPTY = '{"plate_1":{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]},"plate_2":{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]}}';
const SEQUENCE_SLICED = '{"plate_1":{"nozzle_sequence":[0],"optimal_assignment":[0,0],"sequence":[1]},"plate_2":{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]}}';
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function workdir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "project-writer-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
/** entries: [name, data, stored?] in archive order. */
async function zipBytes(entries) {
  const zip = new JSZip();
  for (const [name, data, stored] of entries) zip.file(name, data, { createFolders: false, compression: stored ? "STORE" : "DEFLATE" });
  return zip.generateAsync({ type: "nodebuffer" });
}
const projectEntries = ({ config = studioJson(baseConfig()), sliced = true, sequence = sliced ? SEQUENCE_SLICED : SEQUENCE_EMPTY, modelSettings = sliced ? MODEL_SETTINGS : MODEL_SETTINGS.replace(/\s*<metadata key="gcode_file"[^>]*\/>/, "") } = {}) => [
  ["[Content_Types].xml", "<Types/>"],
  ["Metadata/plate_1.png", PNG, true],
  ["3D/Objects/object_1.model", "<model>cube</model>"],
  ["Metadata/project_settings.config", config],
  ["Metadata/model_settings.config", modelSettings],
  ["Metadata/filament_sequence.json", sequence],
  ["Metadata/slice_info.config", sliced ? SLICE_INFO : SLICE_INFO.replace(/\s*<plate>[\s\S]*<\/plate>/, "")],
  ...(sliced ? [
    ["Metadata/plate_1.gcode", "; CONFIG_BLOCK_START\nG1 X0\n"],
    ["Metadata/plate_1.gcode.md5", "d41d8cd98f00b204e9800998ecf8427e"],
    ["Metadata/plate_1.json", "{\"bbox_all\":[0,0,1,1]}"],
    ["Metadata/_rels/model_settings.config.rels", RELS],
  ] : []),
];
async function project(t, options = {}) {
  const dir = await workdir(t);
  const file = path.join(dir, "part.3mf");
  await fs.writeFile(file, await zipBytes(projectEntries(options)));
  return { dir, file, bytes: await fs.readFile(file) };
}
const open = async file => JSZip.loadAsync(await fs.readFile(file));
const configOf = async file => JSON.parse(await (await open(file)).file("Metadata/project_settings.config").async("string"));
const write = (p, extra) => writeTunedProject({ source: p.file, output: path.join(p.dir, "out", "tuned.3mf"), target: { printerPreset: X2D }, ...extra });

test("a scalar fills every element, 'elements' fills only the selected ones, and an unchanged value is not written", async t => {
  const p = await project(t);
  const r = await write(p, {
    changes: [
      { key: "z_hop", value: "0.8", scope: "printer" },
      { key: "outer_wall_speed", value: "150", scope: "process", elements: { index_by: "print_extruder_variant", starts_with: "Bowden" } },
      { key: "sparse_infill_pattern", value: "gyroid", scope: "process" },
      { key: "wall_loops", value: "2", scope: "process" },
    ],
  });
  const c = await configOf(r.path);
  assert.deepEqual([c.z_hop, c.outer_wall_speed, c.sparse_infill_pattern, c.wall_loops], [["0.8", "0.8", "0.8"], ["200", "500", "150"], "gyroid", "2"]);
  assert.deepEqual(r.changed_keys.map(x => [x.key, x.scope]), [["z_hop", "printer"], ["outer_wall_speed", "process"], ["sparse_infill_pattern", "process"]]);
  assert.deepEqual(r.changed_keys[1], { key: "outer_wall_speed", from: ["200", "500", "50"], to: ["200", "500", "150"], scope: "process" });
  assert.deepEqual(r.unchanged_keys, ["wall_loops"]);
});

test("different_settings_to_system gets the tuned keys in the entry of their scope, sorted, filament keys in every slot", async t => {
  const p = await project(t, { config: studioJson(baseConfig({ different_settings_to_system: ["wall_loops", "", "", "retraction_length"] })) });
  const nozzle = ["220", "220", "220", "215", "215", "215"]; // slot 2 changes; slot 1 is listed too, since a keep slice carries only what is listed
  const r = await write(p, {
    changes: [
      { key: "sparse_infill_pattern", value: "gyroid", scope: "process" },
      { key: "z_hop", value: "0.8", scope: "printer" },
      { key: "nozzle_temperature", value: nozzle, scope: "filament" },
    ],
  });
  assert.deepEqual((await configOf(r.path)).different_settings_to_system, ["sparse_infill_pattern;wall_loops", "nozzle_temperature", "nozzle_temperature", "retraction_length;z_hop"]);
});

// A hand-edited project holds the tuned values without listing them. The keep slice carries only what is listed, so the writer lists every
// requested key, including the ones whose value is already the project's.
test("a requested key whose value already equals the project's is still listed in different_settings_to_system", async t => {
  const edited = baseConfig({ z_hop: ["0.8", "0.8", "0.8"], nozzle_temperature: ["215", "215", "215", "215", "215", "215"], sparse_infill_pattern: "gyroid" });
  const p = await project(t, { config: studioJson(edited) });
  const r = await write(p, {
    changes: [
      { key: "z_hop", value: "0.8", scope: "printer" },
      { key: "nozzle_temperature", value: "215", scope: "filament" },
      { key: "sparse_infill_pattern", value: "gyroid", scope: "process" },
    ],
  });
  assert.deepEqual([r.changed_keys, r.unchanged_keys], [[], ["z_hop", "nozzle_temperature", "sparse_infill_pattern"]]);
  const c = await configOf(r.path);
  assert.deepEqual(c.different_settings_to_system, ["sparse_infill_pattern", "nozzle_temperature", "nozzle_temperature", "z_hop"]);
  assert.deepEqual([c.z_hop, c.sparse_infill_pattern], [["0.8", "0.8", "0.8"], "gyroid"], "the values themselves are untouched");
  // No request, no list: a project is not given a different_settings_to_system it did not ask for.
  const none = baseConfig();
  delete none.different_settings_to_system;
  const q = await project(t, { config: studioJson(none) });
  assert.ok(!("different_settings_to_system" in (await configOf((await write(q, {})).path))));
});

test("a project without different_settings_to_system gets one in the [process, filament 1..N, printer] layout", async t => {
  const config = baseConfig();
  delete config.different_settings_to_system;
  const p = await project(t, { config: studioJson(config) });
  const r = await write(p, { changes: [{ key: "sparse_infill_pattern", value: "gyroid", scope: "process" }, { key: "fan_min_speed", value: "90", scope: "filament" }] });
  const c = await configOf(r.path);
  assert.deepEqual(c.different_settings_to_system, ["sparse_infill_pattern", "fan_min_speed", "fan_min_speed", ""]);
  assert.deepEqual(r.warnings, []);
});

test("a malformed different_settings_to_system is rebuilt with a warning", async t => {
  const p = await project(t, { config: studioJson(baseConfig({ different_settings_to_system: ["wall_loops", ""] })) });
  const r = await write(p, { changes: [{ key: "z_hop", value: "0.8", scope: "printer" }] });
  assert.deepEqual((await configOf(r.path)).different_settings_to_system, ["wall_loops", "", "", "z_hop"]);
  assert.match(r.warnings[0], /2 entries for 2 filaments \(expected 4\)/);
});

test("BOM, CRLF, layout and every untouched byte of project_settings.config survive; only the intended text changes", async t => {
  const source = `﻿${studioJson(baseConfig(), "\r\n")}`;
  const p = await project(t, { config: source });
  const r = await write(p, {
    changes: [
      { key: "sparse_infill_pattern", value: "gyroid", scope: "process" },
      { key: "outer_wall_speed", value: "150", scope: "process", elements: { index_by: "print_extruder_variant", starts_with: "Bowden" } },
    ],
  });
  const out = await (await open(r.path)).file("Metadata/project_settings.config").async("string");
  const expected = source
    .replace('"sparse_infill_pattern": "grid"', '"sparse_infill_pattern": "gyroid"')
    .replace('"outer_wall_speed": [\r\n        "200",\r\n        "500",\r\n        "50"', '"outer_wall_speed": [\r\n        "200",\r\n        "500",\r\n        "150"')
    .replace('"different_settings_to_system": [\r\n        ""', '"different_settings_to_system": [\r\n        "outer_wall_speed;sparse_infill_pattern"');
  assert.equal(out, expected);
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.ok(!/[^\r]\n/.test(out), "no bare line feed");
});

test("list edits: inline layout, exact element bytes, new keys appended, wrong shapes refused", () => {
  const text = '{ "a": ["1", "2", "3"], "b": "x", "c": [ "7" ] }';
  assert.equal(setMembers(text, { a: ["1", "9", "3"] }), '{ "a": ["1", "9", "3"], "b": "x", "c": [ "7" ] }');
  assert.equal(setMembers(text, { a: ["1", "2"] }), '{ "a": ["1", "2"], "b": "x", "c": [ "7" ] }');
  assert.equal(setMembers('{"a":["1","2"],"n":1}', { a: ["1", "9"], z: "new" }), '{"a":["1","9"],"n":1,\n    "z": "new"}');
  assert.equal(setMembers("{}", { k: "v" }), '{\n    "k": "v"\n}');
  assert.throws(() => setMembers(text, { a: "scalar-on-list" }), /is a list in the project/);
  assert.throws(() => setMembers(text, { b: ["x"] }), /is not a list in the project/);
  assert.throws(() => setMembers(text, { "bad key": "x" }), /Unsafe setting key/);
  assert.throws(() => setMembers(text, { a: ["1", "2\u0001"] }), /control characters/);
  assert.throws(() => setMembers("[1,2]", { a: "x" }), /an object was expected/);
  assert.throws(() => setMembers('{"a": "unterminated', { a: "x" }), /unterminated/);
});

test("a list keeps its length: a list of another length, a list for a scalar, a scalar for an absent aligned list are refused", async t => {
  const p = await project(t);
  await assert.rejects(write(p, { changes: [{ key: "z_hop", value: ["1", "2"], scope: "printer" }] }), /2 values given for a list of 3/);
  await assert.rejects(write(p, { changes: [{ key: "wall_loops", value: ["1"], scope: "process" }] }), /scalar in the project; a list was given/);
  await assert.rejects(write(p, { changes: [{ key: "z_hop", value: "1", scope: "printer", elements: { index_by: "no_such_list", starts_with: "B" } }] }), /needs the aligned list no_such_list/);
  await assert.rejects(write(p, { changes: [{ key: "z_hop", value: "1", scope: "printer", elements: { index_by: "print_extruder_variant", starts_with: "Nothing" } }] }), /no element .* starts with "Nothing"/);
  await assert.rejects(write(p, { changes: [{ key: "z_hop", value: "1", scope: "printer" }, { key: "z_hop", value: "2", scope: "printer" }] }), /given twice/);
  assert.deepEqual(await fs.readdir(p.dir), ["part.3mf"], "a refused write leaves nothing behind");
});

test("a key the project lacks is added as given, with a warning", async t => {
  const p = await project(t);
  const r = await write(p, { changes: [{ key: "brim_type", value: "outer_only", scope: "process" }] });
  const c = await configOf(r.path);
  assert.equal(c.brim_type, "outer_only");
  assert.deepEqual(c.different_settings_to_system, ["brim_type", "", "", ""]);
  assert.match(r.warnings[0], /brim_type is absent from the project/);
  const plate = await write(p, { changes: [{ key: "filament_map_mode", value: "Auto For Match", scope: "process" }] });
  assert.ok(plate.warnings.some(w => /filament_map_mode is a per-plate setting/.test(w)));
});

test("per-object overrides: by id, by name, or every object; existing values updated; values escaped; the rest of the XML untouched", async t => {
  const p = await project(t);
  const r = await write(p, { objectOverrides: { settings: { wall_loops: "4", xy_hole_compensation: "0.1" }, objects: ["2", "Cube B"] } });
  const xml = await (await open(r.path)).file("Metadata/model_settings.config").async("string");
  const expected = MODEL_SETTINGS
    .replace('<metadata key="gcode_file" value="Metadata/plate_1.gcode"/>', '<metadata key="gcode_file" value=""/>')
    .replace('<metadata key="extruder" value="1"/>', '<metadata key="extruder" value="1"/>\n    <metadata key="wall_loops" value="4"/>\n    <metadata key="xy_hole_compensation" value="0.1"/>')
    .replace('<metadata key="wall_loops" value="3"/>', '<metadata key="wall_loops" value="4"/>\n    <metadata key="xy_hole_compensation" value="0.1"/>');
  assert.equal(xml, expected);
  assert.deepEqual(r.object_overrides.map(e => [e.object, e.name, e.key, e.from, e.to]), [
    ["2", "Cube A", "wall_loops", null, "4"], ["2", "Cube A", "xy_hole_compensation", null, "0.1"],
    ["4", "Cube B", "wall_loops", "3", "4"], ["4", "Cube B", "xy_hole_compensation", null, "0.1"],
  ]);

  const all = await write(p, { objectOverrides: { settings: { wall_sequence: "a&b <\"c\"> 'd'" } } });
  const text = await (await open(all.path)).file("Metadata/model_settings.config").async("string");
  assert.match(text, /value="a&amp;b &lt;&quot;c&quot;&gt; &apos;d&apos;"/);
  const parsed = await parseStringPromise(text, { explicitArray: false, mergeAttrs: true });
  assert.deepEqual(parsed.config.object.map(o => o.metadata.find(m => m.key === "wall_sequence").value), Array(2).fill("a&b <\"c\"> 'd'"));

  const none = await write(p, { objectOverrides: { settings: { wall_loops: "4" }, objects: ["Cube A", "ghost"] } });
  assert.match(none.warnings[0], /Object "ghost" is not in the project/);
  await assert.rejects(write(p, { objectOverrides: { settings: { wall_loops: "4" }, objects: ["ghost"] } }), /No object of the project matches/);
});

test("object helpers: ids and names, an override equal to the current value is not an edit", () => {
  const objects = listObjects(MODEL_SETTINGS);
  assert.deepEqual(objects.map(o => [o.id, o.name]), [["2", "Cube A"], ["4", "Cube B"]]);
  const same = setObjectSettings(MODEL_SETTINGS, objects.slice(1), { wall_loops: "3" });
  assert.deepEqual([same.xml === MODEL_SETTINGS, same.edits], [true, []]);
  assert.throws(() => setObjectSettings(MODEL_SETTINGS, objects, { "bad key": "1" }), /Unsafe setting key/);
  assert.throws(() => listObjects('<config><object id="1"><metadata key="name" value="x"/>'), /unterminated/);
});

test("stripSliceResults and dropRelationships cut exactly what the regexes they replaced cut (CRLF, indent, trailing spaces, no closer)", () => {
  const strip = xml => xml.replace(/[ \t]*<plate>[\s\S]*?<\/plate>[ \t]*\r?\n?/g, "");
  for (const xml of [
    '<config>\r\n  <header/>\r\n  <plate>\r\n<a/>\r\n  </plate>\r\n\t<plate><b/></plate>  \r\n</config>\r\n',
    "<config>\n<plate>\n</plate>\n<plate>\n</plate>", "x <plate></plate>y", "<config>\n  <plate>\n<a/>\n", "<plate>a</plate>\r\r\n", "",
  ]) assert.equal(stripSliceResults(xml), strip(xml), JSON.stringify(xml));
  const rels = '<Relationships>\r\n  <Relationship Target="/Metadata/a.gcode" Id="rel-1" Type="t"/>\r\n  <Relationship Target="/b.png" Id="rel-2" Type="t"/>\r\n</Relationships>';
  assert.equal(dropRelationships(rels, new Set(["Metadata/a.gcode"])), '<Relationships>\r\n  <Relationship Target="/b.png" Id="rel-2" Type="t"/>\r\n</Relationships>');
  assert.equal(dropRelationships(rels, new Set(["b.png"])), rels.replace('  <Relationship Target="/b.png" Id="rel-2" Type="t"/>\r\n', ""));
});

// The metadata files come from an untrusted 3MF and are scanned on the event loop: a few KB of zip must not freeze the server.
test("the text helpers stay linear on hostile metadata (long whitespace runs, unclosed tags, thousands of objects)", () => {
  const timed = fn => { const t0 = performance.now(); let error; let value; try { value = fn(); } catch (e) { error = e; } return { value, error, ms: performance.now() - t0 }; };
  const quick = (label, result) => assert.ok(result.ms < 1000, `${label}: ${Math.round(result.ms)} ms`);

  const spaces = " ".repeat(200_000);
  const strip = timed(() => stripSliceResults(spaces));
  quick("stripSliceResults, spaces", strip);
  assert.equal(strip.value, spaces);
  const plates = "<plate>".repeat(40_000);
  const unclosed = timed(() => stripSliceResults(plates));
  quick("stripSliceResults, unclosed <plate>", unclosed);
  assert.equal(unclosed.value, plates);

  const rels = timed(() => dropRelationships("<Relationship ".repeat(40_000), new Set(["a"])));
  quick("dropRelationships, unclosed <Relationship", rels);
  assert.equal(rels.value?.length, 14 * 40_000);
  quick("dropRelationships, spaces", timed(() => dropRelationships(spaces, new Set(["a"]))));

  const flat = timed(() => listObjects('<object id="1"></object>'.repeat(4000) + spaces.repeat(10)));
  quick("listObjects, 4000 objects and 2 MB of text", flat);
  assert.equal(flat.value.length, 4000);
  const nested = timed(() => listObjects('<object id="1">'.repeat(40_000)));
  quick("listObjects, 40000 unclosed", nested);
  assert.match(nested.error.message, /unterminated/);
  const open = timed(() => listObjects(`<object${spaces}`));
  quick("listObjects, unterminated tag", open);
  assert.match(open.error.message, /unterminated/);
  const many = timed(() => listObjects('<object id="1"></object>'.repeat(50_000)));
  quick("listObjects, 50000 objects", many);
  assert.match(many.error.message, /more than 5000 objects/);

  const tabs = `<config><object id="1">${"\t".repeat(80_000)}<metadata key="name" value="x"/></object></config>`;
  const set = timed(() => setObjectSettings(tabs, listObjects(tabs), { wall_loops: "4" }));
  quick("setObjectSettings, tabs", set);
  assert.match(set.value.xml, /<metadata key="wall_loops" value="4"\/>/);
  const metas = `<config><object id="1">${'<metadata key="a" '.repeat(40_000)}</object></config>`;
  quick("setObjectSettings, unclosed <metadata", timed(() => setObjectSettings(metas, listObjects(metas), { wall_loops: "4" })));
});

test("slice results leave the deliverable; thumbnails, order and compression stay", async t => {
  const p = await project(t);
  const r = await write(p, { changes: [{ key: "z_hop", value: "0.8", scope: "printer" }] });
  assert.deepEqual([...r.dropped_entries].sort(), [
    "Metadata/_rels/model_settings.config.rels", "Metadata/plate_1.gcode", "Metadata/plate_1.gcode.md5", "Metadata/plate_1.json",
  ]);
  const written = await fs.readFile(r.path);
  const names = listSafe3mfEntries(written);
  const original = listSafe3mfEntries(p.bytes).filter(e => !r.dropped_entries.includes(e.name));
  assert.deepEqual(names, original, "same names, same order, same stored/deflated choice");
  assert.equal(names.find(e => e.name === "Metadata/plate_1.png").stored, true);
  const zip = await JSZip.loadAsync(written);
  assert.ok((await zip.file("Metadata/plate_1.png").async("nodebuffer")).equals(PNG), "thumbnail byte-identical");
  assert.ok((await zip.file("3D/Objects/object_1.model").async("string")).includes("cube"));
  const info = await zip.file("Metadata/slice_info.config").async("string");
  assert.ok(info.includes("X-BBL-Client-Version") && !info.includes("<plate>"));
  assert.ok((await zip.file("Metadata/model_settings.config").async("string")).includes('<metadata key="gcode_file" value=""/>'));
  assert.equal(await zip.file("Metadata/filament_sequence.json").async("string"), SEQUENCE_EMPTY, "the slicer's grouping of the last slice is reset to Studio's unsliced form");
  assert.deepEqual(r.rewritten_entries.sort(), ["Metadata/filament_sequence.json", "Metadata/model_settings.config", "Metadata/project_settings.config", "Metadata/slice_info.config"]);
  assert.equal(dropRelationships(RELS, new Set(["Metadata/other.gcode"])), RELS);
  assert.equal(dropRelationships(RELS, new Set(["Metadata/plate_1.gcode"])), undefined);
});

test("an unsliced project is copied with every entry but the settings untouched, and nothing is rewritten without a change", async t => {
  const p = await project(t, { sliced: false });
  const r = await write(p, {});
  assert.deepEqual([r.dropped_entries, r.rewritten_entries, r.changed_keys], [[], [], []]);
  const [a, b] = [await JSZip.loadAsync(p.bytes), await open(r.path)];
  for (const name of Object.keys(a.files)) assert.ok((await a.file(name).async("nodebuffer")).equals(await b.file(name).async("nodebuffer")), name);
});

test("filament_sequence.json: every plate goes back to the empty form; an unreadable file is copied as it is, with a warning", async t => {
  assert.equal(blankFilamentSequence(`\uFEFF${SEQUENCE_SLICED}`), SEQUENCE_EMPTY);
  assert.equal(blankFilamentSequence(SEQUENCE_EMPTY), undefined, "already the unsliced form");
  assert.equal(blankFilamentSequence("{}"), undefined);
  assert.throws(() => blankFilamentSequence("[1]"), /not a JSON object/);
  assert.throws(() => blankFilamentSequence("{nope"));
  const p = await project(t, { sequence: "{nope" });
  const r = await write(p, {});
  assert.match(r.warnings.join("\n"), /filament_sequence\.json could not be read; copied as it is/);
  assert.equal(await (await open(r.path)).file("Metadata/filament_sequence.json").async("string"), "{nope");
  assert.ok(!r.rewritten_entries.includes("Metadata/filament_sequence.json"));
});

test("the output never overwrites a file, never the source, and the source is hashed before and after", async t => {
  const p = await project(t);
  const wanted = path.join(p.dir, "tuned.3mf");
  await fs.writeFile(wanted, "precious");
  const first = await writeTunedProject({ source: p.file, output: wanted, target: { printerPreset: X2D } });
  const second = await writeTunedProject({ source: p.file, output: wanted, target: { printerPreset: X2D } });
  assert.deepEqual([path.basename(first.path), path.basename(second.path)], ["tuned-2.3mf", "tuned-3.3mf"]);
  assert.equal(await fs.readFile(wanted, "utf8"), "precious");
  const onto = await writeTunedProject({ source: p.file, output: p.file, target: { printerPreset: X2D } });
  assert.equal(path.basename(onto.path), "part-2.3mf");
  assert.ok((await fs.readFile(p.file)).equals(p.bytes), "the source is byte-identical");
  assert.deepEqual(onto.sha256_of_source_before_and_after, { before: sha(p.bytes), after: sha(p.bytes) });
  const gcode = await writeTunedProject({ source: p.file, output: path.join(p.dir, "job.gcode.3mf"), target: { printerPreset: X2D } });
  const again = await writeTunedProject({ source: p.file, output: path.join(p.dir, "job.gcode.3mf"), target: { printerPreset: X2D } });
  assert.deepEqual([path.basename(gcode.path), path.basename(again.path)], ["job.gcode.3mf", "job-2.gcode.3mf"]);
  assert.deepEqual((await fs.readdir(p.dir)).filter(n => n.endsWith(".tmp")), [], "no temp file is left");
});

test("an archive with a path-traversal entry, or a corrupt one, is refused before anything is written", async t => {
  const dir = await workdir(t);
  const bytes = await zipBytes([...projectEntries({ sliced: false }), ["aaaaaaa.", "evil"]]);
  const hacked = Buffer.from(bytes);
  let offset = 0;
  while ((offset = hacked.indexOf("aaaaaaa.", offset)) !== -1) { hacked.write("../evil.", offset); offset += 8; }
  const file = path.join(dir, "evil.3mf");
  await fs.writeFile(file, hacked);
  await assert.rejects(writeTunedProject({ source: file, output: path.join(dir, "o.3mf"), target: { printerPreset: X2D } }), /ambiguous archive entry path/);
  const broken = path.join(dir, "broken.3mf");
  await fs.writeFile(broken, bytes.subarray(0, bytes.length - 10));
  await assert.rejects(writeTunedProject({ source: broken, output: path.join(dir, "o.3mf"), target: { printerPreset: X2D } }), /Print archive safety/);
  assert.deepEqual((await fs.readdir(dir)).sort(), ["broken.3mf", "evil.3mf"]);
});

const h2dConfig = () => baseConfig({
  printer_settings_id: "Bambu Lab H2D 0.4 nozzle", print_settings_id: "0.20mm Standard @BBL H2D", printable_area: ["0x0", "350x0", "350x320", "0x320"],
  nozzle_type: ["hardened_steel"], different_settings_to_system: ["sparse_infill_pattern", "", "", ""], sparse_infill_pattern: "gyroid",
});
const donorConfig = () => baseConfig({
  print_settings_id: "0.20mm Standard @BBL X2D (project settings)", printable_area: ["0x0", "256x0", "256x256", "0x256"],
  sparse_infill_pattern: "gyroid", different_settings_to_system: ["enable_prime_tower", "", "", ""], inherits_group: ["a"],
});

test("a project for another printer: P0 comes from the retargeter, the original's other entries stay, and the two diffs are separate", async t => {
  const p = await project(t, { config: studioJson(h2dConfig()) });
  const donor = await zipBytes([["Metadata/project_settings.config", studioJson(donorConfig())], ["3D/Objects/object_1.model", "<model>OTHER</model>"]]);
  const calls = [];
  const retarget = async source => {
    calls.push(source);
    return { archive: donor, report: { mode: "keep", kept: ["sparse_infill_pattern: gyroid -> grid"], not_kept: ["nozzle_type gone"], filament_map: [] }, process: "0.20mm Standard @BBL X2D", edited: ["sparse_infill_pattern", "not_in_the_config"] };
  };
  const r = await write(p, { retarget, changes: [{ key: "z_hop", value: "0.8", scope: "printer" }] });
  assert.deepEqual(calls, [p.file]);
  const c = await configOf(r.path);
  assert.equal(c.printer_settings_id, X2D);
  assert.equal(c.print_settings_id, "0.20mm Standard @BBL X2D", "the system preset, not the export's '(project settings)' name");
  assert.deepEqual(c.different_settings_to_system, ["enable_prime_tower;sparse_infill_pattern", "", "", "z_hop"]);
  assert.ok(!("nozzle_type" in c));
  assert.equal(await (await open(r.path)).file("3D/Objects/object_1.model").async("string"), "<model>cube</model>", "geometry is the original's");
  assert.deepEqual([r.retarget.applied, r.retarget.reason, r.retarget.kept, r.retarget.not_kept], [true, "printer-differs", ["sparse_infill_pattern: gyroid -> grid"], ["nozzle_type gone"]]);
  assert.deepEqual(r.retarget.printer_ids.before.printer, "Bambu Lab H2D 0.4 nozzle");
  assert.deepEqual(r.retarget.printer_ids.after.printer, X2D);
  const retargetKeys = r.retarget.changed_keys.map(d => d.key);
  assert.ok(["printer_settings_id", "nozzle_type", "printable_area", "inherits_group"].every(k => retargetKeys.includes(k)));
  assert.ok(!retargetKeys.includes("z_hop"), "tuning is not part of the retarget diff");
  assert.deepEqual(r.changed_keys.map(x => x.key), ["z_hop"]);
  const combined = r.combined_diff.map(d => d.key);
  assert.ok(["printer_settings_id", "z_hop"].every(k => combined.includes(k)), "the combined diff has both");
  assert.match(r.warnings.join("\n"), /350x320 mm\) is larger than .* \(256x256 mm\)/);
});

test("an STL or a 3MF without settings is a baseline: the export is the project, its slice results are stripped, the STL is untouched", async t => {
  const dir = await workdir(t);
  const stl = path.join(dir, "cube.stl");
  await fs.writeFile(stl, "solid cube\nendsolid cube\n");
  const exported = await zipBytes(projectEntries());
  const r = await writeTunedProject({
    source: stl, output: path.join(dir, "cube.3mf"), target: { printerPreset: X2D },
    retarget: async () => ({ archive: exported, report: null }),
    changes: [{ key: "sparse_infill_pattern", value: "gyroid", scope: "process" }],
  });
  assert.deepEqual([r.retarget.reason, r.retarget.printer_ids.before, r.retarget.printer_ids.after.printer], ["baseline", null, X2D]);
  assert.ok(r.dropped_entries.includes("Metadata/plate_1.gcode"));
  assert.deepEqual(r.combined_diff.map(d => d.key).sort(), ["different_settings_to_system", "sparse_infill_pattern"]);
  assert.match(r.warnings[0], /carries no project settings/);
  assert.equal(await fs.readFile(stl, "utf8"), "solid cube\nendsolid cube\n");

  const geometryOnly = path.join(dir, "geometry.3mf");
  await fs.writeFile(geometryOnly, await zipBytes([["3D/3dmodel.model", "<model/>"]]));
  const g = await writeTunedProject({ source: geometryOnly, output: path.join(dir, "geometry-out.3mf"), target: { printerPreset: X2D }, retarget: async () => ({ archive: exported, report: null }) });
  assert.equal(g.retarget.reason, "baseline");
});

test("a project that needs a retargeter and has none is refused with the reason", async t => {
  const p = await project(t, { config: studioJson(h2dConfig()) });
  await assert.rejects(write(p, {}), /needs a retargeter: it was made for Bambu Lab H2D 0\.4 nozzle, not Bambu Lab X2D 0\.4 nozzle/);
  const dir = await workdir(t);
  await fs.writeFile(path.join(dir, "a.stl"), "solid x\nendsolid x\n");
  await assert.rejects(writeTunedProject({ source: path.join(dir, "a.stl"), output: path.join(dir, "o.3mf"), target: { printerPreset: X2D } }), /carries no project settings/);
});

test("CONFIG_BLOCK: read the block, line the project's lists up with the extruders and filaments the G-code kept, compare as numbers", () => {
  const gcode = [
    "; HEADER_BLOCK_START", "; CONFIG_BLOCK_START",
    "; print_extruder_id = 1,2", '; print_extruder_variant = "Direct Drive Standard";"Bowden Standard"',
    "; printer_extruder_id = 1,2", '; printer_extruder_variant = "Direct Drive Standard";"Bowden Standard"',
    '; filament_extruder_variant = "Direct Drive Standard";"Bowden Standard"',
    "; outer_wall_speed = 200,150", "; z_hop = 0.80,0.8", "; z_hop_types = Slope Lift,Slope Lift", "; nozzle_temperature = 220,215", "; sparse_infill_pattern = gyroid",
    "; CONFIG_BLOCK_END", "G1 X0",
  ].join("\n");
  const block = readConfigBlock(gcode);
  assert.equal(block.sparse_infill_pattern, "gyroid");
  assert.equal(readConfigBlock("G1 X0\n"), undefined);
  const config = baseConfig({
    outer_wall_speed: ["200", "500", "150"], z_hop: ["0.8", "0.8", "0.8"], z_hop_types: ["Slope Lift", "Slope Lift", "Slope Lift"],
    nozzle_temperature: ["220", "221", "222", "213", "214", "215"], sparse_infill_pattern: "gyroid",
  });
  assert.deepEqual(expectedBlockElements(config, block, "outer_wall_speed", "process"), ["200", "150"]);
  assert.deepEqual(expectedBlockElements(config, block, "nozzle_temperature", "filament"), ["220", "215"]);
  assert.equal(checkBlockValue(config, block, "z_hop", "printer").ok, true, "0.80 and 0.8 are the same number");
  assert.equal(checkBlockValue(config, block, "z_hop_types", "printer").ok, true);
  assert.equal(checkBlockValue(config, block, "sparse_infill_pattern", "process").ok, true);
  assert.equal(checkBlockValue({ ...config, z_hop: ["0.9", "0.9", "0.9"] }, block, "z_hop", "printer").ok, false);
  assert.equal(checkBlockValue(config, block, "brim_type", "process").ok, null, "a key the block lacks is unverified, not ok");
  assert.equal(checkBlockValue({ ...config, outer_wall_speed: ["1", "2", "3", "4"] }, block, "outer_wall_speed", "process").ok, null, "a list that does not line up is unverified");
});
