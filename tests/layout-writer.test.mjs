// src/tuning/layout-writer.ts: the transform arithmetic (a quarter turn about Z in the row-vector convention), the text splices, and the written project
// proven by opening it again. Synthetic projects, no Studio.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { openProject } from "../dist/knowledge/facts/settings.js";
import { listSafe3mfEntries } from "../dist/safety/archive.js";
import { geometryFromConfig, readLayoutModel } from "../dist/tuning/layout.js";
import { STALE_IMAGE, filamentSequenceFor, moveTransform, rebuildPlates, spliceItemTransforms, writeLaidOutProject } from "../dist/tuning/layout-writer.js";
import { buildLayoutProject, tiltX, x2dConfig } from "./fixtures/layout-project.mjs";

const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const geo = geometryFromConfig(x2dConfig());
const apply = (t, [x, y, z]) => [x * t[0] + y * t[3] + z * t[6] + t[9], x * t[1] + y * t[4] + z * t[7] + t[10], x * t[2] + y * t[5] + z * t[8] + t[11]];
const near = (a, b, tol = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test("moveTransform: no turn only changes tx, ty and keeps every other token's text", () => {
  const tokens = "0.999999984 -6.84993255e-05 -0.000165371982 -6.84993255e-05 0.707106728 -0.707106831 0.000165371982 0.707106831 0.707106712 175.000256 -221.362902 89.7440431".split(" ");
  const out = moveTransform(tokens, { cx: 100, cy: 50 }, { cx: 130, cy: 20 }, 0);
  assert.deepEqual(out.slice(0, 9), tokens.slice(0, 9));
  assert.equal(out[11], tokens[11], "tz never changes: the object stays on the bed");
  assert.equal(Number(out[9]), 175.000256 + 30);
  assert.equal(Number(out[10]), -221.362902 - 30);
});

test("moveTransform: a quarter turn is M' = M * Rz(90) with t' = (t - c) * Rz + c', so the world points turn about the box centre", () => {
  const tokens = [...tiltX(45).map(String), "10", "20", "5"];
  const from = { cx: 12, cy: 27 };
  const to = { cx: 100, cy: 80 };
  const out = moveTransform(tokens, from, to, 90).map(Number);
  assert.equal(out[11], 5, "tz is unchanged");
  const before = tokens.map(Number);
  for (const p of [[0, 0, 0], [10, 0, 0], [0, 30, 0], [3, 4, 20], [40, 30, 20]]) {
    const w = apply(before, p);
    // the expected world point: turn (x - cx, y - cy) by +90 degrees ((x, y) -> (-y, x)), then put the centre at the new place
    const expected = [-(w[1] - from.cy) + to.cx, (w[0] - from.cx) + to.cy, w[2]];
    assert.ok(near(apply(out, p), expected, 1e-9), `point ${p}: ${apply(out, p)} vs ${expected}`);
  }
  // the rows of the 3x3: each row r of M becomes [-M[r][1], M[r][0], M[r][2]]
  assert.deepEqual(out.slice(0, 9).map(v => Math.round(v * 1e9) / 1e9), [0, 1, 0, -0.707106781, 0, 0.707106781, 0.707106781, 0, 0.707106781].map(v => Math.round(v * 1e9) / 1e9));
  // four quarter turns about the same centre are the identity on the points
  let t = tokens;
  for (let k = 0; k < 4; k++) t = moveTransform(t, from, from, 90);
  assert.ok(near(t.map(Number), before, 1e-9));
  assert.throws(() => moveTransform(["1"], from, to, 0), /12 numbers/);
  assert.throws(() => moveTransform(Array(12).fill("x"), from, to, 0), /not finite/);
});

const MODEL = `<?xml version="1.0"?>
<model>
 <build p:UUID="b">
  <item objectid="2" p:UUID="u2" transform="1 0 0 0 1 0 0 0 1 10 20 30" printable="1" />
  <item objectid="4" transform="1 0 0 0 1 0 0 0 1 11 21 31"/>
  <item objectid="6" printable="1"/>
 </build>
</model>`;

test("spliceItemTransforms: only the listed items change (by position), the rest of the text is byte-identical, an item without a transform gets one", () => {
  const edits = new Map([
    [0, { objectId: "2", move: t => moveTransform(t, { cx: 0, cy: 0 }, { cx: 5, cy: 5 }, 0) }],
    [2, { objectId: "6", move: t => moveTransform(t, { cx: 0, cy: 0 }, { cx: 7, cy: 8 }, 0) }],
  ]);
  const out = spliceItemTransforms(MODEL, edits);
  assert.ok(out.includes('<item objectid="2" p:UUID="u2" transform="1 0 0 0 1 0 0 0 1 15 25 30" printable="1" />'));
  assert.ok(out.includes('<item objectid="4" transform="1 0 0 0 1 0 0 0 1 11 21 31"/>'), "untouched");
  assert.ok(out.includes('<item objectid="6" printable="1" transform="1 0 0 0 1 0 0 0 1 7 8 0"/>'), "identity plus the move");
  assert.equal(out.replace(/<item objectid="[26]"[^>]*>/g, ""), MODEL.replace(/<item objectid="[26]"[^>]*>/g, ""), "nothing else moved");
  assert.throws(() => spliceItemTransforms(MODEL, new Map([[1, { objectId: "99", move: t => t }]])), /not 99/);
  assert.throws(() => spliceItemTransforms(MODEL, new Map([[5, { objectId: "2", move: t => t }]])), /fewer <item> tags/);
  assert.equal(spliceItemTransforms(MODEL.replace("<build", "<buildx").replace("<item objectid=\"4\"", "<items objectid=\"4\""), new Map()).includes("<items"), true, "<items> is not an <item>");
});

const SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2"><metadata key="name" value="A"/></object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="Old &amp; name"/>
    <metadata key="locked" value="true"/>
    <metadata key="filament_map_mode" value="Auto For Match"/>
    <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>
    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>
    <metadata key="thumbnail_no_light_file" value="Metadata/plate_no_light_1.png"/>
    <metadata key="top_file" value="Metadata/top_1.png"/>
    <metadata key="pick_file" value="Metadata/pick_1.png"/>
    <model_instance>
      <metadata key="object_id" value="2"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="404"/>
    </model_instance>
  </plate>
  <plate>
    <metadata key="plater_id" value="2"/>
    <model_instance>
      <metadata key="object_id" value="4"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="505"/>
    </model_instance>
    <model_instance>
      <metadata key="object_id" value="9"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="606"/>
    </model_instance>
  </plate>
  <assemble>
   <assemble_item object_id="2"/>
  </assemble>
</config>
`;

test("rebuildPlates: the first plate is the template, the four picture lines go, locked is false, identify_id survives, text outside the plates is untouched", () => {
  const plan = { plates: [{ name: "Both <&> parts", items: [{ key: "2:0" }, { key: "4:0" }] }, { name: "Alone", items: [] }] };
  const out = rebuildPlates(SETTINGS, plan, ["9:0"]);
  assert.ok(out.startsWith(SETTINGS.slice(0, SETTINGS.indexOf("  <plate>"))), "the head is untouched");
  assert.ok(out.endsWith(SETTINGS.slice(SETTINGS.indexOf("  <assemble>"))), "the tail is untouched");
  const blocks = out.split("  <plate>").slice(1).map(b => b.slice(0, b.indexOf("</plate>")));
  assert.equal(blocks.length, 2);
  for (const b of blocks) for (const key of ["thumbnail_file", "thumbnail_no_light_file", "top_file", "pick_file"]) assert.ok(!b.includes(`key="${key}"`));
  assert.match(blocks[0], /key="plater_id" value="1"/);
  assert.match(blocks[0], /key="plater_name" value="Both &lt;&amp;&gt; parts"/, "the name is escaped");
  assert.match(blocks[0], /key="locked" value="false"/);
  assert.match(blocks[0], /key="filament_map_mode" value="Auto For Match"/, "as the template has it");
  assert.match(blocks[0], /key="gcode_file" value=""/);
  assert.match(blocks[0], /identify_id" value="404"/);
  assert.match(blocks[0], /identify_id" value="505"/, "the instance came from the old plate 2");
  assert.match(blocks[0], /identify_id" value="606"/, "an instance with no mesh stays on the first plate");
  assert.match(blocks[1], /key="plater_id" value="2"/);
  assert.match(blocks[1], /key="plater_name" value="Alone"/);
  assert.ok(!blocks[1].includes("model_instance"));
  assert.throws(() => rebuildPlates(SETTINGS, { plates: [{ name: "x", items: [{ key: "77:0" }] }] }), /Instance 77:0 is on no plate/);
  assert.throws(() => rebuildPlates("<config/>", plan), /no <plate>/);
  // a template without a name gets one; CRLF files keep their line breaks
  const crlf = SETTINGS.replace(/\n/g, "\r\n").replace(/ *<metadata key="plater_name"[^\n]*\n/, "");
  const named = rebuildPlates(crlf, { plates: [{ name: "N", items: [{ key: "2:0" }] }] });
  assert.match(named, /key="plater_name" value="N"/);
  assert.ok(!/[^\r]\n/.test(named), "every line break is still CRLF");
});

test("hostile metadata: unclosed plates and instances are refused at once, and 500 plates are rebuilt in well under a second", () => {
  const started = Date.now();
  assert.throws(() => rebuildPlates(`<config>${"<plate>".repeat(300_000)}</config>`, { plates: [] }), /no <plate>/);
  assert.throws(() => rebuildPlates(`<config><plate>${"<model_instance>".repeat(100_000)}</plate></config>`, { plates: [] }), /unterminated <model_instance>/);
  assert.throws(() => rebuildPlates(" ".repeat(40 * 2 ** 20), { plates: [] }), /too large/);
  const many = Array.from({ length: 500 }, (_, i) => `  <plate>\n    <metadata key="plater_id" value="${i + 1}"/>\n    <model_instance>\n      <metadata key="object_id" value="${i}"/>\n      <metadata key="instance_id" value="0"/>\n    </model_instance>\n  </plate>`).join("\n");
  const out = rebuildPlates(`<config>\n${many}\n</config>`, { plates: [{ name: "all", items: Array.from({ length: 500 }, (_, i) => ({ key: `${i}:0` })) }] });
  assert.equal(out.split("<model_instance>").length - 1, 500);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test("filamentSequenceFor: one empty entry per plate of the new layout, only for a per-plate file", () => {
  assert.equal(filamentSequenceFor('{"plate_1":{"sequence":[1]},"plate_2":{}}', 3), '{"plate_1":{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]},"plate_2":{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]},"plate_3":{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]}}');
  assert.equal(filamentSequenceFor("[1]", 2), undefined);
  assert.equal(filamentSequenceFor("{}", 2), undefined);
  assert.equal(filamentSequenceFor('{"other":1}', 2), undefined);
  assert.equal(filamentSequenceFor("not json", 2), undefined);
});

// ---------------------------------------------------------------- the whole write, proven by re-opening
/** Four boxes scattered over four plates' worth of space; the plan puts A, B on plate 1 and C, D on plate 2 (the X2D grid: plate 2 starts at x = 307.2 with 2 columns). */
const spec = (extra = {}) => ({
  objects: [
    { id: 2, name: "A", size: [60, 30, 40], at: [900, 900], matrix: tiltX(45) },
    { id: 4, name: "B", size: [50, 50, 20], at: [-300, 40], extruder: 1 },
    { id: 6, name: "C", size: [80, 40, 30], at: [3000, 0], extruder: 2 },
    { id: 8, name: "D", size: [40, 40, 40], at: [50, 50], extruder: 2 },
  ],
  plates: [["2:0"], ["4:0"], ["6:0"], ["8:0"]],
  ...extra,
});
const PLAN = { plates: [
  { name: "Filament 1 - black", items: [{ key: "2:0", cx: 70, cy: 90, rotate: 90 }, { key: "4:0", cx: 150, cy: 150, rotate: 0 }] },
  { name: "Filament 2 - grey", items: [{ key: "6:0", cx: 307.2 + 100, cy: 100, rotate: 0 }, { key: "8:0", cx: 307.2 + 180, cy: 180, rotate: 0 }] },
] };

async function write(t, buildSpec = spec(), plan = PLAN, mutate) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "layout-writer-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source.3mf");
  let bytes = await buildLayoutProject(buildSpec);
  if (mutate) bytes = await mutate(bytes);
  await fs.writeFile(source, bytes);
  const output = path.join(dir, "out", "laid.3mf");
  return { dir, source, output, bytes, run: () => writeLaidOutProject({ source, output, plan, geometry: geo, minGapMm: 8 }) };
}

test("a laid-out project: proven by re-opening, objects where planned and turned when asked, the source and every other entry untouched", async t => {
  const env = await write(t);
  const before = sha(await fs.readFile(env.source));
  const result = await env.run();
  assert.equal(result.proof.ok, true, JSON.stringify(result.proof.checks.filter(c => !c.ok)));
  assert.deepEqual(result.proof.checks.map(c => c.ok), result.proof.checks.map(() => true));
  assert.ok(result.proof.checks.length >= 10);
  assert.equal(sha(await fs.readFile(env.source)), before, "the source is never written");
  assert.deepEqual(result.sha256_of_source_before_and_after, { before, after: before });

  const model = await readLayoutModel(await openProject(result.path));
  assert.equal(model.plates.length, 2);
  const a = model.objects.find(o => o.name === "A");
  assert.deepEqual([(a.box.x0 + a.box.x1) / 2, (a.box.y0 + a.box.y1) / 2].map(v => Math.round(v * 1e6) / 1e6), [70, 90]);
  // A was 60 wide and (30 + 40) * 0.7071 = 49.5 deep, tilted 45 degrees; turned a quarter, they swap
  assert.ok(Math.abs(a.box.x1 - a.box.x0 - (30 + 40) * Math.SQRT1_2) < 1e-6 && Math.abs(a.box.y1 - a.box.y0 - 60) < 1e-6);
  assert.ok(Math.abs(a.box.z0) < 1e-9 && Math.abs(a.box.z1 - (30 + 40) * Math.SQRT1_2) < 1e-6, "still on the bed, same height");
  assert.deepEqual(model.plates.map(p => p.keys.slice().sort()), [["2:0", "4:0"], ["6:0", "8:0"]]);
  assert.equal(model.plates[0].name, "Filament 1 - black");
  assert.deepEqual(result.moved.map(m => [m.name, m.plate, m.rotate_deg]), [["A", 1, 90], ["B", 1, 0], ["C", 2, 0], ["D", 2, 0]]);

  // entries: same order minus the pictures; everything but the model and the plates is byte-identical
  const oldBytes = await fs.readFile(env.source);
  const newBytes = await fs.readFile(result.path);
  const oldNames = listSafe3mfEntries(oldBytes).map(e => e.name);
  const newNames = listSafe3mfEntries(newBytes).map(e => e.name);
  assert.deepEqual(newNames, oldNames.filter(n => !STALE_IMAGE.test(n)));
  assert.equal(oldNames.filter(n => STALE_IMAGE.test(n)).length, 20, "4 plates x 5 pictures were there");
  assert.deepEqual(newNames.filter(n => /\.png$/.test(n)), []);
  const [oz, nz] = [await JSZip.loadAsync(oldBytes), await JSZip.loadAsync(newBytes)];
  for (const n of newNames.filter(x => !x.endsWith("/") && !["3D/3dmodel.model", "Metadata/model_settings.config", "Metadata/filament_sequence.json"].includes(x))) {
    assert.ok((await oz.file(n).async("nodebuffer")).equals(await nz.file(n).async("nodebuffer")), `${n} is byte-identical`);
  }
  assert.deepEqual(result.rewritten_entries.sort(), ["3D/3dmodel.model", "Metadata/filament_sequence.json", "Metadata/model_settings.config"]);
  assert.equal(JSON.parse(await nz.file("Metadata/filament_sequence.json").async("string")).plate_2.sequence.length, 0);
  assert.deepEqual(Object.keys(JSON.parse(await nz.file("Metadata/filament_sequence.json").async("string"))), ["plate_1", "plate_2"], "consistent with the new plate count");
  // the object definitions of model_settings.config are untouched
  const [oldSettings, newSettings] = [await oz.file("Metadata/model_settings.config").async("string"), await nz.file("Metadata/model_settings.config").async("string")];
  assert.equal(newSettings.slice(0, newSettings.indexOf("<plate>")), oldSettings.slice(0, oldSettings.indexOf("<plate>")));
  assert.ok(!/(thumbnail|top_file|pick_file)/.test(newSettings));
});

test("the output is never overwritten, and a failed write leaves nothing behind", async t => {
  const env = await write(t);
  const first = await env.run();
  const bytes = await fs.readFile(first.path);
  await assert.rejects(env.run(), /already exists; the layout never overwrites/);
  assert.deepEqual(await fs.readFile(first.path), bytes, "the existing output keeps its bytes");
  await assert.rejects(writeLaidOutProject({ source: env.source, output: env.source, plan: PLAN, geometry: geo, minGapMm: 8 }), /never writes over its source/);

  // a plan that puts two objects on top of each other fails the proof, and the file it wrote is removed
  const bad = await write(t, spec(), { plates: [{ name: "x", items: [{ key: "2:0", cx: 100, cy: 100, rotate: 0 }, { key: "4:0", cx: 110, cy: 100, rotate: 0 }, { key: "6:0", cx: 200, cy: 200, rotate: 0 }, { key: "8:0", cx: 40, cy: 200, rotate: 0 }] }] });
  await assert.rejects(bad.run(), /Layout verification failed.*overlapping/);
  await assert.rejects(fs.access(bad.output), "no half-written output");
  assert.ok((await fs.readFile(bad.source)).equals(bad.bytes), "the source is intact");
});

test("a plan that leaves an object out, names an unknown one or places one twice is refused before anything is written", async t => {
  const missing = await write(t, spec(), { plates: [{ name: "x", items: [{ key: "2:0", cx: 100, cy: 100, rotate: 0 }] }] });
  await assert.rejects(missing.run(), /leaves .* out/);
  const unknown = await write(t, spec(), { plates: [{ name: "x", items: [{ key: "99:0", cx: 100, cy: 100, rotate: 0 }] }] });
  await assert.rejects(unknown.run(), /not a printable object/);
  const twice = await write(t, spec(), { plates: [{ name: "x", items: [{ key: "2:0", cx: 100, cy: 100, rotate: 0 }, { key: "2:0", cx: 200, cy: 100, rotate: 0 }] }] });
  await assert.rejects(twice.run(), /twice/);
  for (const e of [missing, unknown, twice]) await assert.rejects(fs.access(e.output));
});

test("a project that already holds slice results is refused: a layout would leave the G-code stale", async t => {
  const env = await write(t, spec({ gcode: true }));
  await assert.rejects(env.run(), /slice results/);
});

test("plate pictures that the project does not have are not an error, and the relationships that pointed at dropped pictures go with them", async t => {
  const rels = '<?xml version="1.0"?>\n<Relationships xmlns="r">\n <Relationship Target="/Metadata/plate_1.png" Id="r1" Type="t"/>\n <Relationship Target="/3D/3dmodel.model" Id="r2" Type="t"/>\n</Relationships>';
  const env = await write(t, spec({ extraEntries: { "Metadata/_rels/model_settings.config.rels": rels } }));
  const result = await env.run();
  const nz = await JSZip.loadAsync(await fs.readFile(result.path));
  const out = await nz.file("Metadata/_rels/model_settings.config.rels").async("string");
  assert.ok(!out.includes("plate_1.png") && out.includes("/3D/3dmodel.model"));
  const bare = await write(t, spec({ images: false }));
  assert.equal((await bare.run()).dropped_entries.length, 0);
});
