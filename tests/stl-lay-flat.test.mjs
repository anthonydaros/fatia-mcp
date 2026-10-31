import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { STLManipulator } from "../dist/stl/stl-manipulator.js";

// A 30 x 20 x 2 plate must rest on a 600 mm² face, regardless of its
// starting orientation. Excluding Z-aligned normals stands it on an edge.
for (const [name, rotation] of [
  ["horizontal", [0, 0, 0]],
  ["upside down", [Math.PI, 0, 0]],
  ["on its edge", [Math.PI / 2, 0, 0]],
  ["tilted", [0.4, 0.7, 0.2]],
]) {
  test(`lay_flat rests the ${name} plate on its largest face at Z=0`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stl-lay-flat-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const geometry = new THREE.BoxGeometry(30, 20, 2);
    geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation)));
    geometry.translate(13, -7, 42);
    const original = new STLExporter().parse(new THREE.Mesh(geometry));
    geometry.dispose();
    const input = path.join(directory, "plate.stl");
    await fs.writeFile(input, original);
    const manipulator = new STLManipulator(directory);

    const output = await manipulator.layFlat(input);
    const info = await manipulator.getSTLInfo(output);
    assert.ok(Math.abs(info.boundingBox.dimensions.z - 2) < 0.0001,
      `plate height should be 2 mm, got ${info.boundingBox.dimensions.z}`);
    assert.ok(Math.abs(info.boundingBox.min.z) < 0.0001,
      `plate should touch Z=0, got ${info.boundingBox.min.z}`);
    assert.equal(info.faceCount, 12);
    assert.notEqual(output, input);
    assert.equal(await fs.readFile(input, "utf8"), original, "input must remain unchanged");

    // Laying an already flattened output down again must not stand it up.
    const repeated = await manipulator.layFlat(output);
    const repeatedInfo = await manipulator.getSTLInfo(repeated);
    assert.ok(Math.abs(repeatedInfo.boundingBox.dimensions.z - 2) < 0.0001);
    assert.ok(Math.abs(repeatedInfo.boundingBox.min.z) < 0.0001);
    assert.notEqual(repeated, output);
  });
}

// A plate with a raised block has equal up- and down-facing areas, because
// faces are grouped by direction. A seated part must stay seated whichever
// order its faces appear in, instead of flipping onto the block.
for (const order of ["plate first", "block first"]) {
  test(`lay_flat keeps a seated plate with a raised block upright (${order})`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stl-lay-flat-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const plate = new THREE.BoxGeometry(30, 20, 2).translate(0, 0, 1);
    const block = new THREE.BoxGeometry(10, 5, 1).translate(0, 0, 2.5);
    const geometry = mergeGeometries(order === "plate first" ? [plate, block] : [block, plate]);
    const input = path.join(directory, "embossed.stl");
    await fs.writeFile(input, new STLExporter().parse(new THREE.Mesh(geometry)));
    const manipulator = new STLManipulator(directory);

    const output = await manipulator.layFlat(input);
    const positions = new STLLoader().parse((await fs.readFile(output)).buffer).getAttribute("position");
    const top = [];
    let minZ = Infinity;
    for (let index = 0; index < positions.count; index++) minZ = Math.min(minZ, positions.getZ(index));
    for (let index = 0; index < positions.count; index++) {
      if (Math.abs(positions.getZ(index) - (minZ + 3)) < 0.0001) top.push(positions.getX(index));
    }
    assert.ok(Math.abs(minZ) < 0.0001, `part should touch Z=0, got ${minZ}`);
    assert.ok(top.length > 0, "part should be 3 mm tall");
    assert.ok(Math.max(...top) - Math.min(...top) < 10.0001, "the 10 mm block, not the 30 mm plate, should be on top");
  });
}

async function layFlatDimensions(t, geometry, rotation = [0.4, 0.7, 0.2]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stl-lay-flat-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation)));
  const input = path.join(directory, "part.stl");
  const view = new STLExporter().parse(new THREE.Mesh(geometry), { binary: true });
  await fs.writeFile(input, Buffer.from(view.buffer, view.byteOffset, view.byteLength));
  const manipulator = new STLManipulator(directory);
  const started = performance.now();
  const output = await manipulator.layFlat(input);
  const elapsed = performance.now() - started;
  const { boundingBox } = await manipulator.getSTLInfo(output);
  return { z: boundingBox.dimensions.z, minZ: boundingBox.min.z, elapsed };
}

