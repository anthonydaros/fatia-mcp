// Writes the laid-out project: a NEW 3MF made from the source by text splicing only. The build items' `transform` (new tx, ty, and a quarter turn about Z
// when the plan says so; tz and the tilt stay) in 3D/3dmodel.model, and the <plate> blocks of Metadata/model_settings.config rebuilt from the first
// plate as a template. The plate thumbnails, whose pictures show the old positions, are dropped with their entries; every other entry keeps its bytes,
// its place in the archive and its compression. The source is never written and an existing output is never overwritten.
// The written file is then opened again and the analysis is run on it: that is the proof the layout is what was planned (see proveLayout).
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { openProject } from "../knowledge/facts/settings.js";
import { listSafe3mfEntries, loadSafe3mfArchive, readBoundedPrintFile } from "../safety/archive.js";
import { analyzeLayout, readLayoutModel, type BedGeometry, type LayoutModel, type LayoutObject } from "./layout.js";
import { MAX_TEXT_CHARS, dropRelationships } from "./project-text.js";

const MODEL = "3D/3dmodel.model";
const MODEL_SETTINGS = "Metadata/model_settings.config";
const MODEL_RELS = "Metadata/_rels/model_settings.config.rels";
const FILAMENT_SEQUENCE = "Metadata/filament_sequence.json";
const EMPTY_GROUPING = '{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]}';
/** The plate pictures: they render the old positions. plate_N, plate_no_light_N, top_N, pick_N and every *_small.png. */
export const STALE_IMAGE = /^Metadata\/(?:(?:plate|plate_no_light|top|pick)_\d+|[^/]*_small)\.png$/;
const SLICE_RESULT = /^Metadata\/plate_\d+\.gcode$/;
const THUMBNAIL_KEYS = new Set(["thumbnail_file", "thumbnail_no_light_file", "top_file", "pick_file"]);

/** Where the plan puts one object: its final bounding-box centre in WORLD coordinates and the turn about Z (about the box centre) it needs first. */
export interface WorldItem { key: string; cx: number; cy: number; rotate: 0 | 90 }
export interface WorldPlate { name: string; items: WorldItem[] }
export interface WorldPlan { plates: WorldPlate[] }

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const fmt = (n: number): string => String(Number(n.toPrecision(12)));
const xmlEscape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const IDENTITY = "1 0 0 0 1 0 0 0 1 0 0 0".split(" ");

/**
 * The 12 numbers "m00 m01 m02 m10 m11 m12 m20 m21 m22 tx ty tz" (row vectors, v' = v*M + t) after turning the object about the vertical axis through
 * (cx, cy) and putting its bounding-box centre at (nx, ny). A quarter turn is M' = M * Rz(90) with Rz(90) = [[0,1,0],[-1,0,0],[0,0,1]]; the new translation
 * is t' = (t - c) * Rz + c'. tz never changes, so the object stays on the bed. Untouched numbers keep their original text.
 */
export function moveTransform(tokens: string[], from: { cx: number; cy: number }, to: { cx: number; cy: number }, rotate: 0 | 90): string[] {
  if (tokens.length !== 12) throw new Error("A 3MF transform has 12 numbers.");
  const t = tokens.map(Number);
  if (!t.every(Number.isFinite)) throw new Error("A 3MF transform holds a number that is not finite.");
  const out = [...tokens];
  if (rotate === 90) {
    for (let r = 0; r < 3; r++) { out[3 * r] = fmt(-t[3 * r + 1]); out[3 * r + 1] = fmt(t[3 * r]); }
    out[9] = fmt(-(t[10] - from.cy) + to.cx);
    out[10] = fmt(t[9] - from.cx + to.cy);
  } else {
    out[9] = fmt(t[9] + (to.cx - from.cx));
    out[10] = fmt(t[10] + (to.cy - from.cy));
  }
  return out;
}

