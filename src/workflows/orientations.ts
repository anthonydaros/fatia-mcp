import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { asArray, meta, openProject, plateInstances } from '../knowledge/facts/settings.js';
import { readBoundedPrintFile, loadSafe3mfArchive } from '../safety/archive.js';
import { readProjectMesh, type Soup } from '../tuning/mesh-read.js';
import { meshFactsFromRead } from '../tuning/mesh-facts.js';
import { writeTunedProject } from '../tuning/project-writer.js';
import { spliceItemTransforms, rebuildPlates, STALE_IMAGE } from '../tuning/layout-writer.js';
import { dropRelationships } from '../tuning/project-text.js';
import { sliceFacts } from '../tuning/slice-facts.js';
import { requireMillimeters } from './geometry.js';
import type { ScenarioDeps } from './scenarios.js';

const rotationProperty = { type: 'number', minimum: -360, maximum: 360, default: 0, description: 'Rotation about this world axis, in degrees; default 0.' };
export const ORIENTATION_TOOLS: Tool[] = [{
  name: 'compare_print_orientations',
  description: 'Compare up to six world-space rotations of a single printable item in a single-plate printer-compatible 3MF. Preserves paint, modifiers and settings; rests each candidate on the bed and slices within explicit budgets. Returns separate unsliced projects and estimated time/material, support and geometric bed-contact evidence. No physical strength or quality guarantee; prepare STL or another printer first.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
    path: { type: 'string', minLength: 1, description: 'Existing compatible single-item, single-plate 3MF.' },
    bambu_model: { type: 'string', description: 'Selected printer model, otherwise BAMBU_MODEL or elicitation.' },
    orientations: { type: 'array', minItems: 1, maxItems: 6, description: 'World rotations applied X then Y then Z, in degrees. Defaults to the six orthogonal sides.', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, rotation_x: rotationProperty, rotation_y: rotationProperty, rotation_z: rotationProperty } } },
    max_slices: { type: 'integer', minimum: 1, maximum: 6, default: 6, description: 'Maximum CLI attempts, including failures.' },
    max_minutes: { type: 'number', minimum: .1, maximum: 60, default: 10, description: 'Wall-clock budget in minutes, including writing and slicing.' },
  } },
}];
type Rotation = { name: string; rotation_x: number; rotation_y: number; rotation_z: number };
const defaults = [{ name: 'original' }, { name: 'x-90', rotation_x: 90 }, { name: 'x-180', rotation_x: 180 }, { name: 'x-270', rotation_x: 270 }, { name: 'y-90', rotation_y: 90 }, { name: 'y-270', rotation_y: 270 }];
const hash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
function range(value: unknown, fallback: number, min: number, max: number, key: string, integer = false): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw Error(`${key} must be ${min}..${max}${integer ? ' integer' : ' finite'}`);
  return n;
}
function rotate(v: number[], r: Rotation): number[] {
  let [x, y, z] = v;
  for (const [axis, deg] of [[0, r.rotation_x], [1, r.rotation_y], [2, r.rotation_z]]) {
    const angle = deg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    if (axis === 0) [y, z] = [y * c - z * s, y * s + z * c];
    if (axis === 1) [x, z] = [x * c + z * s, -x * s + z * c];
    if (axis === 2) [x, y] = [x * c - y * s, x * s + y * c];
  }
  return [x, y, z];
}
function bounds(soup: Soup, r?: Rotation) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const i of soup.idx) {
    const xyz = Array.from(soup.pos.subarray(i * 3, i * 3 + 3));
    const v = r ? rotate(xyz, r) : xyz;
    for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], v[j]); hi[j] = Math.max(hi[j], v[j]); }
  }
  return { lo, hi };
}