// Fin sides are parallel but not coplanar. Summing them by direction (3 x 1200 mm²) beat the 1600 mm²
// base and stood the part on its side (40 mm tall); a plane groups them separately (1200 < 1600).
test("lay_flat keeps a base with parallel fins on its base instead of on the fins", async (t) => {
  const parts = [new THREE.BoxGeometry(40, 40, 2).translate(0, 0, 1)];
  for (const y of [-15, 0, 15]) parts.push(new THREE.BoxGeometry(40, 1, 30).translate(0, y, 17));
  const { z, minZ } = await layFlatDimensions(t, mergeGeometries(parts));
  assert.ok(Math.abs(z - 32) < 0.001, `the part should stand 32 mm tall on its base, got ${z}`);
  assert.ok(Math.abs(minZ) < 0.001);
});

// Each tall fin flank (2400 mm²) beats the 1600 mm² base, and the centre of mass projects onto it, but the
// base sticks out past that plane: only a plane that supports the whole mesh can carry the part.
test("lay_flat does not stand a base with tall fins on a fin flank", async (t) => {
  const parts = [new THREE.BoxGeometry(40, 40, 2).translate(0, 0, 1)];
  for (const y of [-15, 0, 15]) parts.push(new THREE.BoxGeometry(40, 1, 60).translate(0, y, 32));
  const { z, minZ } = await layFlatDimensions(t, mergeGeometries(parts));
  assert.ok(Math.abs(z - 62) < 0.001, `the part should stand 62 mm tall on its base, got ${z}`);
  assert.ok(Math.abs(minZ) < 0.001);
});

// The 6000 mm² panel is the largest face, but the 27000 mm³ block beside it carries the centre of mass
// outside the panel's outline, so the part would tip over: it has to rest on the 1000 mm² floor instead.
test("lay_flat skips a larger face that cannot carry the centre of mass", async (t) => {
  const panel = new THREE.BoxGeometry(100, 1, 60).translate(0, -20, 30);
  const block = new THREE.BoxGeometry(30, 30, 30).translate(65, 5, 15);
  const { z, minZ } = await layFlatDimensions(t, mergeGeometries([panel, block]));
  assert.ok(Math.abs(z - 60) < 0.001, `the part should stand 60 mm tall on its floor, got ${z}`);
  assert.ok(Math.abs(minZ) < 0.001);
});

test("lay_flat handles a 65k-triangle mesh in linear time", async (t) => {
  const sphere = new THREE.IcosahedronGeometry(30, 56).translate(0, 0, 34);
  sphere.deleteAttribute("uv");
  assert.ok(sphere.getAttribute("position").count / 3 > 64_000);
  const base = new THREE.CylinderGeometry(20, 20, 4, 64).rotateX(Math.PI / 2).translate(0, 0, 2).toNonIndexed();
  base.deleteAttribute("uv");
  const { z, minZ, elapsed } = await layFlatDimensions(t, mergeGeometries([sphere, base]));
  assert.ok(Math.abs(z - 64) < 0.01, `the disc should stay on the bed under the sphere, got ${z}`);
  assert.ok(Math.abs(minZ) < 0.01);
  // The pairwise grouping took 14-19 s here; the single pass takes well under a second.
  assert.ok(elapsed < 5000, `lay_flat took ${Math.round(elapsed)} ms`);
});

// A ring has no stable face (the centre of mass sits in the hole), so every candidate is tested and the
// largest face is the fallback. Scanning the whole mesh per candidate took about 20 s here.
test("lay_flat handles a 130k-triangle ring with no stable face in linear time", async (t) => {
  const torus = new THREE.TorusGeometry(30, 8, 180, 360);
  assert.ok(torus.index.count / 3 > 129_000);
  const { minZ, elapsed } = await layFlatDimensions(t, torus);
  assert.ok(Math.abs(minZ) < 0.01);
  assert.ok(elapsed < 5000, `lay_flat took ${Math.round(elapsed)} ms`);
});