/** Rewrites the transform of the build `<item>` tags listed in `edits` (by position among all `<item>` tags); everything else keeps its bytes. */
export function spliceItemTransforms(xml: string, edits: Map<number, { objectId: string; move(tokens: string[]): string[] }>): string {
  if (xml.length > MAX_TEXT_CHARS) throw new Error(`${MODEL} is too large to edit.`);
  let out = "";
  let pos = 0;
  let index = 0;
  for (let at = xml.indexOf("<item"); at >= 0; at = xml.indexOf("<item", at + 5)) {
    if (!/[\s/>]/.test(xml[at + 5] ?? "")) continue; // <items>, <itemfoo>
    const end = xml.indexOf(">", at);
    if (end < 0) throw new Error(`${MODEL} has an unterminated <item> tag.`);
    const edit = edits.get(index++);
    if (!edit) continue;
    const tag = xml.slice(at, end + 1);
    const id = /\sobjectid="([^"]*)"/.exec(tag)?.[1];
    if (id !== edit.objectId) throw new Error(`The ${index}th <item> is object ${id ?? "?"}, not ${edit.objectId}: the model changed under the layout.`);
    const found = /(\stransform=")([^"]*)(")/.exec(tag);
    const tokens = found ? found[2].trim().split(/\s+/) : IDENTITY;
    const next = edit.move(tokens).join(" ");
    const rewritten = found ? tag.slice(0, found.index) + found[1] + next + found[3] + tag.slice(found.index + found[0].length) : tag.replace(/\s*\/?>$/, m => ` transform="${next}"${m}`);
    out += xml.slice(pos, at) + rewritten;
    pos = end + 1;
  }
  if (index < Math.max(-1, ...edits.keys()) + 1) throw new Error(`${MODEL} has fewer <item> tags than the layout expects.`);
  return out + xml.slice(pos);
}

const lineStart = (xml: string, at: number) => xml.lastIndexOf("\n", at - 1) + 1;
const instanceKey = (block: string): string | undefined => {
  const id = /key="object_id"\s+value="([^"]*)"/.exec(block)?.[1];
  const inst = /key="instance_id"\s+value="([^"]*)"/.exec(block)?.[1] ?? "0";
  return id === undefined ? undefined : `${id}:${inst}`;
};

/**
 * Rebuilds the <plate> blocks of model_settings.config: the first block is the template (its keys, order and indentation); plater_id and plater_name are
 * new, locked becomes false, the four picture lines go, gcode_file (if the template has it) is blank, and each plate holds the model_instance blocks of
 * its objects, copied verbatim so identify_id survives. Instances without a mesh (not printable) stay on the first plate. Everything else is untouched.
 */
export function rebuildPlates(xml: string, plan: WorldPlan, unplaced: string[] = []): string {
  if (xml.length > MAX_TEXT_CHARS) throw new Error(`${MODEL_SETTINGS} is too large to edit.`);
  const first = xml.indexOf("<plate>");
  const lastClose = xml.lastIndexOf("</plate>");
  if (first < 0 || lastClose < 0) throw new Error(`${MODEL_SETTINGS} has no <plate> to use as a template.`);
  const blockStart = lineStart(xml, first);
  const blockEnd = lastClose + "</plate>".length;
  const eol = xml.includes("\r\n") ? "\r\n" : "\n";
  const indent = xml.slice(blockStart, first);
  const templateEnd = xml.indexOf("</plate>", first);
  const template = xml.slice(first, templateEnd);
  // Every model_instance block of every plate, by instance.
  const blocks = new Map<string, string>();
  for (let at = xml.indexOf("<model_instance", first); at >= 0 && at < lastClose; at = xml.indexOf("<model_instance", at + 1)) {
    const end = xml.indexOf("</model_instance>", at);
    if (end < 0) throw new Error(`${MODEL_SETTINGS} has an unterminated <model_instance>.`);
    const block = xml.slice(lineStart(xml, at), end + "</model_instance>".length);
    const key = instanceKey(block);
    if (key !== undefined && !blocks.has(key)) blocks.set(key, block.replace(/^[\r\n]+/, ""));
  }
  const instAt = template.indexOf("<model_instance");
  const headerLines = template.slice("<plate>".length, instAt < 0 ? template.length : lineStart(template, instAt)).split(/\r?\n/).filter(l => l.trim() !== "");
  const rendered = plan.plates.map((plate, i) => {
    const lines: string[] = [];
    let named = false;
    for (const line of headerLines) {
      const m = /^(\s*)<metadata\s+key="([^"]*)"\s+value="([^"]*)"\s*\/>\s*$/.exec(line);
      if (!m) { lines.push(line); continue; }
      const [, pad, key] = m;
      if (THUMBNAIL_KEYS.has(key)) continue;
      if (key === "plater_id") lines.push(`${pad}<metadata key="plater_id" value="${i + 1}"/>`);
      else if (key === "plater_name") { lines.push(`${pad}<metadata key="plater_name" value="${xmlEscape(plate.name)}"/>`); named = true; }
      else if (key === "locked") lines.push(`${pad}<metadata key="locked" value="false"/>`);
      else if (key === "gcode_file") lines.push(`${pad}<metadata key="gcode_file" value=""/>`);
      else lines.push(line);
    }
    if (!named) { // a template without a name still gets one, after plater_id
      const k = lines.findIndex(l => l.includes('key="plater_id"'));
      lines.splice(k + 1, 0, `${/^\s*/.exec(lines[k] ?? "")?.[0] ?? "    "}<metadata key="plater_name" value="${xmlEscape(plate.name)}"/>`);
    }
    const keys = [...plate.items.map(x => x.key), ...(i === 0 ? unplaced : [])];
    const instances = keys.map(k => {
      const b = blocks.get(k);
      if (b === undefined) throw new Error(`Instance ${k} is on no plate of ${MODEL_SETTINGS}, so its block cannot be reused.`);
      return b;
    });
    return [`${indent}<plate>`, ...lines, ...instances, `${indent}</plate>`].join(eol);
  });
  return xml.slice(0, blockStart) + rendered.join(eol) + xml.slice(blockEnd);
}

