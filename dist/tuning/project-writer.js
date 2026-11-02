// Writes the deliverable of a tuning run: a NEW project 3MF (unsliced) whose settings are the engine's output laid on top of the original.
// The source is read once, hashed before and after, and never written. Every entry the run does not mean to change is copied byte for byte
// (same name, same order, same compression); project_settings.config and model_settings.config are spliced as text (see project-text.ts).
// The written file is re-opened and checked before it is handed back: a difference nobody asked for is an error, not a warning.
// Design and measurements: docs/TUNING-WRITER.md.
import { applyScopedSettings } from '../workflows/scoped-settings.js';
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { parseStringPromise } from "xml2js";
import { listSafe3mfEntries, loadSafe3mfArchive, readBoundedPrintFile } from "../safety/archive.js";
import { same } from "./engine.js";
import { MAX_TEXT_CHARS, assertWritable, blankFilamentSequence, blankGcodeFiles, dropRelationships, listObjects, resolveValue, setMembers, setObjectSettings, stripSliceResults, } from "./project-text.js";
const CONFIG = "Metadata/project_settings.config";
const MODEL_SETTINGS = "Metadata/model_settings.config";
const SLICE_INFO = "Metadata/slice_info.config";
const MODEL_RELS = "Metadata/_rels/model_settings.config.rels";
const FILAMENT_SEQUENCE = "Metadata/filament_sequence.json";
const SLICE_ONLY = /^Metadata\/plate_\d+\.(gcode|gcode\.md5|json)$/;
const DSTS = "different_settings_to_system";
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function parseConfig(text) {
    const value = JSON.parse(text.replace(/^﻿/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Metadata/project_settings.config is not a JSON object.");
    return value;
}
const eqv = (a, b) => Array.isArray(a) || Array.isArray(b) ? Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i])) : same(a, b);
const strings = (v) => (Array.isArray(v) ? v.map(String) : []);
const ids = (c) => ({
    printer: typeof c.printer_settings_id === "string" ? c.printer_settings_id : null,
    process: typeof c.print_settings_id === "string" ? c.print_settings_id : null,
    filaments: strings(c.filament_settings_id),
});
const abbrev = (v) => {
    if (v === undefined)
        return null;
    const text = JSON.stringify(v);
    return text.length > 300 ? `${text.slice(0, 200)}... (${text.length} characters)` : v;
};
function diff(a, b) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
        .map(key => ({ key, from: abbrev(a[key]), to: abbrev(b[key]) }));
}
function bedSize(c) {
    const points = strings(c.printable_area).map(p => /^(-?[\d.]+)x(-?[\d.]+)$/.exec(p)).filter((m) => !!m).map(m => [Number(m[1]), Number(m[2])]);
    if (points.length < 3)
        return undefined;
    const span = (i) => Math.max(...points.map(p => p[i])) - Math.min(...points.map(p => p[i]));
    return [span(0), span(1)];
}
/**
 * different_settings_to_system lists, per preset, the keys that differ from the system preset: [process, filament 1..N, printer],
 * each entry the keys joined by ";" in byte order (the 17-plate sample: "outer_wall_speed;sparse_infill_pattern",,,). Studio marks those keys
 * as modified. Entries that receive no key keep their text.
 */
