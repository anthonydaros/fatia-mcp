// Layout analysis: where every object of a project stands against the TARGET printer's plates. Pure: it reads the meshes through
// readProjectMesh (world coordinates, build-item transforms applied) and the plates of model_settings.config, and reports what is wrong with
// evidence. Planning is layout-plan.ts, the file edit is layout-writer.ts, the stage that drives them is layout-stage.ts.
//
// The plate grid is Studio's own (measured on the 17-plate H2D sample and on Studio's CLI output): plate i has col = i % cols, row = floor(i / cols),
// cols = ceil(sqrt(plateCount)); the cell is the bed size times 1.2; the plate's origin (where the bed's local 0,0 lies) is (col * cellX, -row * cellY).
// An object is on the plate it is assigned to in model_settings.config AND must stand inside that plate's rectangle in world coordinates.
import type { ProjectFiles } from "../knowledge/types.js";
import { asArray, meta } from "../knowledge/facts/settings.js";
import { readProjectMesh } from "./mesh-read.js";

/** Objects the stage accepts: past this a hostile or enormous project is refused before anything is packed. */
export const MAX_LAYOUT_OBJECTS = 500;
const EPS = 1e-3; // mm: an object resting exactly on the edge is inside
export const CELL_FACTOR = 1.2;

export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface Box extends Rect { z0: number; z1: number }
/** What one nozzle can reach, in the plate's local coordinates. */
export interface Nozzle { rect: Rect; height: number }
export interface BedGeometry {
  /** printable_area as a rectangle, local coordinates (a bed that is not a rectangle is approximated by its bounding box: see notes). */
  bed: Rect;
  height: number;
  /** One entry per nozzle (extruder_printable_area / extruder_printable_height). */
  nozzles: Nozzle[];
  /** Filament slot (0-based) -> nozzle (0-based), from filament_map; a missing entry means nozzle 0. */
  filamentMap: number[];
  strideX: number;
  strideY: number;
  /** filament_map_mode of the project: "Auto ..." means the slicer may regroup the filaments itself. */
  mapMode: string | undefined;
  notes: string[];
}

export class LayoutLimitError extends Error {}

type Config = Record<string, unknown>;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

