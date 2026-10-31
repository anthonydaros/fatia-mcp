// Tier-1 facts: what a rule can read from a 3MF without slicing it or looking at geometry.
// project_settings.config is read RAW (strings and lists of strings, as Studio wrote them): parse3MF().slicerConfig
// converts numbers, and the rules compare the original text ("15%", "0.2").
import { parseStringPromise } from "xml2js";
import { readSafe3mfArchive } from "../../safety/archive.js";
import { normalizeModel } from "../../safety/limits.js";
import { matchVersion } from "../version.js";
const X2D_MINIMUM = ">=2.5.3.60";
const MAX_XML_CHARS = 32 * 2 ** 20; // far above any real metadata file; a bigger one is treated as absent
const STICKY_TYPES = new Set(["PETG", "PA", "TPU", "PCTG", "PPA"]);
const asArray = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const isScalar = (x) => ["string", "number", "boolean"].includes(typeof x);
const has = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
const asFact = (v) => Array.isArray(v) ? (v.every(isScalar) ? v : undefined) : isScalar(v) ? v : undefined; // objects and nested lists are not facts
const list = (v) => { const f = asFact(v); return f === undefined || f === null ? undefined : Array.isArray(f) ? f : [f]; };
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** Opens a 3MF through the safe archive reader and parses the three metadata files tier 1 needs. Never throws on their content. */
export async function openProject(filePath) {
    // shortcut: the safe loader inflates every entry, plate G-code included, to read three small files; fine under its 256 MiB cap, replace when the G-code tier streams it.
    const { zip } = await readSafe3mfArchive(filePath);
    const read = (name) => zip.file(name)?.async("string");
    const xml = async (name) => {
        try {
            const raw = await read(name);
            return raw === undefined || raw.length > MAX_XML_CHARS ? undefined : (await parseStringPromise(raw, { explicitArray: false, mergeAttrs: true }))?.config;
        }
        catch {
            return undefined; // malformed XML counts as absent
        }
    };
    const project = { sliceInfo: await xml("Metadata/slice_info.config"), modelSettings: await xml("Metadata/model_settings.config") };
    const raw = await read("Metadata/project_settings.config");
    if (raw === undefined) {
        project.configProblem = "3MF sem Metadata/project_settings.config (so geometria): fatie no Studio ou envie o 3MF do projeto";
        return project;
    }
    try {
        const config = JSON.parse(raw.replace(/^﻿/, ""));
        if (config && typeof config === "object" && !Array.isArray(config))
            project.config = config;
        else
            project.configProblem = "Metadata/project_settings.config nao e um objeto JSON";
    }
    catch {
        project.configProblem = "Metadata/project_settings.config ilegivel (JSON invalido)";
    }
    return project;
}
/** Largest side of the printable_area polygon ("0x0", "350x0", ...), in mm. */
function bedSize(area) {
    const points = list(area)?.map(p => /^(-?\d+(?:\.\d+)?)x(-?\d+(?:\.\d+)?)$/.exec(String(p)));
    if (!points || points.length < 3 || points.some(p => !p))
        return undefined;
    const side = (i) => { const v = points.map(p => Number(p[i])); return Math.max(...v) - Math.min(...v); };
    return Math.max(side(1), side(2));
}
/** Objects on the plate and the distinct filaments their objects and parts are assigned to. */
function plateUsage(modelSettings, plateIndex) {
    const meta = (node, key) => asArray(node?.metadata).find(m => m?.key === key)?.value;
    const plate = asArray(modelSettings?.plate).find(p => Number(meta(p, "plater_id")) === plateIndex + 1);
    if (!plate)
        return undefined;
    const onPlate = new Set(asArray(plate.model_instance).map(i => String(meta(i, "object_id"))));
    const filaments = new Set();
    // shortcut: only the filaments assigned to objects and parts; painted colours and support filaments are not seen, so this can undercount.
    for (const object of asArray(modelSettings.object)) {
        if (!onPlate.has(String(object.id)))
            continue;
        filaments.add(String(meta(object, "extruder") ?? "1"));
        for (const part of asArray(object.part)) {
            const extruder = meta(part, "extruder");
            if (extruder !== undefined && (part.subtype ?? "normal_part") === "normal_part")
                filaments.add(String(extruder));
        }
    }
    return { objects: onPlate.size, filaments: filaments.size };
}
/** The Studio that saved the 3MF; anything but a plain dotted version is treated as unknown (the value is third-party text). */
export function savedVersion(project) {
    const value = asArray(project.sliceInfo?.header?.header_item).find(i => i?.key === "X-BBL-Client-Version")?.value;
    return typeof value === "string" && /^\d{1,5}(\.\d{1,5}){0,3}$/.test(value.trim()) ? value.trim() : undefined;
}
const verdict = (v) => (v === "unknown" ? undefined : v === "applies");
const DERIVED = {
    "printer.model": (_c, _p, config) => text(config.printer_model),
    "printer.nozzle_diameter": (_c, _p, config) => list(config.nozzle_diameter),
    "printer.nozzle_count": (_c, _p, config) => list(config.nozzle_diameter)?.length,
    "printer.nozzle_diameters_differ": (_c, _p, config) => { const l = list(config.nozzle_diameter); return l && new Set(l.map(Number)).size > 1; },
    "printer.bed_size_mm": (_c, _p, config) => bedSize(config.printable_area),
    "project.filament_types": (_c, _p, config) => list(config.filament_type),
    // Type and stickiness are compared at the same filament index, as the fact is declared.
    "filament.low_stickiness_on_sticky_type_count": (_c, _p, config) => {
        const [types, stickiness] = [list(config.filament_type), list(config.filament_metal_stickiness)];
        return types && stickiness ? types.filter((t, i) => STICKY_TYPES.has(String(t)) && ["None", "Low"].includes(String(stickiness[i]))).length : undefined;
    },
    "project.source_printer": (_c, _p, config) => text(config.printer_model),
    "project.target_printer": ctx => `Bambu Lab ${ctx.targetPrinter.toUpperCase()}`,
    "project.printer_changed": (ctx, _p, config) => {
        const source = normalizeModel(config.printer_model);
        return source === undefined ? undefined : source !== ctx.targetPrinter;
    },
    "project.object_count": (ctx, project) => plateUsage(project.modelSettings, ctx.plateIndex)?.objects,
    "project.filament_count": (ctx, project) => plateUsage(project.modelSettings, ctx.plateIndex)?.filaments,
    "studio.version": (_c, project) => savedVersion(project),
    "studio.installed_version": async (ctx) => (await ctx.installedStudio()) ?? undefined,
    // The Studio that will slice decides; the one that saved the file is the fallback (rule text: "se a ferramenta souber, a instalada").
    "studio.meets_x2d_minimum": async (ctx, project) => {
        const version = (await ctx.installedStudio()) ?? savedVersion(project);
        return version ? verdict(matchVersion(X2D_MINIMUM, version)) : undefined;
    },
};
export const settingsProvider = {
    tier: 1,
    needs: ["3mf"],
    provides: name => name.startsWith("settings.") || has(DERIVED, name),
    async collect(ctx, wanted) {
        const facts = {};
        const project = ctx.project;
        if (!project)
            return facts;
        const config = project.config ?? {};
        for (const name of wanted) {
            // has(): a key like "__proto__" or "constructor" in a hostile 3MF must not resolve to an inherited property.
            const key = name.slice("settings.".length);
            const value = name.startsWith("settings.")
                ? has(config, key) ? asFact(config[key]) : undefined
                : has(DERIVED, name) ? await DERIVED[name](ctx, project, config) : undefined;
            if (value !== undefined)
                facts[name] = value;
        }
        return facts;
    },
};
