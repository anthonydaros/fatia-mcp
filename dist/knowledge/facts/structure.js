// Tier-2 facts: the printer being targeted, the box and triangle count of the objects on one plate, and the project
// flags that a 3MF's structure alone decides. Mesh analysis and G-code are other tiers. A key the guide has not
// confirmed on a real X2D is never guessed: its fact stays unknown and the rules that need it are reported as unchecked.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { MACHINE_LIMITS, normalizeModel } from "../../safety/limits.js";
import { asArray, meta, plateInstances, targetName } from "./settings.js";
/** Facts whose 3MF key the guide marks "a confirmar numa X2D real". */
export const UNCONFIRMED_FACTS = new Set([
    "project.nozzle2_used", "object.uses_aux_nozzle", "project.ams_type", "project.has_cut_objects", "project.aux_nozzle_filament_types",
]);
/** A verdict fact is easier to trust next to the numbers behind it; preflight adds these to a finding's evidence. */
export const EVIDENCE_ALSO = {
    "mesh.exceeds_build_volume": ["mesh.size_x_mm", "mesh.size_y_mm", "mesh.height_mm", "printer.build_volume_mm"],
};
/** The filament "Setting Overrides": filament_* keys that hold "nil" for "not overridden" (13 keys in Studio 02.07 and 02.08 projects). */
const FILAMENT_OVERRIDES = [
    "filament_deretraction_speed", "filament_long_retractions_when_cut", "filament_retract_before_wipe", "filament_retract_restart_extra",
    "filament_retract_when_changing_layer", "filament_retraction_distances_when_cut", "filament_retraction_length", "filament_retraction_minimum_travel",
    "filament_retraction_speed", "filament_wipe", "filament_wipe_distance", "filament_z_hop", "filament_z_hop_types",
];
/** Object and part metadata that is not a setting override (everything else under <metadata key=...> is a config key). */
const NOT_OVERRIDES = new Set([
    "name", "extruder", "matrix", "source_file", "source_object_id", "source_volume_id", "source_offset_x", "source_offset_y", "source_offset_z", "source_in_inches", "source_in_meters",
]);
const VARIABLE_LAYER_FILES = ["Metadata/layer_heights_profile.txt", "Metadata/layer_config_ranges.xml"];
const has = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
const round = (n) => Math.round(n * 1000) / 1000;
const finite = (...n) => n.every(Number.isFinite);
const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : undefined);
/** Width and depth of the printable_area polygon ("0x0", "350x0", ...). */
function areaSize(area) {
    const points = list(area)?.map(p => /^(-?\d+(?:\.\d+)?)x(-?\d+(?:\.\d+)?)$/.exec(String(p)));
    if (!points || points.length < 3 || points.some(p => !p))
        return undefined;
    const side = (i) => { const v = points.map(p => Number(p[i])); return Math.max(...v) - Math.min(...v); };
    return [side(1), side(2)];
}
/** x, y, z of the printer being targeted: the file's own profile when it was saved for that printer, else the hardware table. */
function buildVolume(ctx) {
    const config = ctx.project?.config;
    const model = normalizeModel(ctx.targetPrinter);
    if (config && model && normalizeModel(config.printer_model) === model) {
        const [size, z] = [areaSize(config.printable_area), Number(config.printable_height)];
        if (size && z > 0 && finite(...size, z))
            return [...size, z];
    }
    const table = model ? MACHINE_LIMITS[model].volume : undefined;
    return table?.length === 3 ? [table[0], table[1], table[2]] : undefined;
}
/**
 * Whether a box fits in the volume with any face down and the footprint turned about Z (Carver's test for a
 * rectangle inside a rectangle). shortcut: the box of the part, not its shape and never tilted, so a mesh that only
 * fits tilted counts as not fitting; refine when mesh analysis exists.
 */
export function fitsVolume(size, volume) {
    const [a, b] = volume[0] >= volume[1] ? [volume[0], volume[1]] : [volume[1], volume[0]];
    return [0, 1, 2].some(down => {
        if (size[down] > volume[2])
            return false;
        const [p, q] = size.filter((_, i) => i !== down).sort((m, n) => n - m);
        return q <= b && (p <= a || ((a + b) / (p + q)) ** 2 + ((a - b) / (p - q)) ** 2 >= 2);
    });
}
/** Bounding box and triangle count of a Wavefront OBJ, read line by line; units are taken as millimetres. */
async function readObj(file) {
    const [lo, hi] = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
    let triangles = 0;
    const input = fs.createReadStream(file);
    try {
        for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
            if (line.length > 4096)
                return undefined; // no real OBJ line is this long; splitting one huge line would exhaust memory
            if (line.startsWith("v ")) {
                const v = line.trim().split(/\s+/).slice(1, 4).map(Number);
                if (v.length === 3 && finite(...v))
                    v.forEach((n, i) => { lo[i] = Math.min(lo[i], n); hi[i] = Math.max(hi[i], n); });
            }
            else if (line.startsWith("f ")) {
                triangles += Math.max(0, line.trim().split(/\s+/).length - 3); // a face with n corners is n-2 triangles
            }
        }
    }
    finally {
        input.destroy();
    }
    return finite(...lo, ...hi) ? [{ x: hi[0] - lo[0], y: hi[1] - lo[1], z: hi[2] - lo[2], triangles }] : undefined;
}
/**
 * The printable build items of the chosen plate, each with the union of its meshes. A 3MF without geometry (the GUI's
 * G-code export) gives nothing: plate_N.json holds only the first-layer footprint, which is not a bounding box.
 */
