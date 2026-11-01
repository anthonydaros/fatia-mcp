// Triangle meshes for the mesh facts: the printable objects of one plate of a 3MF (build item transform applied the way the spec validated:
// row vectors, v' = v*M + t, component transform first, then the item), or one STL. Everything read is untrusted data: sizes, triangle counts,
// nesting and fan-out are capped, and a hostile file ends in a MeshReadError that names the reason, never in a guess.
// Spec: kb/tuning/out/analyzer-spec.md sections 3 and 8.
import fs from "node:fs/promises";
import path from "node:path";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js"; // the binary parser behind src/stl/stl-manipulator.ts loadSTL (ASCII is scanned here, see asciiVertices)
import type { ProjectFiles } from "../knowledge/types.js";
import { asArray, meta, plateInstances } from "../knowledge/facts/settings.js";
import { MAX_PRINT_FILE_BYTES } from "../safety/archive.js";

/** Triangle soup in world space: pos = x,y,z per vertex, idx = 3 vertex numbers per triangle (counter-clockwise seen from outside). */
export interface Soup { pos: Float64Array; idx: Uint32Array }
/**
 * One printable object (a build item): all its model parts together. objectId, instance (the build items of one object counted in order, as
 * model_settings.config's instance_id does), itemIndex (position among all build items, which is also the order of the `<item>` tags) and painted
 * (some triangle carries a paint_color) are what the layout stage needs to find the item again.
 */
export interface MeshObject { name: string; soup: Soup; objectId?: string; instance?: number; itemIndex?: number; painted?: boolean }
export interface ReadMesh { objects: MeshObject[]; triangles: number }
export type MeshReadFailure = "too_large" | "no_geometry" | "unreadable" | "no_plate";
export class MeshReadError extends Error {
  constructor(readonly code: MeshReadFailure, message: string) { super(message); }
}

/** Triangles accepted over all instances of one read (the spec's safe limit for the linear pass). */
export const MAX_TRIANGLES = 3_000_000;
const MAX_MODEL_BYTES = 256 * 2 ** 20; // the archive reader's own per-entry cap
const MAX_DEPTH = 8; // same limits as STLManipulator.get3MFInfo
const MAX_INSTANCES = 10_000;
const MAIN_MODEL = "3D/3dmodel.model";

type Matrix = readonly number[]; // 12 numbers: m00 m01 m02 m10 m11 m12 m20 m21 m22 tx ty tz
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseMatrix(text: string | undefined): Matrix {
  if (text === undefined) return IDENTITY;
  const t = text.trim().split(/\s+/).map(Number);
  if (t.length !== 12 || !t.every(Number.isFinite)) throw new MeshReadError("unreadable", `invalid 3MF transform (${t.length} numbers read; 12 finite numbers expected)`); // never echo file text: it reaches the report
  return t;
}
/** First `inner`, then `outer` (row vectors). */
function compose(inner: Matrix, outer: Matrix): Matrix {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push(inner[3 * r] * outer[c] + inner[3 * r + 1] * outer[3 + c] + inner[3 * r + 2] * outer[6 + c]);
  for (let c = 0; c < 3; c++) out.push(inner[9] * outer[c] + inner[10] * outer[3 + c] + inner[11] * outer[6 + c] + outer[9 + c]);
  return out;
}
const det = (m: Matrix) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/** Value of attribute `name` in the text of a tag, with or without a namespace prefix (`p:path`). */
function attr(tag: string, name: string): string | undefined {
  const needle = `${name}="`;
  for (let i = tag.indexOf(needle); i > 0; i = tag.indexOf(needle, i + 1)) {
    const before = tag.charCodeAt(i - 1);
    if (before === 32 || before === 9 || before === 10 || before === 13 || before === 58) {
      const start = i + needle.length;
      const end = tag.indexOf('"', start);
      return end < 0 ? undefined : tag.slice(start, end);
    }
  }
  return undefined;
}