/** filament_sequence.json with one empty entry per plate of the new layout; undefined when the file is not a per-plate object (it stays as it is). */
export function filamentSequenceFor(json: string, plates: number): string | undefined {
  if (json.length > MAX_TEXT_CHARS) return undefined;
  let value: unknown;
  try { value = JSON.parse(json.replace(/^﻿/, "")); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (!keys.length || !keys.every(k => /^plate_\d+$/.test(k))) return undefined;
  return `{${Array.from({ length: plates }, (_, i) => `"plate_${i + 1}":${EMPTY_GROUPING}`).join(",")}}`;
}

export interface LayoutProof {
  ok: boolean;
  checks: Array<{ check: string; ok: boolean; detail: string }>;
  /** The analysis of the written file. */
  plates: ReturnType<typeof analyzeLayout>["plates"];
}
export interface MovedObject { key: string; name: string; plate: number; from: { x: number; y: number }; to: { x: number; y: number }; rotate_deg: 0 | 90 }
export interface WriteLayoutResult {
  path: string;
  sha256_of_source_before_and_after: { before: string; after: string };
  dropped_entries: string[];
  rewritten_entries: string[];
  moved: MovedObject[];
  proof: LayoutProof;
}
export interface WriteLayoutOptions {
  source: string;
  /** Must not exist. */
  output: string;
  plan: WorldPlan;
  geometry: BedGeometry;
  /** The overlap threshold the proof uses. */
  minGapMm: number;
}

const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

export async function writeLaidOutProject(o: WriteLayoutOptions): Promise<WriteLayoutResult> {
  const sourcePath = path.resolve(o.source);
  const outputPath = path.resolve(o.output);
  if (outputPath === sourcePath) throw new Error("The layout never writes over its source.");
  const bytes = await readBoundedPrintFile(sourcePath);
  const before = sha256(bytes);
  const zip = await loadSafe3mfArchive(bytes);
  const order = listSafe3mfEntries(bytes);
  if (order.some(e => SLICE_RESULT.test(e.name))) throw new Error("The project holds slice results (plate G-code): a layout would leave them stale. Use an unsliced project.");
  const model = await readLayoutModel(await openProject(sourcePath));
  const byKey = new Map(model.objects.map(x => [x.key, x]));

  // The plan must place every printable object exactly once.
  const planned = new Map<string, WorldItem>();
  for (const plate of o.plan.plates) for (const item of plate.items) {
    if (!byKey.has(item.key)) throw new Error(`The plan names ${item.key}, which is not a printable object of the project.`);
    if (planned.has(item.key)) throw new Error(`The plan places ${item.key} twice.`);
    planned.set(item.key, item);
  }
  for (const x of model.objects) if (!planned.has(x.key)) throw new Error(`The plan leaves ${x.name} (${x.key}) out.`);

  const text = async (name: string): Promise<string | undefined> => zip.file(name)?.async("string");
  const rewritten = new Map<string, string>();
  const modelXml = await text(MODEL);
  if (modelXml === undefined) throw new Error(`The project has no ${MODEL}.`);
  const edits = new Map<number, { objectId: string; move(tokens: string[]): string[] }>();
  for (const x of model.objects) {
    const item = planned.get(x.key)!;
    const from = { cx: (x.box.x0 + x.box.x1) / 2, cy: (x.box.y0 + x.box.y1) / 2 };
    edits.set(x.itemIndex, { objectId: x.objectId, move: tokens => moveTransform(tokens, from, { cx: item.cx, cy: item.cy }, item.rotate) });
  }
  rewritten.set(MODEL, spliceItemTransforms(modelXml, edits));
  const settings = await text(MODEL_SETTINGS);
  if (settings === undefined) throw new Error(`The project has no ${MODEL_SETTINGS}, so there are no plates to rebuild.`);
  rewritten.set(MODEL_SETTINGS, rebuildPlates(settings, o.plan, model.unplaced));
  const sequence = await text(FILAMENT_SEQUENCE);
  const sequenceNext = sequence === undefined ? undefined : filamentSequenceFor(sequence, o.plan.plates.length);
  if (sequenceNext !== undefined && sequenceNext !== sequence) rewritten.set(FILAMENT_SEQUENCE, sequenceNext);
  const dropped = new Set(order.map(e => e.name).filter(n => STALE_IMAGE.test(n)));
  const rels = await text(MODEL_RELS);
  if (rels !== undefined && dropped.size > 0) {
    const next = dropRelationships(rels, dropped);
    if (next === undefined) dropped.add(MODEL_RELS);
    else if (next !== rels) rewritten.set(MODEL_RELS, next);
  }

  const out = new JSZip();
  for (const { name, stored } of order) {
    if (dropped.has(name)) continue;
    const isDir = name.endsWith("/");
    out.file(name, rewritten.get(name) ?? (isDir ? "" : await zip.file(name)!.async("nodebuffer")), { dir: isDir, createFolders: false, compression: stored ? "STORE" : "DEFLATE" });
  }
  const written = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await fs.writeFile(outputPath, written, { flag: "wx" });
  } catch (error: any) {
    throw new Error(error?.code === "EEXIST" ? `${outputPath} already exists; the layout never overwrites a file.` : error.message);
  }
  let proof: LayoutProof;
  try {
    proof = await proveLayout({ file: outputPath, expectedPlan: o.plan, before: { model, zip, order, dropped, rewritten }, geometry: o.geometry, minGapMm: o.minGapMm });
    const after = sha256(await readBoundedPrintFile(sourcePath));
    proof.checks.push({ check: "the source is unchanged", ok: after === before, detail: after === before ? "SHA-256 equal before and after" : "the source changed while the layout was written" });
    proof.ok = proof.checks.every(c => c.ok);
    if (!proof.ok) throw new Error(`Layout verification failed: ${proof.checks.filter(c => !c.ok).map(c => `${c.check} (${c.detail})`).join("; ")}`);
  } catch (error) {
    await fs.rm(outputPath, { force: true });
    throw error;
  }
  const count = o.plan.plates.length;
  const moved: MovedObject[] = o.plan.plates.flatMap((plate, i) => plate.items.map(item => {
    const x = byKey.get(item.key)!;
    return { key: item.key, name: x.name, plate: i + 1, from: { x: (x.box.x0 + x.box.x1) / 2, y: (x.box.y0 + x.box.y1) / 2 }, to: { x: item.cx, y: item.cy }, rotate_deg: item.rotate };
  }));
  void count;
  return { path: outputPath, sha256_of_source_before_and_after: { before, after: sha256(await readBoundedPrintFile(sourcePath)) }, dropped_entries: [...dropped], rewritten_entries: [...rewritten.keys()], moved, proof };
}

