import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { STLManipulator } from "../dist/stl/stl-manipulator.js";

async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stl-tools-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const writeMesh = async (file, geometry) => {
  const text = new STLExporter().parse(new THREE.Mesh(geometry));
  await fs.writeFile(file, text);
  return text;
};

const uniquePositions = (stl) => {
  const positions = new STLLoader().parse(stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength)).getAttribute("position");
  const seen = new Set();
  for (let i = 0; i < positions.count; i++) {
    seen.add([positions.getX(i), positions.getY(i), positions.getZ(i)].map((v) => v.toFixed(5)).join(","));
  }
  return seen.size;
};

test("extend_stl_base adds millimeters along Z and keeps the original bottom", async (t) => {
  const directory = await workspace(t);
  const input = path.join(directory, "cube.stl");
  const original = await writeMesh(input, new THREE.BoxGeometry(20, 20, 20).translate(4, -3, 10));
  const manipulator = new STLManipulator(directory);

  const output = await manipulator.extendBase(input, 5);
  const info = await manipulator.getSTLInfo(output);
  assert.deepEqual(info.boundingBox.dimensions.toArray(), [20, 20, 25]);
  assert.equal(info.boundingBox.min.z, 0, "the bottom plane must not move");
  assert.equal(info.faceCount, 24, "model plus a 12-triangle slab");
  assert.equal((await fs.readFile(output, "utf8")).match(/^solid /gm).length, 1, "the result is one solid");
  assert.equal(await fs.readFile(input, "utf8"), original, "input must remain unchanged");

  for (const bad of [0, -1, Number.NaN]) {
    await assert.rejects(manipulator.extendBase(input, bad), /positive number of millimeters/);
  }
});

test("merge_vertices welds a cube's duplicate vertices from 36 to 8", async (t) => {
  const directory = await workspace(t);
  const input = path.join(directory, "cube.stl");
  await writeMesh(input, new THREE.BoxGeometry(10, 10, 10).toNonIndexed());
  const manipulator = new STLManipulator(directory);
  const completed = [];
  manipulator.on("operationComplete", (event) => completed.push(event));

  await manipulator.mergeVertices(input);
  assert.equal(completed.at(-1).type, "mergeVertices");
  assert.equal(completed.at(-1).verticesRemoved, 28, "36 vertices become 8");
});

test("merge_vertices snaps near-duplicate vertices so the output differs from the input", async (t) => {
  const directory = await workspace(t);
  const input = path.join(directory, "cracked.stl");
  // Every triangle corner is off by a different sub-tolerance amount, as in a mesh with hairline cracks.
  const geometry = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) {
    position.setXYZ(i, position.getX(i) + ((i * 7) % 5 - 2) * 0.001, position.getY(i) + ((i * 3) % 5 - 2) * 0.001, position.getZ(i) + ((i * 11) % 5 - 2) * 0.001);
  }
  const original = await writeMesh(input, geometry);
  const manipulator = new STLManipulator(directory);

  const output = await manipulator.mergeVertices(input, 0.01);
  const merged = await fs.readFile(output);
  assert.ok(uniquePositions(Buffer.from(original)) > 8, "the input has cracked corners");
  assert.equal(uniquePositions(merged), 8);
  assert.notEqual(merged.toString("utf8"), original);
  assert.equal((await manipulator.getSTLInfo(output)).faceCount, 12);
});