export async function comparePrintOrientations(args: Record<string, unknown>, deps: ScenarioDeps): Promise<Record<string, any>> {
  if (typeof args.path !== 'string' || !args.path.toLowerCase().endsWith('.3mf')) throw Error('path must be a printer-compatible 3MF; prepare STL first');
  if (args.plate_index !== undefined) throw Error('Only a single plate is supported; plate_index must be omitted');
  const raw = args.orientations ?? defaults;
  if (!Array.isArray(raw) || !raw.length || raw.length > 6) throw Error('orientations must contain 1..6 rotations');
  const rotations = raw.map((r: any): Rotation => {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 80) throw Error('orientation name must contain 1..80 characters');
    return { name: r.name, rotation_x: range(r.rotation_x, 0, -360, 360, 'rotation_x'), rotation_y: range(r.rotation_y, 0, -360, 360, 'rotation_y'), rotation_z: range(r.rotation_z, 0, -360, 360, 'rotation_z') };
  });
  if (new Set(rotations.map(r => r.name)).size !== rotations.length) throw Error('orientation names must be unique');
  const max = range(args.max_slices, 6, 1, 6, 'max_slices', true), minutes = range(args.max_minutes, 10, .1, 60, 'max_minutes');
  deps.signal?.throwIfAborted();
  const now = deps.now ?? Date.now, started = now(), before = hash(await readBoundedPrintFile(args.path));
  const project = await openProject(args.path);
  if (project.config?.printer_settings_id !== deps.printerPreset) throw Error('Project must already match selected printer; run prepare_print_project first');
  const plates = asArray(project.modelSettings?.plate), membership = plateInstances(project.modelSettings, 0);
  if (plates.length !== 1 || Number(meta(plates[0], 'plater_id')) !== 1 || membership?.length !== 1 || !/^\d+:\d+$/.test(membership[0])) throw Error('A single plate with one printable build item and reliable membership is required');
  if (['true', '1'].includes(String(meta(plates[0], 'locked')))) throw Error('Cannot rotate a locked plate');
  for (const name of (project.names ?? []).filter(n => n.toLowerCase().endsWith('.model'))) {
    const bytes = await project.read!(name); if (bytes) requireMillimeters(bytes);
  }
  const mesh = await readProjectMesh(project, null);
  if (mesh.objects.length !== 1 || `${mesh.objects[0].objectId}:${mesh.objects[0].instance}` !== membership[0]) throw Error('Only one printable build item on the selected plate is supported');
  const item = mesh.objects[0];
  if (!item.soup.pos.every(Number.isFinite)) throw Error('World geometry must contain finite coordinates');
  const originalBounds = bounds(item.soup);
  if (item.objectId === undefined || item.itemIndex === undefined) throw Error('Build item identity is unavailable');
  const originalCenter = [0, 1].map(i => originalBounds.lo[i] / 2 + originalBounds.hi[i] / 2);
  deps.signal?.throwIfAborted();
  await fs.mkdir(deps.tempDir, { recursive: true }); await fs.mkdir(deps.outputDir, { recursive: true });
  const work = await fs.mkdtemp(path.join(path.resolve(deps.tempDir), 'orientation-work-'));
  const delivered = await fs.mkdtemp(path.join(path.resolve(deps.outputDir), 'orientations-'));
  const controller = new AbortController(), abort = () => controller.abort(deps.signal?.reason);
  deps.signal?.addEventListener('abort', abort, { once: true }); if (deps.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(Error('Orientation time budget exhausted')), minutes * 60000); timer.unref();
  let slices = 0, stop = 'done';
  const records: Array<Record<string, any>> = [];
  const stopped = () => deps.signal?.aborted ? 'cancelled' : controller.signal.aborted || now() - started >= minutes * 60000 ? 'budget_minutes' : slices >= max ? 'budget_slices' : undefined;
  try {
    for (const [id, r] of rotations.entries()) {
      const record: Record<string, any> = { orientation_id: id, ...r, status: 'not_run', time_s: null, weight_g: null, support_weight_g: null, contact_area_mm2: null };
      records.push(record); const why = stopped(); if (why) { stop = why; continue; }
      try {
        const prepared = await writeTunedProject({ source: args.path, output: path.join(work, `base-${id}.3mf`), target: { printerPreset: deps.printerPreset }, changes: [] });
        const zip = await loadSafe3mfArchive(await readBoundedPrintFile(prepared.path));
        const rotatedBounds = bounds(item.soup, r), offset = [originalCenter[0] - (rotatedBounds.lo[0] + rotatedBounds.hi[0]) / 2, originalCenter[1] - (rotatedBounds.lo[1] + rotatedBounds.hi[1]) / 2, -rotatedBounds.lo[2]];
        if (![...rotatedBounds.lo, ...rotatedBounds.hi, ...offset].every(Number.isFinite)) throw Error('Rotated geometry must contain finite coordinates');
        const model = await zip.file('3D/3dmodel.model')!.async('string');
        zip.file('3D/3dmodel.model', spliceItemTransforms(model, new Map([[item.itemIndex!, { objectId: item.objectId!, move: tokens => {
          const v = tokens.map(Number), next: number[] = [];
          if (v.length !== 12 || !v.every(Number.isFinite)) throw Error('Invalid build transform');
          for (let i = 0; i < 12; i += 3) next.push(...rotate(v.slice(i, i + 3), r).map((n, axis) => n + (i === 9 ? offset[axis] : 0)));
          if (!next.every(Number.isFinite)) throw Error('Rotated transform must contain finite coordinates');
          return next.map(n => String(Number(n.toPrecision(14))));
        } }]])));
        const dropped = new Set(Object.keys(zip.files).filter(n => STALE_IMAGE.test(n)));
        for (const n of dropped) zip.remove(n);
        zip.file('Metadata/model_settings.config', rebuildPlates(await zip.file('Metadata/model_settings.config')!.async('string'), { plates: [{ name: r.name, items: [{ key: membership[0], cx: originalCenter[0], cy: originalCenter[1], rotate: 0 }] }] }));
        for (const n of Object.keys(zip.files).filter(n => n.endsWith('.rels'))) {
          const original = await zip.file(n)!.async('string'), next = dropRelationships(original, dropped);
          if (next === undefined) zip.remove(n); else if (next !== original) zip.file(n, next);
        }
        const candidate = path.join(work, `orientation-${id}.3mf`);
        await fs.writeFile(candidate, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), { flag: 'wx' });
        const verified = await readProjectMesh(await openProject(candidate), 0);
        if (verified.objects.length !== 1 || verified.objects[0].soup.pos.length !== item.soup.pos.length || !verified.objects[0].soup.pos.every(Number.isFinite)) throw Error('Rotated geometry verification failed');
        for (let i = 0; i < item.soup.pos.length; i += 3) {
          const expected = rotate(Array.from(item.soup.pos.subarray(i, i + 3)), r);
          if (expected.some((v, a) => Math.abs(v + offset[a] - verified.objects[0].soup.pos[i + a]) > 1e-6)) throw Error('Rotated geometry verification failed');
        }
        const geometry = meshFactsFromRead(verified, { signal: controller.signal });
        record.contact_area_mm2 = geometry.facts['mesh.flat_bottom_area_mm2'] ?? null;
        record.contact_evidence = geometry.evidence['mesh.flat_bottom_area_mm2'];
        const beforeSlice = stopped(); if (beforeSlice) { stop = beforeSlice; continue; }
        slices++; const outcome = await deps.slice(candidate, controller.signal, 0);
        if (deps.signal?.aborted || controller.signal.aborted || now() - started >= minutes * 60000) { stop = deps.signal?.aborted ? 'cancelled' : 'budget_minutes'; continue; }
        const facts = sliceFacts({ ...outcome.slice, gcode: outcome.gcode, plateIndex: 0 });
        record.status = 'measured'; record.time_s = facts.facts['plate.time_s'] ?? null; record.weight_g = facts.facts['plate.weight_g'] ?? null;
        record.support_weight_g = outcome.gcode.facts['gcode.support_weight_g'] ?? null;
        record.gcode_complete = outcome.gcode.complete; record.comparable = outcome.gcode.complete;
        record.evidence = { ...facts.evidence, ...outcome.gcode.evidence }; record.blind = [...facts.blind, ...outcome.gcode.blind];
        record.output_path = path.join(delivered, `orientation-${id}.3mf`);
        await fs.copyFile(candidate, record.output_path, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (deps.signal?.aborted || controller.signal.aborted) { stop = deps.signal?.aborted ? 'cancelled' : 'budget_minutes'; continue; }
        record.status = 'error'; record.error = error instanceof Error ? error.message : String(error);
      }
    }
    const after = hash(await readBoundedPrintFile(args.path)); if (before !== after) throw Error('Source changed during orientation comparison');
    if (deps.signal?.aborted) stop = 'cancelled'; else if (controller.signal.aborted) stop = 'budget_minutes';
    if (stop === 'cancelled' || !records.some(r => r.output_path)) {
      await fs.rm(delivered, { recursive: true, force: true });
      for (const r of records) { delete r.output_path; r.artifacts_removed = true; }
    }
    const winner = (key: string) => {
      const rows = records.filter(r => stop !== 'cancelled' && r.status === 'measured' && r.comparable && typeof r[key] === 'number' && Number.isFinite(r[key]) && r[key] >= 0);
      return rows.length ? rows.reduce((a, b) => a[key] <= b[key] ? a : b).orientation_id : null;
    };
    return { stop_reason: stop, slices, max_slices: max, minutes: (now() - started) / 60000, orientations: records, fastest: winner('time_s'), least_material: winner('weight_g'), least_support: winner('support_weight_g'), source_sha256: { before, after }, notes: ['Rotations are world-space X, then Y, then Z; XY bounding-box center retained and lowest printable vertex placed on Z=0.', 'Candidates are unsliced projects for Bambu Studio review. Painted geometry and modifier resources remain in the project.', 'Contact is a geometric estimate; time/material/support are slicer estimates. Adhesion, surface quality, fit and load-bearing strength require physical testing.'] };
  } catch (error) { await fs.rm(delivered, { recursive: true, force: true }); throw error; }
  finally { clearTimeout(timer); deps.signal?.removeEventListener('abort', abort); await fs.rm(work, { recursive: true, force: true }); }
}