interface Before { model: LayoutModel; zip: JSZip; order: Array<{ name: string; stored: boolean }>; dropped: Set<string>; rewritten: Map<string, string> }

/** Opens the written file again and checks it against the plan and against its source. Does not throw for a failed check: the caller decides. */
export async function proveLayout(a: { file: string; expectedPlan: WorldPlan; before: Before; geometry: BedGeometry; minGapMm: number }): Promise<LayoutProof> {
  const checks: LayoutProof["checks"] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ check: name, ok, detail });
  const bytes = await readBoundedPrintFile(a.file);
  const zip = await loadSafe3mfArchive(bytes);
  const names = listSafe3mfEntries(bytes).map(e => e.name);
  const expectedNames = a.before.order.map(e => e.name).filter(n => !a.before.dropped.has(n));
  check("entry list and order", JSON.stringify(names) === JSON.stringify(expectedNames), `${names.length} entries, ${a.before.dropped.size} dropped`);
  let identical = 0;
  const different: string[] = [];
  for (const n of names) {
    if (a.before.rewritten.has(n) || n.endsWith("/")) continue;
    if ((await zip.file(n)!.async("nodebuffer")).equals(await a.before.zip.file(n)!.async("nodebuffer"))) identical++; else different.push(n);
  }
  check("every other entry is byte-identical", different.length === 0, different.length ? `differs: ${different.slice(0, 5).join(", ")}` : `${identical} entries identical`);
  check("stale plate pictures removed", !names.some(n => STALE_IMAGE.test(n)), `${names.filter(n => STALE_IMAGE.test(n)).length} left`);

  const project = await openProject(a.file);
  const model = await readLayoutModel(project);
  const analysis = analyzeLayout(model, a.geometry, { minGapMm: a.minGapMm });
  check("no object outside, straddling, overlapping or too tall", analysis.clean, analysis.clean ? "analysis of the written file found nothing" : analysis.issues.slice(0, 4).map(i => i.text).join(" | "));
  check("every object on exactly one plate", model.objects.every(x => x.plates.length === 1), `${model.objects.filter(x => x.plates.length !== 1).length} not`);
  check("plate count as planned", model.plates.length === a.expectedPlan.plates.length, `${model.plates.length} plate(s), ${a.expectedPlan.plates.length} planned`);
  check("plates hold what the plan says", a.expectedPlan.plates.every((p, i) => JSON.stringify([...p.items.map(x => x.key)].sort()) === JSON.stringify([...(model.plates[i]?.keys ?? [])].filter(k => model.objects.some(x => x.key === k)).sort())), "per plate, by instance");
  check("object count unchanged", model.objects.length === a.before.model.objects.length, `${model.objects.length} of ${a.before.model.objects.length}`);
  const [v0, v1] = [a.before.model.objects.reduce((s, x) => s + x.volume_mm3, 0), model.objects.reduce((s, x) => s + x.volume_mm3, 0)];
  check("total object volume unchanged (1e-6 relative)", Math.abs(v1 - v0) <= 1e-6 * Math.max(v0, 1e-9), `${v0.toFixed(3)} -> ${v1.toFixed(3)} mm3`);
  const byKey = new Map(model.objects.map(x => [x.key, x] as [string, LayoutObject]));
  const off: string[] = [];
  for (const plate of a.expectedPlan.plates) for (const item of plate.items) {
    const x = byKey.get(item.key);
    const before = a.before.model.objects.find(y => y.key === item.key)!;
    if (!x) { off.push(item.key); continue; }
    const [bw, bd] = [before.box.x1 - before.box.x0, before.box.y1 - before.box.y0];
    const [w, d] = item.rotate === 90 ? [bd, bw] : [bw, bd];
    const ok = near((x.box.x0 + x.box.x1) / 2, item.cx) && near((x.box.y0 + x.box.y1) / 2, item.cy) && near(x.box.x1 - x.box.x0, w) && near(x.box.y1 - x.box.y0, d) && near(x.box.z0, before.box.z0) && near(x.box.z1, before.box.z1);
    if (!ok) off.push(x.name);
  }
  check("every object is where the plan put it (centre, size, same height on the bed)", off.length === 0, off.length ? `off: ${off.slice(0, 5).join(", ")}` : `${byKey.size} objects`);
  return { ok: checks.every(c => c.ok), checks, plates: analysis.plates };
}