function mergeDifferent(config, add, warnings) {
    const existing = Array.isArray(config[DSTS]) && config[DSTS].every(e => typeof e === "string") ? config[DSTS] : undefined;
    const slots = Array.isArray(config.filament_settings_id) ? config.filament_settings_id.length : Math.max((existing?.length ?? 2) - 2, 0);
    let entries;
    if (existing?.length === slots + 2)
        entries = [...existing];
    else {
        entries = Array(slots + 2).fill("");
        if (existing) {
            entries[0] = existing[0] ?? "";
            warnings.push(`${DSTS} has ${existing.length} entries for ${slots} filaments (expected ${slots + 2}); rebuilt, keeping the process entry only.`);
        }
    }
    const merge = (i, keys) => {
        const all = new Set(entries[i].split(";").filter(Boolean));
        const before = all.size;
        for (const key of keys)
            all.add(key);
        if (all.size !== before)
            entries[i] = [...all].sort().join(";");
    };
    merge(0, add.process);
    add.filament.forEach((keys, f) => { if (f < slots)
        merge(f + 1, keys); });
    merge(slots + 1, add.printer);
    return entries;
}
async function reservePath(wanted) {
    const resolved = path.resolve(wanted);
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
    const [, stem, ext = ""] = /^(.*?)(\.gcode\.3mf|\.[^.]+)?$/i.exec(path.basename(resolved));
    for (let n = 1; n < 10000; n++) {
        const candidate = n === 1 ? resolved : path.join(dir, `${stem}-${n}${ext}`);
        try {
            await (await fs.open(candidate, "wx")).close(); // reserves the name without ever touching an existing file
            return candidate;
        }
        catch (error) {
            if (error?.code !== "EEXIST")
                throw error;
        }
    }
    throw new Error(`No free name for ${resolved}.`);
}
async function text(zip, name) {
    const file = zip.file(name);
    if (!file)
        return undefined;
    const value = await file.async("string");
    if (value.length > MAX_TEXT_CHARS)
        throw new Error(`${name} is too large to edit.`);
    return value;
}
export async function writeTunedProject(o) {
    const warnings = [];
    const sourcePath = path.resolve(o.source);
    const sourceBytes = await readBoundedPrintFile(sourcePath);
    const originPath = o.origin && path.resolve(o.origin.path);
    const originBytes = originPath ? await readBoundedPrintFile(originPath) : undefined;
    const before = sha256(originBytes ?? sourceBytes);
    const isStl = /\.stl$/i.test(sourcePath);
    // 1. The source project's own settings, if it has any.
    const sourceZip = isStl ? undefined : await loadSafe3mfArchive(sourceBytes);
    const originalText = sourceZip && (await text(sourceZip, CONFIG));
    const original = originalText === undefined ? undefined : parseConfig(originalText);
    if (o.origin && original === undefined)
        throw new Error("A laid-out source must carry its project settings.");
    // What the diffs are against: the user's own file when `source` is a working copy of its P0.
    const originText = originBytes ? (/\.stl$/i.test(originPath) ? undefined : await text(await loadSafe3mfArchive(originBytes), CONFIG)) : originalText;
    const diffBase = originText === undefined ? undefined : parseConfig(originText);
    // 2. P0: the project for the target printer. A baseline (STL, or a 3MF with no settings) is the exported project whole; a project made
    //    for another printer keeps its own entries and takes only the exported settings.
    const baseline = original === undefined;
    const differs = !o.origin && !baseline && original.printer_settings_id !== o.target.printerPreset;
    let outcome;
    if (baseline || differs) {
        if (!o.retarget)
            throw new Error(`${path.basename(sourcePath)} needs a retargeter: ${baseline ? "it carries no project settings" : `it was made for ${String(original.printer_settings_id)}, not ${o.target.printerPreset}`}.`);
        outcome = await o.retarget(sourcePath);
    }
    const baseBytes = baseline ? outcome.archive : sourceBytes;
    const baseZip = baseline ? await loadSafe3mfArchive(baseBytes) : sourceZip;
    const donorText = outcome ? await text(baseline ? baseZip : await loadSafe3mfArchive(outcome.archive), CONFIG) : undefined;
    if (outcome && donorText === undefined)
        throw new Error("The exported project has no Metadata/project_settings.config.");
    let p0Text = donorText ?? originalText;
    let p0 = parseConfig(p0Text);
    if (outcome && differs) {
        // The export names the process "<preset> (project settings)"; Studio expects the system preset plus the list of modified keys.
        const modified = (outcome.edited ?? []).filter(key => key in p0);
        const patch = {};
        if (outcome.process && "print_settings_id" in p0)
            patch.print_settings_id = outcome.process;
        if (modified.length > 0)
            patch[DSTS] = mergeDifferent(p0, { process: new Set(modified), filament: [], printer: new Set() }, warnings);
        if (Object.keys(patch).length > 0) {
            p0Text = setMembers(p0Text, patch);
            p0 = parseConfig(p0Text);
        }
        const [from, to] = [bedSize(original), bedSize(p0)];
        if (from && to && (from[0] > to[0] || from[1] > to[1])) {
            warnings.push(`The source printer's bed (${from.join("x")} mm) is larger than ${o.target.printerPreset}'s (${to.join("x")} mm): objects placed beyond it do not fit; check the plate before slicing.`);
        }
    }
    if (baseline)
        warnings.push(`${path.basename(sourcePath)} carries no project settings: the project is Bambu Studio's export for ${o.target.printerPreset} with the printer's default process and filament.`);
    // 3. The tuning, laid on P0. Only keys whose value really changes are written.
    const values = {};
    const changed = [];
    const unchanged = [];
    const added = { process: new Set(), filament: [], printer: new Set() };
    const slots = strings(p0.filament_settings_id).length;
    added.filament = Array.from({ length: slots }, () => new Set());
    for (const change of o.changes ?? []) {
        assertWritable(change.key, change.value);
        if (change.key in values || unchanged.includes(change.key))
            throw new Error(`Setting ${change.key} is given twice.`);
        const base = p0[change.key];
        if (base !== undefined && typeof base !== "string" && !(Array.isArray(base) && base.every(e => typeof e === "string"))) {
            throw new Error(`Setting ${change.key} holds a value the writer does not edit.`);
        }
        if (base === undefined)
            warnings.push(`${change.key} is absent from the project; added as given.`);
        // Measured: the CLI reads this one from the plate (model_settings.config) and keeps its value over the project's.
        if (change.key === "filament_map_mode")
            warnings.push("filament_map_mode is a per-plate setting: the slicer ignored the value written to project_settings.config; check the grouping mode in Studio.");
        const to = base === undefined ? change.value : resolveValue(change.key, base, change.value, p0, change.elements);
        // Listed even when the value is already the project's: a hand-edited project does not list its edits, and the keep slice carries only what is
        // listed. A filament key goes to every slot for the same reason (a scalar fills them all). Listing a value equal to the preset is harmless.
        if (change.scope === "process")
            added.process.add(change.key);
        else if (change.scope === "printer")
            added.printer.add(change.key);
        else
            for (const keys of added.filament)
                keys.add(change.key);
        if (base !== undefined && eqv(base, to)) {
            unchanged.push(change.key);
            continue;
        }
        values[change.key] = to;
        changed.push({ key: change.key, from: base ?? null, to, scope: change.scope });
    }
    if ((o.changes ?? []).length > 0)
        values[DSTS] = mergeDifferent(p0, added, warnings);
    const finalText = Object.keys(values).length > 0 ? setMembers(p0Text, values) : p0Text;
    const final = parseConfig(finalText);
    // 4. The other entries: slice results out, per-object settings in.
    const order = listSafe3mfEntries(baseBytes);
    const dropped = new Set(order.map(e => e.name).filter(name => SLICE_ONLY.test(name)));
    const rewritten = new Map();
    if (finalText !== originalText)
        rewritten.set(CONFIG, finalText);
    const modelSettings = await text(baseZip, MODEL_SETTINGS);
    let modelNext = modelSettings === undefined ? undefined : blankGcodeFiles(modelSettings);
    const objectEdits = [];
    if (o.objectOverrides && Object.keys(o.objectOverrides.settings).length > 0) {
        if (modelNext === undefined)
            throw new Error("The project has no Metadata/model_settings.config to carry per-object settings.");
        const objects = listObjects(modelNext);
        const wanted = o.objectOverrides.objects?.map(String);
        const targets = wanted ? objects.filter(obj => wanted.includes(obj.id) || (obj.name !== undefined && wanted.includes(obj.name))) : objects;
        for (const w of wanted ?? [])
            if (!targets.some(obj => obj.id === w || obj.name === w))
                warnings.push(`Object "${w}" is not in the project; no override written for it.`);
        if (targets.length === 0)
            throw new Error("No object of the project matches the override targets.");
        const result = setObjectSettings(modelNext, targets, o.objectOverrides.settings);
        modelNext = result.xml;
        objectEdits.push(...result.edits);
    }
    if ((o.objectSettings?.length || o.uniformLayerHeight)) {
        if (modelNext === undefined)
            throw Error('Project has no per-object settings metadata');
        const scoped = await applyScopedSettings(baseZip, modelNext, o.objectSettings ?? [], o.uniformLayerHeight);
        modelNext = scoped.modelText;
        objectEdits.push(...scoped.edits);
        for (const [name, data] of scoped.rewritten)
            rewritten.set(name, data);
    }
    if (modelNext !== modelSettings)
        rewritten.set(MODEL_SETTINGS, modelNext);
    const sliceInfo = await text(baseZip, SLICE_INFO);
    if (sliceInfo !== undefined && stripSliceResults(sliceInfo) !== sliceInfo)
        rewritten.set(SLICE_INFO, stripSliceResults(sliceInfo));
    // The slicer's filament-to-nozzle grouping per plate is a slice result too; Studio's unsliced export holds the empty form for every plate.
    const grouping = await text(baseZip, FILAMENT_SEQUENCE);
    if (grouping !== undefined) {
        try {
            const blank = blankFilamentSequence(grouping);
            if (blank !== undefined)
                rewritten.set(FILAMENT_SEQUENCE, blank);
        }
        catch {
            warnings.push(`${FILAMENT_SEQUENCE} could not be read; copied as it is (it may hold the grouping of a past slice).`);
        }
    }
    const rels = await text(baseZip, MODEL_RELS);
    if (rels !== undefined && dropped.size > 0) {
        const next = dropRelationships(rels, dropped);
        if (next === undefined)
            dropped.add(MODEL_RELS);
        else if (next !== rels)
            rewritten.set(MODEL_RELS, next);
    }
    // 5. The new archive: same names, same order, same compression.
    const out = new JSZip();
    for (const { name, stored } of order) {
        if (dropped.has(name))
            continue;
        const isDir = name.endsWith("/");
        const data = rewritten.get(name) ?? (isDir ? "" : await baseZip.file(name).async("nodebuffer"));
        out.file(name, data, { dir: isDir, createFolders: false, compression: stored ? "STORE" : "DEFLATE" });
    }
    const bytes = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    // 6. Atomic write to a name nobody has, then re-open and check.
    const finalPath = await reservePath(o.output);
    const tmp = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    try {
        await fs.writeFile(tmp, bytes, { flag: "wx" });
        await fs.rename(tmp, finalPath);
        await verifyWritten(finalPath, { baseZip, expectedNames: order.map(e => e.name).filter(n => !dropped.has(n)), touched: new Set(rewritten.keys()), p0, values, objects: modelSettings === undefined ? undefined : listObjects(modelSettings).length });
    }
    catch (error) {
        await fs.rm(tmp, { force: true });
        await fs.rm(finalPath, { force: true });
        throw error;
    }
    const after = sha256(await readBoundedPrintFile(originPath ?? sourcePath));
    if (after !== before)
        throw new Error(`${originPath ?? sourcePath} changed while the project was written.`);
    if (originPath && sha256(await readBoundedPrintFile(sourcePath)) !== sha256(sourceBytes))
        throw new Error(`${sourcePath} changed while the project was written.`);
    const summary = o.origin?.retarget ?? {
        applied: !!outcome,
        reason: baseline ? "baseline" : differs ? "printer-differs" : "same-printer",
        printer_ids: { before: original ? ids(original) : null, after: ids(p0) },
        kept: outcome?.report?.kept ?? [],
        not_kept: outcome?.report?.not_kept ?? [],
        filament_map: outcome?.report?.filament_map ?? [],
        changed_keys: differs ? diff(original, p0) : [],
    };
    return {
        path: finalPath,
        sha256_of_source_before_and_after: { before, after },
        changed_keys: changed,
        unchanged_keys: unchanged,
        object_overrides: objectEdits,
        retarget: summary,
        combined_diff: diff(diffBase ?? p0, final),
        dropped_entries: [...dropped],
        rewritten_entries: [...rewritten.keys()],
        warnings,
    };
}
/** The written file is a valid archive, differs from its base only where intended, and its settings parse to exactly the intended values. */
async function verifyWritten(file, expect) {
    const bytes = await readBoundedPrintFile(file);
    const zip = await loadSafe3mfArchive(bytes); // central/local records agree, CRCs match, names are safe
    const names = listSafe3mfEntries(bytes).map(e => e.name);
    if (JSON.stringify(names) !== JSON.stringify(expect.expectedNames))
        throw new Error("Written project verification failed: the entry list differs from the plan.");
    for (const name of names) {
        if (expect.touched.has(name) || name.endsWith("/"))
            continue;
        const [a, b] = [await zip.file(name).async("nodebuffer"), await expect.baseZip.file(name).async("nodebuffer")];
        if (!a.equals(b))
            throw new Error(`Written project verification failed: ${name} is not byte-identical to the original.`);
    }
    const written = parseConfig((await text(zip, CONFIG)));
    for (const key of new Set([...Object.keys(written), ...Object.keys(expect.p0)])) {
        const wanted = key in expect.values ? expect.values[key] : expect.p0[key];
        if (JSON.stringify(written[key]) !== JSON.stringify(wanted))
            throw new Error(`Written project verification failed: ${key} is not the intended value.`);
    }
    const xml = await text(zip, MODEL_SETTINGS);
    if (xml !== undefined) {
        await parseStringPromise(xml); // well-formed
        if (expect.objects !== undefined && listObjects(xml).length !== expect.objects)
            throw new Error("Written project verification failed: the object count changed.");
    }
}