class Grow<T extends Float64Array | Uint32Array> {
  n = 0;
  constructor(private make: (size: number) => T, public a: T = make(1024)) {}
  push(v: number): void {
    if (this.n === this.a.length) { const b = this.make(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  done(): T { return this.a.slice(0, this.n) as T; }
}

interface ModelObject { verts: Float64Array; tris: Uint32Array; components: Array<{ id: string; path?: string; matrix: Matrix }>; painted: boolean }
interface Item { objectId: string; path?: string; matrix: Matrix; printable: boolean }
interface Budget { triangles: number }

/** The objects (and, in the main model, the build items) of one 3MF model file, tokenized tag by tag over the bytes (no regex over the whole file). */
function parseModel(buf: Buffer, budget: Budget): { objects: Map<string, ModelObject>; items: Item[] } {
  const objects = new Map<string, ModelObject>();
  const items: Item[] = [];
  let id: string | undefined, ordinal = 0, verts = new Grow(n => new Float64Array(n)), tris = new Grow(n => new Uint32Array(n)), components: ModelObject["components"] = [], painted = false;
  for (let i = buf.indexOf(60); i >= 0; i = buf.indexOf(60, i + 1)) {
    const next = buf[i + 1];
    if (next === 33 || next === 63) { // comment, CDATA, declaration: skip past it
      const close = buf.indexOf(buf[i + 2] === 45 ? "-->" : ">", i + 2);
      if (close < 0) break;
      i = close;
      continue;
    }
    const end = buf.indexOf(62, i);
    if (end < 0 || end - i > 65536) throw new MeshReadError("unreadable", "3MF model XML has an unterminated or oversized tag");
    if (next === 47) { // closing tag
      if (id !== undefined && /^\/(?:\w+:)?object\b/.test(buf.toString("latin1", i + 1, Math.min(end, i + 40)))) {
        const vertexValues = verts.done(), triangleValues = tris.done();
        for (const v of triangleValues) if (v >= vertexValues.length / 3) throw new MeshReadError("unreadable", `object #${ordinal}: a triangle uses a vertex that does not exist`);
        objects.set(id, { verts: vertexValues, tris: triangleValues, components, painted });
        id = undefined;
      }
      i = end;
      continue;
    }
    const text = buf.toString("latin1", i + 1, end);
    const name = /^(?:\w+:)?(\w+)/.exec(text)?.[1];
    if (name === "vertex" && id !== undefined) {
      const xyz = [attr(text, "x"), attr(text, "y"), attr(text, "z")].map(Number);
      if (!xyz.every(Number.isFinite)) throw new MeshReadError("unreadable", `object #${ordinal}: a vertex is not a finite number`);
      verts.push(xyz[0]); verts.push(xyz[1]); verts.push(xyz[2]);
    } else if (name === "triangle" && id !== undefined) {
      if (--budget.triangles < 0) throw new MeshReadError("too_large", "the 3MF holds more triangles than the analyzer's limit");
      if (!painted && text.includes("paint_color")) painted = true;
      for (const key of ["v1", "v2", "v3"]) {
        const v = Number(attr(text, key));
        if (!Number.isInteger(v) || v < 0) throw new MeshReadError("unreadable", `object #${ordinal}: a triangle has no valid ${key}`);
        tris.push(v);
      }
    } else if (name === "object" && !text.endsWith("/")) {
      id = attr(text, "id");
      ordinal++;
      verts = new Grow(n => new Float64Array(n));
      tris = new Grow(n => new Uint32Array(n));
      components = [];
      painted = false;
    } else if (name === "component" && id !== undefined) {
      const objectid = attr(text, "objectid");
      if (objectid) components.push({ id: objectid, path: attr(text, "path"), matrix: parseMatrix(attr(text, "transform")) });
    } else if (name === "item") {
      const objectId = attr(text, "objectid");
      if (objectId) items.push({ objectId, path: attr(text, "path"), matrix: parseMatrix(attr(text, "transform")), printable: attr(text, "printable") !== "0" });
    }
    i = end;
  }
  return { objects, items };
}

/**
 * Makes the triangles idx[from..to) face outward. A closed mesh whose signed volume is negative is inside out (reversed winding, common from other
 * exporters; Studio repairs it and slices it like a normal part), so two corners of each triangle are swapped. The sum starts at the first vertex to
 * keep it small. Meaningful for closed meshes only: an open surface has no sign, and keeps what it has when the volume is not negative.
 */
export function faceOutward(pos: Float64Array, idx: Uint32Array, from: number, to: number): void {
  if (to <= from) return;
  const o = idx[from] * 3;
  let volume = 0;
  for (let i = from; i < to; i += 3) {
    const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [pos[a] - pos[o], pos[a + 1] - pos[o + 1], pos[a + 2] - pos[o + 2], pos[b] - pos[o], pos[b + 1] - pos[o + 1], pos[b + 2] - pos[o + 2], pos[c] - pos[o], pos[c + 1] - pos[o + 1], pos[c + 2] - pos[o + 2]];
    volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  if (volume < 0) for (let i = from; i < to; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
}

interface Placed { objectId: string; verts: Float64Array; tris: Uint32Array; matrix: Matrix; painted: boolean }

/**
 * Reads the printable normal-part meshes of one plate of an opened 3MF (`plateIndex` null: of every plate, which the layout stage needs).
 * A file without geometry (a GUI-sliced export) is `no_geometry`.
 */
export async function readProjectMesh(project: ProjectFiles, plateIndex: number | null, maxTriangles = MAX_TRIANGLES): Promise<ReadMesh> {
  if (!project.read) throw new MeshReadError("unreadable", "the 3MF was not opened with entry access");
  const budget: Budget = { triangles: maxTriangles };
  const models = new Map<string, Map<string, ModelObject>>();
  const load = async (name: string): Promise<Map<string, ModelObject>> => {
    const entry = name.replace(/^\/+/, "");
    if (!models.has(entry)) {
      const bytes = await project.read!(entry, MAX_MODEL_BYTES);
      models.set(entry, bytes ? parseModel(bytes, budget).objects : new Map());
    }
    return models.get(entry)!;
  };
  const main = await project.read(MAIN_MODEL, MAX_MODEL_BYTES);
  if (!main) throw new MeshReadError("no_geometry", `the 3MF has no ${MAIN_MODEL}`);
  const parsed = parseModel(main, budget);
  models.set(MAIN_MODEL, parsed.objects);

  const modelSettings = project.modelSettings;
  const hasPlates = plateIndex !== null && asArray(modelSettings?.plate).length > 0;
  const onPlate = hasPlates ? plateInstances(modelSettings, plateIndex) : undefined;
  if (hasPlates && !onPlate) throw new MeshReadError("no_plate", `the project has no plate ${plateIndex! + 1}`);

  const seen = new Map<string, number>();
  const objects: MeshObject[] = [];
  let triangles = 0, vertices = 0, instances = 0;
  for (const [itemIndex, item] of parsed.items.entries()) {
    const instance = seen.get(item.objectId) ?? 0; // instance_id counts the build items of the same object in order
    seen.set(item.objectId, instance + 1);
    if (!item.printable || (onPlate && !onPlate.includes(`${item.objectId}:${instance}`))) continue;
    // Studio sizes and bed-checks an object from its model parts only: modifier, negative and support volumes are not part of the mesh.
    const notModel = new Set(asArray(modelSettings?.object).filter(o => String(o.id) === item.objectId).flatMap(o => asArray(o.part))
      .filter(p => (p.subtype ?? "normal_part") !== "normal_part").map(p => String(p.id)));
    const placed: Placed[] = [];
    const visit = async (file: string, id: string, matrix: Matrix, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) throw new MeshReadError("unreadable", "3MF components are nested too deeply");
      if (++instances > MAX_INSTANCES) throw new MeshReadError("unreadable", "3MF has too many component instances");
      const object = (await load(file)).get(id);
      if (!object) return;
      if (object.verts.length && object.tris.length && !notModel.has(id)) {
        triangles += object.tris.length / 3;
        vertices += object.verts.length / 3; // every instance copies all vertices of its object, referenced or not: a fan-out of big objects must stop here
        if (triangles > maxTriangles || vertices > 3 * maxTriangles) throw new MeshReadError("too_large", `the plate holds more than ${maxTriangles} triangles or ${3 * maxTriangles} vertices`);
        placed.push({ objectId: id, verts: object.verts, tris: object.tris, matrix, painted: object.painted });
      }
      for (const c of object.components) await visit(c.path ?? file, c.id, compose(c.matrix, matrix), depth + 1);
    };
    await visit(item.path ?? MAIN_MODEL, item.objectId, item.matrix, 0);
    if (!placed.length) continue;
    const pos = new Float64Array(placed.reduce((n, p) => n + p.verts.length, 0));
    const idx = new Uint32Array(placed.reduce((n, p) => n + p.tris.length, 0));
    let vo = 0, to = 0;
    for (const p of placed) {
      const from = to, m = p.matrix, flip = det(m) < 0; // a mirroring transform turns the triangles inside out: swap two corners back
      const base = vo / 3;
      for (let i = 0; i < p.verts.length; i += 3) {
        const [x, y, z] = [p.verts[i], p.verts[i + 1], p.verts[i + 2]];
        pos[vo++] = x * m[0] + y * m[3] + z * m[6] + m[9];
        pos[vo++] = x * m[1] + y * m[4] + z * m[7] + m[10];
        pos[vo++] = x * m[2] + y * m[5] + z * m[8] + m[11];
      }
      for (let i = 0; i < p.tris.length; i += 3) {
        idx[to++] = base + p.tris[i];
        idx[to++] = base + p.tris[flip ? i + 2 : i + 1];
        idx[to++] = base + p.tris[flip ? i + 1 : i + 2];
      }
      faceOutward(pos, idx, from, to);
    }
    const name = asArray(modelSettings?.object).find(o => String(o.id) === item.objectId);
    objects.push({ name: String(meta(name, "name") ?? `object ${item.objectId}`), soup: { pos, idx }, objectId: item.objectId, instance, itemIndex, painted: placed.some(p => p.painted) });
  }
  if (!objects.length) throw new MeshReadError("no_geometry", hasPlates ? `plate ${plateIndex! + 1} has no printable model geometry` : "the 3MF has no printable model geometry");
  return { objects, triangles };
}

/** Vertex numbers of an ASCII STL by one linear scan: STLLoader's facet...endfacet regex is quadratic on a file with facets that never end, and it runs before any cap. */
function asciiVertices(text: string, maxTriangles: number): number[] {
  const out: number[] = [];
  const vertex = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  for (let m; (m = vertex.exec(text)); ) {
    out.push(+m[1], +m[2], +m[3]); // a non-number becomes NaN and is refused by the finite check below
    if (out.length > 9 * maxTriangles) throw new MeshReadError("too_large", `the STL holds more than ${maxTriangles} triangles`);
  }
  if (out.length % 9) throw new MeshReadError("unreadable", "the ASCII STL has a facet that does not have three vertices");
  return out;
}

/** Reads one STL (binary or ASCII) as a single object; units are taken as millimetres. */
export async function readStlMesh(filePath: string, maxTriangles = MAX_TRIANGLES): Promise<ReadMesh> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new MeshReadError("unreadable", "not a regular file");
  if (stat.size > MAX_PRINT_FILE_BYTES) throw new MeshReadError("too_large", `${Math.ceil(stat.size / 2 ** 20)} MiB is over the 256 MiB inspection limit`);
  const bytes = await fs.readFile(filePath);
  const binary = bytes.length >= 84 && bytes.length === 84 + 50 * bytes.readUInt32LE(80);
  if (binary && bytes.readUInt32LE(80) > maxTriangles) throw new MeshReadError("too_large", `the STL holds more than ${maxTriangles} triangles`);
  if (!binary && !/^\s*solid\b/i.test(bytes.toString("latin1", 0, 256))) throw new MeshReadError("unreadable", "not a binary or ASCII STL");
  let position: ArrayLike<number>;
  if (binary) {
    try {
      const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength; // a big readFile owns its ArrayBuffer: no copy
      const buffer = (whole ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer;
      position = new STLLoader().parse(buffer).getAttribute("position").array;
    } catch (error) {
      throw new MeshReadError("unreadable", `the STL could not be parsed (${(error as Error).message})`);
    }
  } else {
    position = asciiVertices(bytes.toString("latin1"), maxTriangles);
  }
  const triangles = Math.floor(position.length / 9);
  if (!triangles) throw new MeshReadError("no_geometry", "the STL has no triangles");
  if (triangles > maxTriangles) throw new MeshReadError("too_large", `the STL holds more than ${maxTriangles} triangles`);
  const pos = Float64Array.from(position as ArrayLike<number>); // whole triangles either way
  if (pos.some(v => !Number.isFinite(v))) throw new MeshReadError("unreadable", "the STL has a vertex that is not a finite number");
  const idx = Uint32Array.from({ length: triangles * 3 }, (_, i) => i);
  faceOutward(pos, idx, 0, idx.length);
  return { objects: [{ name: path.basename(filePath), soup: { pos, idx } }], triangles };
}