function points(list: string[]): Array<[number, number]> {
  return list.map(p => /^\s*(-?[\d.]+(?:e-?\d+)?)\s*x\s*(-?[\d.]+(?:e-?\d+)?)\s*$/i.exec(p)).filter((m): m is RegExpExecArray => !!m).map(m => [Number(m[1]), Number(m[2])] as [number, number]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}
function bounds(pts: Array<[number, number]>): Rect | undefined {
  if (pts.length < 3) return undefined;
  const r = { x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : undefined;
}
const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
export const intersection = (a: Rect, b: Rect): Rect => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const valid = (r: Rect) => r.x1 - r.x0 > EPS && r.y1 - r.y0 > EPS;
const shift = (r: Rect, dx: number, dy: number): Rect => ({ x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy });

/** The target printer's plate and nozzle geometry from its project settings; undefined when printable_area is missing or unusable. */
export function geometryFromConfig(config: Config): BedGeometry | undefined {
  const bed = bounds(points(strings(config.printable_area)));
  if (!bed) return undefined;
  const notes: string[] = [];
  const height = Number(config.printable_height);
  if (!Number.isFinite(height) || height <= 0) notes.push("printable_height is missing: no height limit was applied");
  const maxZ = Number.isFinite(height) && height > 0 ? height : Infinity;
  const areas = strings(config.extruder_printable_area);
  const heights = strings(config.extruder_printable_height).map(Number);
  const count = Math.max(areas.length, strings(config.nozzle_diameter).length, 1);
  const nozzles: Nozzle[] = [];
  for (let i = 0; i < count; i++) {
    const pts = areas[i] === undefined ? [] : points(areas[i].split(","));
    const raw = bounds(pts);
    let rect = bed;
    if (raw) {
      rect = intersection(raw, bed);
      // shortcut: a nozzle area that is not an axis-aligned rectangle is approximated by its bounding box; replace with a polygon test when a printer needs it.
      const polygon = pts.reduce((s, p, k) => { const q = pts[(k + 1) % pts.length]; return s + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2;
      if (Math.abs(Math.abs(polygon) - area(raw)) > 1e-6 * Math.max(1, area(raw))) notes.push(`extruder ${i + 1}'s printable area is not a rectangle: its bounding box was used`);
    } else if (areas[i] !== undefined) notes.push(`extruder ${i + 1}'s printable area could not be read: the whole bed was used`);
    const own = heights[i];
    nozzles.push({ rect, height: Number.isFinite(own) && own > 0 ? Math.min(own, maxZ) : maxZ });
  }
  const filamentMap = strings(config.filament_map).map(v => Number(v) - 1).map(n => (Number.isInteger(n) && n >= 0 && n < count ? n : 0));
  const mapMode = typeof config.filament_map_mode === "string" ? config.filament_map_mode : undefined;
  return { bed, height: maxZ, nozzles, filamentMap, strideX: (bed.x1 - bed.x0) * CELL_FACTOR, strideY: (bed.y1 - bed.y0) * CELL_FACTOR, mapMode, notes };
}

export const gridColumns = (plateCount: number): number => Math.max(1, Math.ceil(Math.sqrt(plateCount)));
/** World position of the plate's local 0,0. */
export function plateOrigin(index: number, plateCount: number, geo: BedGeometry): { x: number; y: number } {
  const cols = gridColumns(plateCount);
  return { x: (index % cols) * geo.strideX, y: -Math.floor(index / cols) * geo.strideY };
}
/** The plate's printable rectangle in world coordinates. */
export function plateRect(index: number, plateCount: number, geo: BedGeometry): Rect {
  const o = plateOrigin(index, plateCount, geo);
  return shift(geo.bed, o.x, o.y);
}

/** Where a set of filament slots can print, in local coordinates: the area every nozzle they map to can reach, and the lowest of their height limits. */
export interface Bin { rect: Rect; height: number; nozzles: number[] }
export function binFor(slots: number[], geo: BedGeometry): Bin {
  const nozzles = [...new Set(slots.map(s => geo.filamentMap[s - 1] ?? 0))].sort((a, b) => a - b);
  let rect = geo.bed;
  let height = geo.height;
  for (const n of nozzles) {
    const z = geo.nozzles[n] ?? geo.nozzles[0];
    rect = intersection(rect, z.rect);
    height = Math.min(height, z.height);
  }
  return { rect, height, nozzles };
}

/* ---------------------------------- the project's objects ---------------------------------- */

export interface LayoutObject {
  /** "objectId:instance", the key model_settings.config's model_instance uses. */
  key: string;
  objectId: string;
  instance: number;
  /** Position among the build items (the order of the `<item>` tags). */
  itemIndex: number;
  name: string;
  /** Filament slots (1-based) the object prints with. */
  slots: number[];
  painted: boolean;
  /** Colour class: the slots it uses, plus "+paint" for a painted object. Two classes never share a plate. */
  classKey: string;
  box: Box;
  volume_mm3: number;
  /** 0-based plates that list the instance (exactly one in a sound project). */
  plates: number[];
}
export interface LayoutPlate { index: number; locked: boolean; name: string | undefined; keys: string[] }
export interface LayoutModel { objects: LayoutObject[]; plates: LayoutPlate[]; /** Plate instances with no printable mesh (a non-printable item, an empty object). */ unplaced: string[] }

export const classKeyOf = (slots: number[], painted: boolean): string => `${[...slots].sort((a, b) => a - b).join("+")}${painted ? "+paint" : ""}`;

/** Filament slots of an object: each normal part's own extruder, else the object's, else 1. */
function slotsOf(object: any): number[] {
  const own = Number(meta(object, "extruder") ?? 1);
  const parts = asArray(object?.part).filter(p => (p.subtype ?? "normal_part") === "normal_part");
  const list = parts.length ? parts.map(p => Number(meta(p, "extruder") ?? own)) : [own];
  return [...new Set(list.map(n => (Number.isInteger(n) && n >= 1 ? n : 1)))].sort((a, b) => a - b);
}

function signedVolume(pos: Float64Array, idx: Uint32Array): number {
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
    v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return Math.abs(v / 6);
}

/** Every printable object with its world box and the plates model_settings.config assigns it to. Throws MeshReadError (no geometry...) or LayoutLimitError. */
export async function readLayoutModel(project: ProjectFiles, plateIndex: number | null = null): Promise<LayoutModel> {
  const read = await readProjectMesh(project, plateIndex);
  if (read.objects.length > MAX_LAYOUT_OBJECTS) throw new LayoutLimitError(`the project has ${read.objects.length} objects; the layout stage accepts at most ${MAX_LAYOUT_OBJECTS}`);
  const settings = new Map(asArray(project.modelSettings?.object).map(o => [String(o.id), o]));
  const plateNodes = asArray(project.modelSettings?.plate);
  if (plateNodes.length > MAX_LAYOUT_OBJECTS) throw new LayoutLimitError(`the project has ${plateNodes.length} plates; the layout stage accepts at most ${MAX_LAYOUT_OBJECTS}`);
  const plates: LayoutPlate[] = plateNodes
    .map(p => ({ id: Number(meta(p, "plater_id")), p }))
    .sort((a, b) => (Number.isFinite(a.id) ? a.id : Infinity) - (Number.isFinite(b.id) ? b.id : Infinity))
    .map(({ p }, index) => ({
      index, locked: String(meta(p, "locked") ?? "false") === "true", name: meta(p, "plater_name") === undefined ? undefined : String(meta(p, "plater_name")),
      keys: asArray(p.model_instance).map(i => `${meta(i, "object_id")}:${meta(i, "instance_id") ?? 0}`),
    }));
  const objects: LayoutObject[] = read.objects.map(o => {
    const pos = o.soup.pos;
    const box = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
    for (let k = 0; k < pos.length; k += 3) {
      box.x0 = Math.min(box.x0, pos[k]); box.x1 = Math.max(box.x1, pos[k]);
      box.y0 = Math.min(box.y0, pos[k + 1]); box.y1 = Math.max(box.y1, pos[k + 1]);
      box.z0 = Math.min(box.z0, pos[k + 2]); box.z1 = Math.max(box.z1, pos[k + 2]);
    }
    const key = `${o.objectId}:${o.instance ?? 0}`;
    const slots = slotsOf(settings.get(o.objectId ?? ""));
    return {
      key, objectId: o.objectId ?? "", instance: o.instance ?? 0, itemIndex: o.itemIndex ?? -1, name: o.name, slots, painted: !!o.painted, classKey: classKeyOf(slots, !!o.painted),
      box, volume_mm3: signedVolume(pos, o.soup.idx), plates: plates.filter(p => p.keys.includes(key)).map(p => p.index),
    };
  });
  const printable = new Set(objects.map(o => o.key));
  return { objects, plates, unplaced: plates.flatMap(p => p.keys).filter(k => !printable.has(k)) };
}

/* ---------------------------------- analysis ---------------------------------- */

export type IssueKind = "outside_plate" | "straddling" | "between_plates" | "outside_nozzle_area" | "overlap" | "too_tall" | "bed_changed" | "locked_plate" | "plate_assignment" | "blocker";
export interface LayoutIssue {
  kind: IssueKind;
  /** error: the project cannot print as it is; warning: it can but should not; info: nothing is wrong yet. */
  severity: "error" | "warning" | "info";
  /** 1-based plate, when the issue belongs to one. */
  plate?: number;
  objects: string[];
  evidence: Record<string, unknown>;
  text: string;
  fix: string;
}
export interface PlateStat {
  /** 1-based. */
  plate: number;
  locked: boolean;
  objects: string[];
  classes: string[];
  footprint_mm2: number;
  bed_mm2: number;
  /** Sum of the objects' bounding-box areas over the plate's area: an upper bound of what the footprints cover. */
  utilisation: number;
}
export interface LayoutAnalysis { issues: LayoutIssue[]; plates: PlateStat[]; clean: boolean }
export interface AnalysisOptions {
  /** Edge-to-edge distance under which two neighbours count as overlapping. */
  minGapMm: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const inside = (b: Rect, r: Rect) => b.x0 >= r.x0 - EPS && b.y0 >= r.y0 - EPS && b.x1 <= r.x1 + EPS && b.y1 <= r.y1 + EPS;
const touches = (b: Rect, r: Rect) => b.x1 > r.x0 + EPS && b.x0 < r.x1 - EPS && b.y1 > r.y0 + EPS && b.y0 < r.y1 - EPS;
/** Edge-to-edge distance of two boxes in XY; negative when they intersect (minus the smaller overlap). */
export function gapBetween(a: Rect, b: Rect): number {
  return Math.max(b.x0 - a.x1, a.x0 - b.x1, b.y0 - a.y1, a.y0 - b.y1);
}

export function analyzeLayout(model: LayoutModel, geo: BedGeometry, opts: AnalysisOptions): LayoutAnalysis {
  const issues: LayoutIssue[] = [];
  const count = model.plates.length;
  const byKey = new Map(model.objects.map(o => [o.key, o]));
  const rects = model.plates.map(p => plateRect(p.index, count, geo));
  const stats: PlateStat[] = [];
  const bedArea = area(geo.bed);

  for (const o of model.objects) {
    if (o.plates.length !== 1) issues.push({
      kind: "plate_assignment", severity: "error", objects: [o.name], evidence: { instance: o.key, plates: o.plates.map(p => p + 1) },
      text: o.plates.length === 0 ? `${o.name} is on no plate.` : `${o.name} is listed on ${o.plates.length} plates (${o.plates.map(p => p + 1).join(", ")}).`, fix: "Assign it to exactly one plate.",
    });
  }
  for (const plate of model.plates) {
    const here = plate.keys.map(k => byKey.get(k)).filter((o): o is LayoutObject => !!o);
    const rect = rects[plate.index];
    const n = plate.index + 1;
    stats.push({
      plate: n, locked: plate.locked, objects: here.map(o => o.name), classes: [...new Set(here.map(o => o.classKey))],
      footprint_mm2: r1(here.reduce((s, o) => s + (o.box.x1 - o.box.x0) * (o.box.y1 - o.box.y0), 0)), bed_mm2: r1(bedArea),
      utilisation: r2(here.reduce((s, o) => s + (o.box.x1 - o.box.x0) * (o.box.y1 - o.box.y0), 0) / bedArea),
    });
    if (plate.locked) {
      issues.push({ kind: "locked_plate", severity: "warning", plate: n, objects: here.map(o => o.name), evidence: { plate: n, objects: here.length }, text: `Plate ${n} is locked: its objects are never moved.`, fix: "Unlock the plate in Bambu Studio if it should be arranged." });
      continue;
    }
    for (const o of here) {
      const b = o.box;
      const size = { width_mm: r1(b.x1 - b.x0), depth_mm: r1(b.y1 - b.y0), height_mm: r1(b.z1) };
      const bin = binFor(o.slots, geo);
      if (!inside(b, rect)) {
        const others = model.plates.filter(q => q.index !== plate.index && touches(b, rects[q.index]));
        const edges = { left_mm: r1(Math.max(0, rect.x0 - b.x0)), right_mm: r1(Math.max(0, b.x1 - rect.x1)), bottom_mm: r1(Math.max(0, rect.y0 - b.y0)), top_mm: r1(Math.max(0, b.y1 - rect.y1)) };
        const common = { plate: n, box: { x: [r1(b.x0), r1(b.x1)], y: [r1(b.y0), r1(b.y1)] }, plate_rect: { x: [r1(rect.x0), r1(rect.x1)], y: [r1(rect.y0), r1(rect.y1)] } };
        if (touches(b, rect)) {
          issues.push({ kind: "straddling", severity: "error", plate: n, objects: [o.name], evidence: { ...common, ...size, beyond: edges, also_touches_plates: others.map(q => q.index + 1) }, text: `${o.name} sticks out of plate ${n}${others.length ? ` and reaches plate ${others.map(q => q.index + 1).join(", ")}` : ""}.`, fix: "Move it fully inside its plate." });
        } else if (others.length === 1 && inside(b, rects[others[0].index])) {
          issues.push({ kind: "outside_plate", severity: "error", plate: n, objects: [o.name], evidence: { ...common, ...size, standing_on_plate: others[0].index + 1 }, text: `${o.name} belongs to plate ${n} but stands on plate ${others[0].index + 1}.`, fix: "Move it onto its own plate." });
        } else if (others.length >= 1) {
          issues.push({ kind: "between_plates", severity: "error", plate: n, objects: [o.name], evidence: { ...common, ...size, touches_plates: others.map(q => q.index + 1) }, text: `${o.name} (plate ${n}) stands between plates ${others.map(q => q.index + 1).join(", ")}.`, fix: "Move it fully inside its plate." });
        } else {
          issues.push({ kind: "outside_plate", severity: "error", plate: n, objects: [o.name], evidence: { ...common, ...size, standing_on_plate: null }, text: `${o.name} (plate ${n}) is outside every plate.`, fix: "Move it onto its plate." });
        }
      } else if (!inside(b, shift(bin.rect, rects[plate.index].x0 - geo.bed.x0, rects[plate.index].y0 - geo.bed.y0))) {
        issues.push({ kind: "outside_nozzle_area", severity: "error", plate: n, objects: [o.name], evidence: { plate: n, slots: o.slots, nozzles: bin.nozzles.map(z => z + 1), reachable_local_x: [r1(bin.rect.x0), r1(bin.rect.x1)], reachable_local_y: [r1(bin.rect.y0), r1(bin.rect.y1)], ...size }, text: `${o.name} is outside the area its nozzle${bin.nozzles.length > 1 ? "s" : ""} (${bin.nozzles.map(z => z + 1).join(", ")}) can reach.`, fix: "Move it inside the reachable area." });
      }
      if (b.z1 > bin.height + EPS) {
        issues.push({ kind: "too_tall", severity: "error", plate: n, objects: [o.name], evidence: { height_mm: r1(b.z1), limit_mm: bin.height, nozzles: bin.nozzles.map(z => z + 1) }, text: `${o.name} is ${r1(b.z1)} mm tall; the limit is ${bin.height} mm.`, fix: "It does not fit this printer in this orientation; nothing the layout can change." });
      }
    }
    for (let i = 0; i < here.length; i++) {
      for (let j = i + 1; j < here.length; j++) {
        const gap = gapBetween(here[i].box, here[j].box);
        if (gap < opts.minGapMm - EPS) {
          issues.push({
            kind: "overlap", severity: "error", plate: n, objects: [here[i].name, here[j].name], evidence: { plate: n, gap_mm: r1(gap), minimum_mm: opts.minGapMm },
            text: `${here[i].name} and ${here[j].name} (plate ${n}) ${gap < 0 ? "overlap" : `are ${r1(gap)} mm apart`}; the minimum is ${opts.minGapMm} mm.`, fix: "Move them apart.",
          });
        }
      }
    }
  }
  return { issues, plates: stats, clean: issues.length === 0 };
}

/** The bed of the project's author against the target's; undefined when they are the same size or the source is unknown. */
export function bedChange(source: Config | undefined, geo: BedGeometry): LayoutIssue | undefined {
  const from = source && bounds(points(strings(source.printable_area)));
  if (!from) return undefined;
  const [sw, sd, tw, td] = [from.x1 - from.x0, from.y1 - from.y0, geo.bed.x1 - geo.bed.x0, geo.bed.y1 - geo.bed.y0];
  if (Math.abs(sw - tw) < EPS && Math.abs(sd - td) < EPS) return undefined;
  return {
    kind: "bed_changed", severity: sw > tw || sd > td ? "warning" : "info", objects: [],
    evidence: { source_bed_mm: [sw, sd], target_bed_mm: [tw, td], source_printer: typeof source!.printer_settings_id === "string" ? source!.printer_settings_id : null },
    text: `The source printer's bed (${sw}x${sd} mm) is ${sw > tw || sd > td ? "larger" : "different"} than the target's (${tw}x${td} mm): the plate grid changes, so objects keep their old world coordinates but not their old plates.`,
    fix: "The layout stage re-places every object on the target's plates (layout: auto).",
  };
}