async function objectsOnPlate(ctx) {
    const ext = path.extname(ctx.filePath).toLowerCase();
    try {
        if (ctx.kind === "mesh") {
            if (ext === ".obj")
                return await readObj(ctx.filePath);
            if (ext !== ".stl")
                return undefined;
            const info = await ctx.meshInfo(ctx.filePath);
            const d = info.boundingBox.dimensions;
            return finite(d.x, d.y, d.z) ? [{ x: d.x, y: d.y, z: d.z, triangles: info.faceCount }] : undefined;
        }
        if (ctx.kind !== "3mf")
            return undefined;
    }
    catch {
        return undefined;
    }
    const modelSettings = ctx.project?.modelSettings;
    const hasPlates = asArray(modelSettings?.plate).length > 0;
    const onPlate = hasPlates ? plateInstances(modelSettings, ctx.plateIndex) : undefined;
    if (hasPlates && !onPlate)
        return undefined;
    try {
        const info = await ctx.meshInfo(ctx.filePath);
        const parts = new Map();
        for (const part of info.objects ?? [])
            parts.set(part.item, [...(parts.get(part.item) ?? []), part]);
        const seen = new Map();
        const objects = [];
        (info.items ?? []).forEach((item, index) => {
            // instance_id counts the build items of the same object in order.
            const instance = seen.get(item.objectId) ?? 0;
            seen.set(item.objectId, instance + 1);
            if (!item.printable || (onPlate && !onPlate.includes(`${item.objectId}:${instance}`)))
                return;
            // Studio sizes and bed-checks an object from its model parts only: modifier, negative and support volumes are not part of the box.
            const notModel = new Set(asArray(modelSettings?.object).filter(o => String(o.id) === item.objectId).flatMap(o => asArray(o.part))
                .filter(p => (p.subtype ?? "normal_part") !== "normal_part").map(p => String(p.id)));
            const meshes = (parts.get(index) ?? []).filter(m => !notModel.has(m.objectId));
            const [lo, hi] = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
            for (const { boundingBox: { min, max } } of meshes)
                ["x", "y", "z"].forEach((axis, i) => { lo[i] = Math.min(lo[i], min[axis]); hi[i] = Math.max(hi[i], max[axis]); });
            if (meshes.length && finite(...lo, ...hi))
                objects.push({ x: hi[0] - lo[0], y: hi[1] - lo[1], z: hi[2] - lo[2], triangles: meshes.reduce((n, m) => n + m.faceCount, 0) });
        });
        return objects;
    }
    catch {
        return undefined; // no mesh data, or a malformed model
    }
}
const maxOf = (objects, f) => (objects.length ? round(Math.max(...objects.map(f))) : undefined);
/** Object nodes of model_settings.config on the chosen plate; undefined when the file keeps plates but no objects (a GUI-sliced file). */
function plateObjects(project, plateIndex) {
    const instances = plateInstances(project.modelSettings, plateIndex);
    if (!instances)
        return undefined;
    const ids = new Set(instances.map(i => i.slice(0, i.lastIndexOf(":"))));
    const nodes = asArray(project.modelSettings.object).filter(o => ids.has(String(o.id)));
    return nodes.length ? nodes : undefined;
}
const overrides = (node) => asArray(node?.metadata).flatMap(m => (typeof m?.key === "string" && !NOT_OVERRIDES.has(m.key) ? [m.key] : []));
function layerHeightsDiffer(project, plateIndex) {
    const nodes = plateObjects(project, plateIndex);
    if (!nodes)
        return undefined;
    const own = nodes.map(o => meta(o, "layer_height"));
    const base = project.config?.layer_height;
    const heights = own.map(h => h ?? base).filter(h => h !== undefined).map(Number);
    const mixed = own.some(h => h !== undefined) && own.some(h => h === undefined) && base === undefined; // a default we cannot read
    if (heights.some(Number.isNaN))
        return undefined;
    if (new Set(heights).size > 1)
        return true;
    // shortcut: variable layer height profiles and height ranges are not read; when the file has them and no override differs, the answer is unknown.
    return mixed || VARIABLE_LAYER_FILES.some(n => project.names?.includes(n)) ? undefined : false;
}
async function thirdParty(ctx, project) {
    const saved = normalizeModel(project.config?.printer_model);
    if (saved !== undefined && saved !== ctx.targetPrinter)
        return true; // made for another printer
    // Downloaded projects name their designer or origin; the user's own saves leave both empty (their account id is there either way).
    const head = (await project.read?.("3D/3dmodel.model", 65536))?.toString("utf8");
    if (head === undefined)
        return undefined;
    return [...head.matchAll(/<metadata\s+name="(?:Designer|Origin)"\s*>([^<]*)</g)].some(m => m[1].trim() !== "");
}
async function hasPaint(project) {
    let geometry = false;
    for (const name of project.names ?? []) {
        if (!/^3D\/.*\.model$/i.test(name))
            continue;
        const bytes = await project.read?.(name); // searched as bytes: a big mesh is never turned into a string
        if (bytes?.includes(' paint_color="'))
            return true; // Studio's colour painting; support and seam painting use other attributes
        geometry || (geometry = !!bytes?.includes("<triangle"));
    }
    return geometry ? false : undefined; // a GUI-sliced 3MF carries no geometry, so nothing can be said about paint
}
const BOX = {
    "mesh.size_x_mm": s => maxOf(s.objects ?? [], o => o.x),
    "mesh.size_y_mm": s => maxOf(s.objects ?? [], o => o.y),
    "mesh.height_mm": s => maxOf(s.objects ?? [], o => o.z),
    "mesh.max_object_height_mm": s => maxOf(s.objects ?? [], o => o.z),
    "mesh.bbox_max_dim_mm": s => maxOf(s.objects ?? [], o => Math.max(o.x, o.y, o.z)),
    // Across a plate: the smallest footprint and the tallest-for-its-base object, the two a rule about fragile parts cares for.
    "mesh.footprint_area_mm2": s => (s.objects?.length ? round(Math.min(...s.objects.map(o => o.x * o.y))) : undefined),
    "mesh.height_to_footprint": s => maxOf((s.objects ?? []).filter(o => o.x * o.y > 0), o => o.z / Math.sqrt(o.x * o.y)),
    "mesh.triangle_count": s => (s.objects?.length ? s.objects.reduce((n, o) => n + o.triangles, 0) : undefined),
    "mesh.exceeds_build_volume": s => (s.volume && s.objects?.length ? s.objects.some(o => !fitsVolume([round(o.x), round(o.y), round(o.z)], s.volume)) : undefined),
    // The tallest object plus the largest Z hop of the project: the nozzle must clear that height.
    "object.height_plus_zhop_mm": s => {
        const hop = list(s.config?.z_hop)?.map(Number);
        const height = maxOf(s.objects ?? [], o => o.z);
        return hop?.length && height !== undefined && finite(...hop) ? round(height + Math.max(...hop)) : undefined;
    },
};
const DERIVED = {
    ...BOX,
    "printer.model": s => targetName(s.ctx.targetPrinter),
    "printer.bed_size_mm": s => s.volume && Math.max(s.volume[0], s.volume[1]),
    "printer.build_volume_mm": s => s.volume && [...s.volume],
    "project.has_per_object_overrides": s => {
        const nodes = s.project && plateObjects(s.project, s.ctx.plateIndex);
        return nodes ? nodes.some(o => overrides(o).length > 0 || asArray(o.part).some(p => overrides(p).length > 0)) : undefined;
    },
    "project.layer_heights_differ": s => s.project && layerHeightsDiffer(s.project, s.ctx.plateIndex),
    "project.filament_override_count": s => {
        const present = s.config ? FILAMENT_OVERRIDES.filter(k => list(s.config[k])) : [];
        return present.length ? present.filter(k => list(s.config[k]).some(v => v !== "nil")).length : undefined;
    },
    // shortcut: a preset name without "@BBL" is a user preset; a user copy that keeps the suffix is missed.
    "project.custom_filament_profile": s => list(s.config?.filament_settings_id)?.some(n => !/@BBL/i.test(String(n))),
    "project.is_third_party": s => s.project && thirdParty(s.ctx, s.project),
    "project.has_painted_colors": s => s.project && hasPaint(s.project),
};
export const structureProvider = {
    tier: 2,
    needs: [], // printer and mesh facts exist without a 3MF; the project flags are skipped when there is none
    provides: name => has(DERIVED, name),
    async collect(ctx, wanted) {
        const facts = {};
        const scope = { ctx, project: ctx.project, config: ctx.project?.config, volume: buildVolume(ctx) };
        if (wanted.some(n => has(BOX, n)))
            scope.objects = await objectsOnPlate(ctx);
        for (const name of wanted) {
            try {
                const value = await DERIVED[name](scope);
                if (value !== undefined)
                    facts[name] = value;
            }
            catch {
                // an unreadable part of a hostile file leaves the fact unknown
            }
        }
        return facts;
    },
};