// Bambu Studio layout: the build item points at a component object in 3D/Objects, and both carry transforms.
async function write3mf(file, { itemTransform, componentTransform }) {
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", `<?xml version="1.0"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
 <resources>
  <object id="2" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="${componentTransform}"/></components></object>
 </resources>
 <build><item objectid="2" transform="${itemTransform}" printable="1"/></build>
</model>`);
  const corners = [[0, 0, 0], [10, 0, 0], [10, 20, 0], [0, 20, 0], [0, 0, 30], [10, 0, 30], [10, 20, 30], [0, 20, 30]];
  const triangles = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  zip.file("3D/Objects/object_1.model", `<?xml version="1.0"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
 <object id="1" type="model"><mesh><vertices>
${corners.map(([x, y, z]) => `  <vertex x="${x}" y="${y}" z="${z}"/>`).join("\n")}
 </vertices><triangles>
${triangles.map(([v1, v2, v3]) => `  <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`).join("\n")}
 </triangles></mesh></object>
</resources></model>`);
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
}

test("get_stl_info applies 3MF build item and component transforms", async (t) => {
  const directory = await workspace(t);
  const input = path.join(directory, "rotated.3mf");
  // The component lifts the 10x20x30 box by 50 in Z; the item then turns it onto its side
  // (x' = x + 100, y' = 200 - z, z' = y + 5), so the order of the two transforms matters.
  await write3mf(input, {
    componentTransform: "1 0 0 0 1 0 0 0 1 0 0 50",
    itemTransform: "1 0 0 0 0 1 0 -1 0 100 200 5",
  });

  const info = await new STLManipulator(directory).getSTLInfo(input);
  assert.deepEqual(info.boundingBox.min.toArray().map((v) => Math.round(v * 1e6) / 1e6), [100, 120, 5]);
  assert.deepEqual(info.boundingBox.max.toArray().map((v) => Math.round(v * 1e6) / 1e6), [110, 150, 25]);
  assert.deepEqual(info.boundingBox.dimensions.toArray().map((v) => Math.round(v * 1e6) / 1e6), [10, 30, 20]);
  assert.equal(info.vertexCount, 8);
  assert.equal(info.faceCount, 12);
  assert.equal(info.objects.length, 1);
  assert.equal(info.objects[0].name, "object_1.model");
  assert.equal(info.objects[0].boundingBox.dimensions.z, 20);
});

test("get_stl_info keeps a 3MF without transforms unchanged and rejects a malformed one", async (t) => {
  const directory = await workspace(t);
  const plain = path.join(directory, "plain.3mf");
  await write3mf(plain, { componentTransform: "1 0 0 0 1 0 0 0 1 0 0 0", itemTransform: "1 0 0 0 1 0 0 0 1 0 0 0" });
  const manipulator = new STLManipulator(directory);
  assert.deepEqual((await manipulator.getSTLInfo(plain)).boundingBox.dimensions.toArray(), [10, 20, 30]);

  const broken = path.join(directory, "broken.3mf");
  await write3mf(broken, { componentTransform: "1 0 0", itemTransform: "1 0 0 0 1 0 0 0 1 0 0 0" });
  await assert.rejects(manipulator.getSTLInfo(broken), /Invalid 3MF transform/);
});

// Seven layered objects with N components each, all pointing at the next layer: a tiny file that expands to N^6 instances.
async function writeComponentBomb(file, fanOut) {
  const zip = new JSZip();
  const layer = (id, next) => `<object id="${id}"><components>${`<component objectid="${next}"/>`.repeat(fanOut)}</components></object>`;
  zip.file("3D/3dmodel.model", `<?xml version="1.0"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
 ${[1, 2, 3, 4, 5, 6].map((id) => layer(id, id + 1)).join("\n ")}
 <object id="7"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
</resources><build><item objectid="1"/></build></model>`);
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
}

test("get_stl_info rejects a 3MF whose components fan out into too many instances, and a self-referencing one", async (t) => {
  const directory = await workspace(t);
  const manipulator = new STLManipulator(directory);
  const bomb = path.join(directory, "bomb.3mf");
  await writeComponentBomb(bomb, 10);
  const started = performance.now();
  await assert.rejects(manipulator.getSTLInfo(bomb), /too many/);
  assert.ok(performance.now() - started < 1000, "the cap must stop the walk quickly");

  const loop = path.join(directory, "loop.3mf");
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", `<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
 <object id="1"><components><component objectid="1"/></components></object>
</resources><build><item objectid="1"/></build></model>`);
  await fs.writeFile(loop, await zip.generateAsync({ type: "nodebuffer" }));
  await assert.rejects(manipulator.getSTLInfo(loop), /nested too deeply/);
});
