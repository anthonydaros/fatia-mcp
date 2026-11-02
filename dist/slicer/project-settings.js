import { readSafe3mfArchive } from '../safety/archive.js';
export async function readProjectConfig(filePath) {
    if (!filePath.toLowerCase().endsWith('.3mf'))
        return undefined;
    const { zip } = await readSafe3mfArchive(filePath);
    const file = zip.file('Metadata/project_settings.config');
    // Geometry-only 3MFs carry no settings.
    if (!file)
        return undefined;
    const config = JSON.parse(await file.async('string'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(`Invalid Metadata/project_settings.config in ${filePath}.`);
    }
    return config;
}
const strings = (value) => Array.isArray(value) ? value.map(String) : [];
// Bambu Studio rewrites numbers when it saves ("1.0" -> "1", "100" -> "100%"); that is not an edit.
const canon = (value) => Array.isArray(value) ? value.map(canon)
    : typeof value === 'string' && /^-?\d+(\.\d+)?%?$/.test(value) ? parseFloat(value) : value;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
/** Preset identity rather than print settings: never carried over from a project. */
const PRESET_META = new Set([
    'name', 'type', 'from', 'inherits', 'include', 'instantiation', 'setting_id', 'version', 'description',
    'print_settings_id', 'compatible_printers', 'compatible_printers_condition',
    'post_process', // runs a script after slicing: never from a 3MF
]);
// Machine edits that carry over from a project made for this very printer: the retraction family, which is where tuning lives.
// Hardware and G-code keys stay with the preset (a 3MF is untrusted); widen this list on purpose, never by pattern.
const MACHINE_EDITS = /^(retract|deretraction|z_hop|travel_slope)|^wipe(_distance)?$/;
const FILAMENT_GCODE = /gcode$/;
const listed = (entry) => (entry ?? '').split(';').filter(Boolean);
// A 3MF's process list may only name process keys: G-code and machine keys it lists there would reach the slice through the process overlay.
const listedProcess = (entry) => listed(entry).filter(key => !FILAMENT_GCODE.test(key) && !key.startsWith('machine_'));
const show = (value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'unset';
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};
/** "Generic PLA @BBL H2D 0.4 nozzle" -> "Generic PLA": the part shared by every printer's variant. */
const baseName = (name) => name.replace(/ @BBL \S+(?: \d+(?:\.\d+)? nozzle)?$/, '');
/** Carry a variant vector (one entry per print_extruder_variant) onto the target printer's variants. */
function mapVariants(project, target, value, base) {
    const [pVariant, pId] = [strings(project.print_extruder_variant), strings(project.print_extruder_id)];
    const [tVariant, tId] = [strings(target.print_extruder_variant), strings(target.print_extruder_id)];
    // Not a per-variant vector (or no variants to map): it carries over only at the same length.
    if (pVariant.length === 0 || tVariant.length === 0 || value.length !== pVariant.length || base.length !== tVariant.length) {
        return value.length === base.length ? { values: value, dropped: [] } : undefined;
    }
    const values = [...base];
    const dropped = [];
    value.forEach((entry, i) => {
        const j = tVariant.findIndex((variant, k) => variant === pVariant[i] && tId[k] === pId[i]);
        if (j < 0)
            dropped.push(`extruder ${pId[i]} ${pVariant[i]}`);
        else
            values[j] = entry;
    });
    return { values, dropped };
}
export async function buildProjectSettingsPlan(t) {
    const { config, printerPreset, modelCode } = t;
    const nozzle = /(\d+(?:\.\d+)?) nozzle$/.exec(printerPreset)?.[1];
    const compatible = (preset) => !Array.isArray(preset.compatible_printers) ||
        preset.compatible_printers.length === 0 || preset.compatible_printers.includes(printerPreset);
    // The project's own name first: P1S and X1E use the X1C presets. The nozzle-specific name wins
    // where a model has both (X2D: bare = 0.6/0.8, "0.4 nozzle" = 0.4).
    const equivalent = (kind, name) => [
        name, `${baseName(name)} @BBL ${modelCode}`, ...(nozzle ? [`${baseName(name)} @BBL ${modelCode} ${nozzle} nozzle`] : []),
    ].find(candidate => { const preset = t.leaf(kind, candidate); return preset && compatible(preset); });
    const defaults = {
        process: String(t.machine.default_print_profile ?? ''),
        filament: strings(t.machine.default_filament_profile)[0] ?? '',
    };
    const projectProcess = String(config.print_settings_id ?? '');
    const mappedProcess = projectProcess ? equivalent('process', projectProcess) : undefined;
    const process = mappedProcess ?? defaults.process;
    if (!process)
        throw new Error(`${printerPreset} names no default process preset.`);
    const flat = await t.flatProcess(process);
    // Made for this very printer: the project's process values are trusted whole, not only the keys it lists
    // as changed (Bambu Studio rewrites that list on save, and hand edits never update it).
    const samePrinter = config.printer_settings_id === printerPreset;
    let defaultProcess = process === defaults.process ? flat : undefined;
    let defaultFilament;
    if (!defaultProcess) {
        try {
            defaultProcess = await t.flatProcess(defaults.process);
        }
        catch { /* Unavailable default values stay unknown in the report. */ }
    }
    if (!t.skipFilaments) {
        try {
            defaultFilament = await t.flatProcess(defaults.filament);
        }
        catch { /* Keep does not require an unused default profile. */ }
    }
    const details = [];
    const preserve = (key, scope, value, base, original = value) => { details.push({ key, scope, project_value: original ?? null, printer_default_value: (scope === "process" ? defaultProcess?.[key] : scope === "printer" ? t.machine[key] : defaultFilament?.[key]) ?? null, selected_value: value ?? null, action: "kept" }); return `${scope === "process" ? "" : scope + " "}${key}: projeto=${show(value)} (padrão da impressora=${show(scope === "process" ? defaultProcess?.[key] : scope === "printer" ? t.machine[key] : defaultFilament?.[key])}) — mantido`; };
    const kept = [];
    const notKept = [];
    if (projectProcess && !mappedProcess && !samePrinter) {
        notKept.push(`process preset ${projectProcess}: no ${modelCode} equivalent; using ${process}`);
    }
    else if (process !== defaults.process) {
        kept.push(`process preset: selecionado=${process} (padrão da impressora=${defaults.process})`);
    }
    // [process, filament 1..N, printer]; a project saved without the list cannot say what changed.
    const changed = strings(config.different_settings_to_system);
    const ids = strings(config.filament_settings_id);
    if (changed.length === 0 && !samePrinter)
        notKept.push('different_settings_to_system is missing; process settings come from the printer preset');
    const overlay = {};
    // A key the sparse preset lacks (brim_type, wall_sequence) still counts when the project lists it: the CLI resets it otherwise.
    const keys = (samePrinter ? [...new Set([...Object.keys(flat), ...listedProcess(changed[0])])] : listedProcess(changed[0])).filter(key => !PRESET_META.has(key));
    for (const key of keys) {
        const value = config[key];
        const base = flat[key];
        let next = value;
        if (value === undefined) {
            if (!samePrinter)
                notKept.push(`${key}: listed as changed but absent from the project`);
            continue;
        }
        if (Array.isArray(value) && Array.isArray(base)) {
            const mapped = mapVariants(config, flat, value, base);
            if (!mapped) {
                notKept.push(`${key}: ${value.length} values do not fit the ${modelCode} preset's ${base.length}`);
                continue;
            }
            next = mapped.values;
            if (mapped.dropped.length > 0)
                notKept.push(`${key}: no ${modelCode} equivalent for ${mapped.dropped.join(', ')}`);
        }
        else if (Array.isArray(value) !== Array.isArray(base) && base !== undefined) {
            notKept.push(`${key}: the ${modelCode} preset stores it differently`);
            continue;
        }
        if (same(next, base))
            continue;
        overlay[key] = next;
        kept.push(preserve(key, "process", next, base, value));
    }
    // [process, filament 1..N, printer]. For the project's own printer, what it lists as edited for a filament or for the
    // printer is carried too (G-code and hardware keys excepted): Studio's own "modified preset" semantics, and the way
    // a tuned printer or filament value survives a later slice, which otherwise takes both from the presets.
    const layout = changed.length === ids.length + 2;
    const machineOverlay = {};
    if (samePrinter && layout) {
        for (const key of listed(changed[changed.length - 1])) {
            const [value, base] = [config[key], t.machine[key]];
            if (value === undefined)
                continue;
            if (!MACHINE_EDITS.test(key)) {
                notKept.push(`printer ${key}: machine settings outside the retraction family come from ${printerPreset}`);
                continue;
            }
            if (base !== undefined && (Array.isArray(value) !== Array.isArray(base) || (Array.isArray(value) && value.length !== base.length))) {
                notKept.push(`printer ${key}: ${show(value)} does not fit the ${modelCode} preset's ${show(base)}`);
                continue;
            }
            if (same(value, base))
                continue;
            machineOverlay[key] = value;
            kept.push(preserve(key, "printer", value, base));
        }
    }
    const filaments = [];
    if (!t.skipFilaments) {
        for (const [i, from] of ids.entries()) {
            const to = equivalent('filament', from);
            const entry = { slot: i + 1, from, to: to ?? defaults.filament };
            filaments.push(entry);
            if (!to && !defaults.filament)
                throw new Error(`No ${modelCode} equivalent for filament "${from}" and ${printerPreset} names no default filament.`);
            if (!to)
                notKept.push(`filament ${i + 1} ${from}: no ${modelCode} equivalent compatible with ${printerPreset}; using ${defaults.filament}`);
            else if (to !== defaults.filament)
                kept.push(`filament ${i + 1}: ${from} -> ${to} (printer default: ${defaults.filament})`);
            if (!layout || !changed[i + 1])
                continue;
            if (!(samePrinter && to === from)) {
                notKept.push(`filament ${i + 1} ${from}: edited ${changed[i + 1].split(';').join(', ')} (filament edits are not carried over)`);
                continue;
            }
            let flatFilament;
            try {
                flatFilament = await t.flatProcess(to);
            }
            catch {
                notKept.push(`filament ${i + 1} ${from}: edited ${changed[i + 1].split(';').join(', ')} (preset ${to} cannot be read)`);
                continue;
            }
            const edits = {};
            for (const key of listed(changed[i + 1])) {
                const value = config[key];
                const base = flatFilament[key];
                if (value === undefined)
                    continue;
                if (PRESET_META.has(key) || FILAMENT_GCODE.test(key)) {
                    notKept.push(`filament ${i + 1} ${key}: G-code and preset identity come from ${to}`);
                    continue;
                }
                // Project vectors hold every slot: one value per slot, or per slot and extruder variant (the preset's own length).
                const per = Array.isArray(base) ? base.length : 1;
                const piece = !Array.isArray(value) ? value : value.length === ids.length * per ? value.slice(i * per, (i + 1) * per) : undefined;
                if (piece === undefined || (base !== undefined && Array.isArray(piece) !== Array.isArray(base))) {
                    notKept.push(`filament ${i + 1} ${key}: ${show(value)} does not fit the ${to} preset's ${show(base)}`);
                    continue;
                }
                if (same(piece, base))
                    continue;
                edits[key] = piece;
                kept.push(preserve(key, `filament ${i + 1}`, piece, base));
            }
            if (Object.keys(edits).length > 0)
                entry.overlay = edits;
        }
    }
    if (layout && !samePrinter && changed[changed.length - 1]) {
        notKept.push(`printer: ${changed[changed.length - 1].split(';').join(', ')} (machine settings come from ${printerPreset})`);
    }
    return {
        from: { printer: String(config.printer_settings_id ?? config.printer_model ?? 'unknown printer'), process: projectProcess },
        process, overlay, machineOverlay, filaments, defaults, kept, notKept, details,
    };
}
/** What a slice in the chosen mode kept and dropped, for the tool result. */
export function settingsReport(plan, mode) {
    const keep = mode === 'keep';
    return {
        mode,
        details: (plan.details ?? []).map(d => ({ ...d, selected_value: keep ? d.selected_value : d.printer_default_value, action: keep ? "kept" : "printer_default" })),
        kept: keep ? plan.kept : [],
        // Under printer defaults, everything the project would have kept is what was dropped.
        not_kept: keep ? plan.notKept : [...plan.kept.map(message => message.replace(/ — mantido$/, " — substituído pelo padrão da impressora")), ...plan.notKept],
        filament_map: plan.filaments.map(({ slot, from, to }) => ({ slot, from, to: keep ? to : plan.defaults.filament })),
    };
}
