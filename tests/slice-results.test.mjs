import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { extractBambuTemplateSettings, readSliceResults } from "../dist/3mf_parser.js";

const sliceInfo = new URL("./fixtures/h2d_gui_sliced/slice_info.config", import.meta.url);

async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slice-results-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write3mf(dir, name, files) {
  const zip = new JSZip();
  for (const [file, content] of Object.entries(files)) zip.file(file, content);
  const out = path.join(dir, name);
  await fs.writeFile(out, await zip.generateAsync({ type: "nodebuffer" }));
  return out;
}

test("readSliceResults reads time, weight, filaments and warnings from a Bambu Studio 3MF", async t => {
  const dir = await scratch(t);
  const file = await write3mf(dir, "sliced.3mf", { "Metadata/slice_info.config": await fs.readFile(sliceInfo, "utf8") });
  const [plate, ...rest] = await readSliceResults(file);
  assert.equal(rest.length, 0);
  assert.deepEqual(plate, {
    index: 1,
    prediction_s: 5967,
    weight_g: 50.57,
    filaments: [{ type: "PETG", color: "#FFFFFF", used_g: 50.57, used_m: 16.42 }],
    warnings: [{ msg: "bed_temperature_too_high_than_filament", level: 3, error_code: "1000C001" }],
  });
});

test("readSliceResults lists every plate and refuses a 3MF without slice_info.config", async t => {
  const dir = await scratch(t);
  const plate = i => `<plate><metadata key="index" value="${i}"/><metadata key="prediction" value="${i}00"/><metadata key="weight" value="${i}.5"/></plate>`;
  const two = await write3mf(dir, "two.3mf", { "Metadata/slice_info.config": `<config>${plate(1)}${plate(2)}</config>` });
  const plates = await readSliceResults(two);
  assert.deepEqual(plates.map(p => [p.index, p.prediction_s, p.weight_g, p.filaments, p.warnings]), [[1, 100, 1.5, [], []], [2, 200, 2.5, [], []]]);
  await assert.rejects(readSliceResults(await write3mf(dir, "none.3mf", { "3D/3dmodel.model": "<model/>" })), /no Metadata\/slice_info\.config/);
});

test("extracted template settings get a name from their content, so templates never overwrite each other", async t => {
  const dir = await scratch(t);
  const a = await write3mf(dir, "a.3mf", { "Metadata/project_settings.config": '{"layer_height":"0.2"}' });
  const b = await write3mf(dir, "b.3mf", { "Metadata/project_settings.config": '{"layer_height":"0.1"}' });
  const out = path.join(dir, "out");
  await fs.mkdir(out);
  const [pathA, pathB, pathAAgain] = [await extractBambuTemplateSettings(a, out), await extractBambuTemplateSettings(b, out), await extractBambuTemplateSettings(a, out)];
  assert.notEqual(pathA, pathB);
  assert.equal(pathA, pathAAgain);
  assert.match(path.basename(pathA), /^Metadata_project_settings_[0-9a-f]{16}\.config$/);
  assert.equal(path.dirname(pathA), out);
  assert.equal(JSON.parse(await fs.readFile(pathA, "utf8")).layer_height, "0.2");
  assert.equal(JSON.parse(await fs.readFile(pathB, "utf8")).layer_height, "0.1");
});
