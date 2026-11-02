import { asArray, meta } from "../knowledge/facts/settings.js";
import { readProjectMesh } from "./mesh-read.js";
/** Objects the stage accepts: past this a hostile or enormous project is refused before anything is packed. */
export const MAX_LAYOUT_OBJECTS = 500;
const EPS = 1e-3; // mm: an object resting exactly on the edge is inside
export const CELL_FACTOR = 1.2;
export class LayoutLimitError extends Error {
}
const strings = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);
function points(list) {
    return list.map(p => /^\s*(-?[\d.]+(?:e-?\d+)?)\s*x\s*(-?[\d.]+(?:e-?\d+)?)\s*$/i.exec(p)).filter((m) => !!m).map(m => [Number(m[1]), Number(m[2])]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}
function bounds(pts) {
    if (pts.length < 3)
        return undefined;
    const r = { x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) };
    return r.x1 > r.x0 && r.y1 > r.y0 ? r : undefined;
}
const area = (r) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
export const intersection = (a, b) => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const valid = (r) => r.x1 - r.x0 > EPS && r.y1 - r.y0 > EPS;
const shift = (r, dx, dy) => ({ x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy });
/** The target printer's plate and nozzle geometry from its project settings; undefined when printable_area is missing or unusable. */
export function geometryFromConfig(config) {
    const bed = bounds(points(strings(config.printable_area)));
    if (!bed)
        return undefined;
    const notes = [];
    const height = Number(config.printable_height);
    if (!Number.isFinite(height) || height <= 0)
        notes.push("printable_height is missing: no height limit was applied");
    const maxZ = Number.isFinite(height) && height > 0 ? height : Infinity;
    const areas = strings(config.extruder_printable_area);
    const heights = strings(config.extruder_printable_height).map(Number);
    const count = Math.max(areas.length, strings(config.nozzle_diameter).length, 1);
    const nozzles = [];
    for (let i = 0; i < count; i++) {
        const pts = areas[i] === undefined ? [] : points(areas[i].split(","));
        const raw = bounds(pts);
        let rect = bed;
        if (raw) {
            rect = intersection(raw, bed);
            // shortcut: a nozzle area that is not an axis-aligned rectangle is approximated by its bounding box; replace with a polygon test when a printer needs it.
            const polygon = pts.reduce((s, p, k) => { const q = pts[(k + 1) % pts.length]; return s + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2;
            if (Math.abs(Math.abs(polygon) - area(raw)) > 1e-6 * Math.max(1, area(raw)))
                notes.push(`extruder ${i + 1}'s printable area is not a rectangle: its bounding box was used`);
        }
        else if (areas[i] !== undefined)
            notes.push(`extruder ${i + 1}'s printable area could not be read: the whole bed was used`);
        const own = heights[i];
        nozzles.push({ rect, height: Number.isFinite(own) && own > 0 ? Math.min(own, maxZ) : maxZ });
    }
    const filamentMap = strings(config.filament_map).map(v => Number(v) - 1).map(n => (Number.isInteger(n) && n >= 0 && n < count ? n : 0));
    const mapMode = typeof config.filament_map_mode === "string" ? config.filament_map_mode : undefined;
    return { bed, height: maxZ, nozzles, filamentMap, strideX: (bed.x1 - bed.x0) * CELL_FACTOR, strideY: (bed.y1 - bed.y0) * CELL_FACTOR, mapMode, notes };
}
export const gridColumns = (plateCount) => Math.max(1, Math.ceil(Math.sqrt(plateCount)));
/** World position of the plate's local 0,0. */
export function plateOrigin(index, plateCount, geo) {
    const cols = gridColumns(plateCount);
    return { x: (index % cols) * geo.strideX, y: -Math.floor(index / cols) * geo.strideY };
}
/** The plate's printable rectangle in world coordinates. */
export function plateRect(index, plateCount, geo) {
    const o = plateOrigin(index, plateCount, geo);
    return shift(geo.bed, o.x, o.y);
}
export function binFor(slots, geo) {
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
export const classKeyOf = (slots, painted) => `${[...slots].sort((a, b) => a - b).join("+")}${painted ? "+paint" : ""}`;
/** Filament slots of an object: each normal part's own extruder, else the object's, else 1. */
function slotsOf(object) {
    const own = Number(meta(object, "extruder") ?? 1);
    const parts = asArray(object?.part).filter(p => (p.subtype ?? "normal_part") === "normal_part");
    const list = parts.length ? parts.map(p => Number(meta(p, "extruder") ?? own)) : [own];
    return [...new Set(list.map(n => (Number.isInteger(n) && n >= 1 ? n : 1)))].sort((a, b) => a - b);
}
function signedVolume(pos, idx) {
    let v = 0;
    for (let i = 0; i < idx.length; i += 3) {
        const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
        v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
    }
    return Math.abs(v / 6);
}
/** Every printable object with its world box and the plates model_settings.config assigns it to. Throws MeshReadError (no geometry...) or LayoutLimitError. */
export async function readLayoutModel(project, plateIndex = null) {
    const read = await readProjectMesh(project, plateIndex);
    if (read.objects.length > MAX_LAYOUT_OBJECTS)
        throw new LayoutLimitError(`the project has ${read.objects.length} objects; the layout stage accepts at most ${MAX_LAYOUT_OBJECTS}`);
    const settings = new Map(asArray(project.modelSettings?.object).map(o => [String(o.id), o]));
    const plateNodes = asArray(project.modelSettings?.plate);
    if (plateNodes.length > MAX_LAYOUT_OBJECTS)
        throw new LayoutLimitError(`the project has ${plateNodes.length} plates; the layout stage accepts at most ${MAX_LAYOUT_OBJECTS}`);
    const plates = plateNodes
        .map(p => ({ id: Number(meta(p, "plater_id")), p }))
        .sort((a, b) => (Number.isFinite(a.id) ? a.id : Infinity) - (Number.isFinite(b.id) ? b.id : Infinity))
        .map(({ p }, index) => ({
        index, locked: String(meta(p, "locked") ?? "false") === "true", name: meta(p, "plater_name") === undefined ? undefined : String(meta(p, "plater_name")),
        keys: asArray(p.model_instance).map(i => `${meta(i, "object_id")}:${meta(i, "instance_id") ?? 0}`),
    }));
    const objects = read.objects.map(o => {
        const pos = o.soup.pos;
        const box = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
        for (let k = 0; k < pos.length; k += 3) {
            box.x0 = Math.min(box.x0, pos[k]);
            box.x1 = Math.max(box.x1, pos[k]);
            box.y0 = Math.min(box.y0, pos[k + 1]);
            box.y1 = Math.max(box.y1, pos[k + 1]);
            box.z0 = Math.min(box.z0, pos[k + 2]);
            box.z1 = Math.max(box.z1, pos[k + 2]);
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
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const inside = (b, r) => b.x0 >= r.x0 - EPS && b.y0 >= r.y0 - EPS && b.x1 <= r.x1 + EPS && b.y1 <= r.y1 + EPS;
const touches = (b, r) => b.x1 > r.x0 + EPS && b.x0 < r.x1 - EPS && b.y1 > r.y0 + EPS && b.y0 < r.y1 - EPS;
/** Edge-to-edge distance of two boxes in XY; negative when they intersect (minus the smaller overlap). */
export function gapBetween(a, b) {
    return Math.max(b.x0 - a.x1, a.x0 - b.x1, b.y0 - a.y1, a.y0 - b.y1);
}
export function analyzeLayout(model, geo, opts) {
    const issues = [];
    const count = model.plates.length;
    const byKey = new Map(model.objects.map(o => [o.key, o]));
    const rects = model.plates.map(p => plateRect(p.index, count, geo));
    const stats = [];
    const bedArea = area(geo.bed);
    for (const o of model.objects) {
        if (o.plates.length !== 1)
            issues.push({
                kind: "plate_assignment", severity: "error", objects: [o.name], evidence: { instance: o.key, plates: o.plates.map(p => p + 1) },
                text: o.plates.length === 0 ? `${o.name} is on no plate.` : `${o.name} is listed on ${o.plates.length} plates (${o.plates.map(p => p + 1).join(", ")}).`, fix: "Assign it to exactly one plate.",
            });
    }
    for (const plate of model.plates) {
        const here = plate.keys.map(k => byKey.get(k)).filter((o) => !!o);
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
                }
                else if (others.length === 1 && inside(b, rects[others[0].index])) {
                    issues.push({ kind: "outside_plate", severity: "error", plate: n, objects: [o.name], evidence: { ...common, ...size, standing_on_plate: others[0].index + 1 }, text: `${o.name} belongs to plate ${n} but stands on plate ${others[0].index + 1}.`, fix: "Move it onto its own plate." });
                }
                else if (others.length >= 1) {
                    issues.push({ kind: "between_plates", severity: "error", plate: n, objects: [o.name], evidence: { ...common, ...size, touches_plates: others.map(q => q.index + 1) }, text: `${o.name} (plate ${n}) stands between plates ${others.map(q => q.index + 1).join(", ")}.`, fix: "Move it fully inside its plate." });
                }
                else {
                    issues.push({ kind: "outside_plate", severity: "error", plate: n, objects: [o.name], evidence: { ...common, ...size, standing_on_plate: null }, text: `${o.name} (plate ${n}) is outside every plate.`, fix: "Move it onto its plate." });
                }
            }
            else if (!inside(b, shift(bin.rect, rects[plate.index].x0 - geo.bed.x0, rects[plate.index].y0 - geo.bed.y0))) {
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
export function bedChange(source, geo) {
    const from = source && bounds(points(strings(source.printable_area)));
    if (!from)
        return undefined;
    const [sw, sd, tw, td] = [from.x1 - from.x0, from.y1 - from.y0, geo.bed.x1 - geo.bed.x0, geo.bed.y1 - geo.bed.y0];
    if (Math.abs(sw - tw) < EPS && Math.abs(sd - td) < EPS)
        return undefined;
    return {
        kind: "bed_changed", severity: sw > tw || sd > td ? "warning" : "info", objects: [],
        evidence: { source_bed_mm: [sw, sd], target_bed_mm: [tw, td], source_printer: typeof source.printer_settings_id === "string" ? source.printer_settings_id : null },
        text: `The source printer's bed (${sw}x${sd} mm) is ${sw > tw || sd > td ? "larger" : "different"} than the target's (${tw}x${td} mm): the plate grid changes, so objects keep their old world coordinates but not their old plates.`,
        fix: "The layout stage re-places every object on the target's plates (layout: auto).",
    };
}
