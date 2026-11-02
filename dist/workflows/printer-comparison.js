import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { openProject, asArray, meta } from '../knowledge/facts/settings.js';
import { readBoundedPrintFile } from '../safety/archive.js';
import { writeTunedProject } from '../tuning/project-writer.js';
import { checkBlockValue } from '../tuning/config-block.js';
import { same } from '../tuning/engine.js';
import { PROCESS_SETTING_PROPERTIES } from './settings-registry.js';
const qualityKeys = ['layer_height', 'wall_loops', 'top_shell_layers', 'bottom_shell_layers', 'sparse_infill_density', 'sparse_infill_pattern'];
const optionalQualityKeys = [...Object.keys(PROCESS_SETTING_PROPERTIES).filter(key => !/(?:speed|acceleration)$/.test(key)), 'initial_layer_print_height', 'initial_layer_line_width', 'line_width', 'outer_wall_line_width', 'inner_wall_line_width', 'sparse_infill_line_width', 'internal_solid_infill_line_width', 'top_surface_line_width', 'enable_support', 'support_type', 'support_style', 'support_threshold_angle', 'support_on_build_plate_only', 'support_interface_top_layers', 'support_interface_bottom_layers', 'support_top_z_distance', 'support_bottom_z_distance', 'support_object_xy_distance', 'support_interface_spacing', 'support_base_pattern', 'support_interface_pattern', 'support_base_pattern_spacing', 'support_expansion', 'raft_layers', 'brim_type', 'brim_width', 'top_shell_thickness', 'bottom_shell_thickness', 'top_surface_pattern', 'bottom_surface_pattern', 'internal_solid_infill_pattern', 'wall_generator', 'elefant_foot_compensation', 'xy_hole_compensation', 'xy_contour_compensation', 'resolution', 'slice_closing_radius', 'precise_outer_wall', 'ironing_flow', 'ironing_spacing'];
const qualityFor = (config) => [...new Set([...qualityKeys, ...optionalQualityKeys.filter(key => config[key] !== undefined)])];
const materialKeys = ['filament_type', 'filament_density', 'filament_diameter'];
const optionalMaterialKeys = ['filament_flow_ratio', 'nozzle_temperature', 'nozzle_temperature_initial_layer'];
const materialFor = (config) => [...materialKeys, ...optionalMaterialKeys.filter(key => config[key] !== undefined)];
const objectSettingKeys = new Set([...Object.keys(PROCESS_SETTING_PROPERTIES), ...optionalQualityKeys, ...materialKeys, ...optionalMaterialKeys]);
const profileNames = ['Metadata/layer_heights_profile.txt', 'Metadata/layer_config_ranges.xml'];
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => Array.isArray(a) || Array.isArray(b) ? Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i])) : a !== undefined && b !== undefined && same(a, b);
function equivalentSetting(a, b) {
    if (equal(a, b))
        return true;
    const left = Array.isArray(a) ? a : [a], right = Array.isArray(b) ? b : [b];
    const nonempty = (values) => values.length > 0 && values.every(v => typeof v === 'string' ? v.trim().length > 0 : typeof v === 'number' && Number.isFinite(v) || typeof v === 'boolean');
    return nonempty(left) && nonempty(right) && left.every(v => equal(v, left[0])) && right.every(v => equal(v, left[0]));
}
function nonnegative(value, key) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > (key === 'power_w' ? 100000 : 1e9))
        throw Error(`${key} must be a finite nonnegative number within the schema limit`);
    return value;
}
function membership(project) {
    const plates = asArray(project.modelSettings?.plate).filter(p => asArray(p.model_instance).length).map(p => ({ plate: Number(meta(p, 'plater_id')), members: asArray(p.model_instance).map(i => `${meta(i, 'object_id')}:${meta(i, 'instance_id') ?? 0}`).sort() }));
    const keys = plates.flatMap(p => p.members);
    if (!plates.length || plates.some(p => !Number.isInteger(p.plate) || p.plate < 1 || p.members.some(k => !/^\d+:\d+$/.test(k))) || new Set(plates.map(p => p.plate)).size !== plates.length || new Set(keys).size !== keys.length)
        throw Error('Missing or ambiguous populated plate membership');
    return plates.sort((a, b) => a.plate - b.plate);
}
async function preserved(source, candidate) {
    const reasons = [], a = source.config ?? {}, b = candidate.config ?? {};
    const sourceSlots = Array.isArray(a.filament_settings_id) ? a.filament_settings_id.length : 0, candidateSlots = Array.isArray(b.filament_settings_id) ? b.filament_settings_id.length : 0;
    if (!sourceSlots || !candidateSlots)
        reasons.push('unknown_filament_slot_count');
    else if (sourceSlots !== candidateSlots)
        reasons.push('changed_filament_slot_count');
    for (const key of [...qualityFor(a), ...materialFor(a)]) {
        if (a[key] === undefined || b[key] === undefined)
            reasons.push(`unknown_setting: ${key}`);
        else if (!equivalentSetting(a[key], b[key]))
            reasons.push(`changed_setting: ${key}`);
    }
    if (JSON.stringify(asArray(source.modelSettings?.object)) !== JSON.stringify(asArray(candidate.modelSettings?.object)))
        reasons.push('changed_object_overrides');
    for (const name of profileNames) {
        const a = await source.read?.(name), b = await candidate.read?.(name);
        if ((a?.toString('utf8') ?? '') !== (b?.toString('utf8') ?? ''))
            reasons.push(`changed_layer_profile: ${name}`);
    }
    try {
        if (JSON.stringify(membership(source)) !== JSON.stringify(membership(candidate)))
            reasons.push('changed_plate_membership');
    }
    catch {
        reasons.push('unknown_plate_membership');
    }
    return reasons;
}
async function effectiveScope(project) {
    const reasons = [];
    const hasOverride = (value) => {
        if (Array.isArray(value))
            return value.some(hasOverride);
        if (!value || typeof value !== 'object')
            return false;
        const node = value;
        if (typeof node.key === 'string' && objectSettingKeys.has(node.key))
            return true;
        return Object.entries(node).some(([key, child]) => objectSettingKeys.has(key) || hasOverride(child));
    };
    if (hasOverride(asArray(project.modelSettings?.object)))
        reasons.push('effective_object_settings_unverified');
    for (const name of profileNames) {
        const bytes = await project.read?.(name);
        if (bytes?.toString('utf8').trim())
            reasons.push(`effective_layer_profile_unverified: ${name}`);
    }
    return reasons;
}
class Stop extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
/** Compare print operating estimates for the unchanged authored project, never a printer purchase ROI. */
export async function comparePrinterModels(args, deps) {
    const allowed = new Set(['path', 'printers', 'objective', 'material_price_per_kg', 'electricity_price_per_kwh', 'currency', 'max_slices', 'max_minutes']);
    for (const key of Object.keys(args))
        if (!allowed.has(key))
            throw Error(`Unsupported printer-comparison argument: ${key}`);
    if (typeof args.path !== 'string' || !args.path.toLowerCase().endsWith('.3mf'))
        throw Error('path must be an existing 3MF project');
    if (!Array.isArray(args.printers) || args.printers.length !== 2)
        throw Error('printers must contain exactly two distinct explicit models');
    const printers = args.printers.map((p) => {
        if (!p || typeof p !== 'object' || Array.isArray(p))
            throw Error('Invalid printer');
        const row = p;
        if (Object.keys(row).some(k => !['bambu_model', 'power_w', 'machine_hourly_cost'].includes(k)) || typeof row.bambu_model !== 'string' || !row.bambu_model.trim())
            throw Error('Each printer needs an explicit bambu_model');
        return { bambu_model: row.bambu_model.trim().toLowerCase(), power_w: nonnegative(row.power_w, 'power_w'), machine_hourly_cost: nonnegative(row.machine_hourly_cost, 'machine_hourly_cost') };
    });
    if (printers[0].bambu_model === printers[1].bambu_model)
        throw Error('Printer models must be distinct');
    const objective = args.objective ?? 'balanced';
    if (!['balanced', 'time', 'material', 'cost'].includes(String(objective)))
        throw Error('Invalid objective');
    const price = nonnegative(args.material_price_per_kg, 'material_price_per_kg'), electricity = nonnegative(args.electricity_price_per_kwh, 'electricity_price_per_kwh');
    const energyRequested = electricity !== undefined || printers.some(p => p.power_w !== undefined);
    if (energyRequested && (electricity === undefined || printers.some(p => p.power_w === undefined)))
        throw Error('Energy estimates require electricity_price_per_kwh and power_w for both printers');
    if (printers.some(p => p.machine_hourly_cost !== undefined) && printers.some(p => p.machine_hourly_cost === undefined))
        throw Error('machine_hourly_cost must be supplied for both printers');
    const currency = args.currency ?? 'BRL';
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
        throw Error('currency must be a three-letter uppercase currency code');
    const max = args.max_slices ?? 6, minutes = args.max_minutes ?? 10;
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 6)
        throw Error('max_slices must be 1..6');
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < .1 || minutes > 60)
        throw Error('max_minutes must be .1..60');
    const now = deps.now ?? Date.now, started = now(), controller = new AbortController();
    const abort = () => controller.abort(deps.signal?.reason);
    deps.signal?.addEventListener('abort', abort, { once: true });
    if (deps.signal?.aborted)
        abort();
    const timer = setTimeout(() => controller.abort(new Stop('budget_minutes')), minutes * 60000);
    timer.unref();
    let slices = 0, stop = 'done', scratch, output;
    const rows = printers.map(p => ({ ...p, eligible: false, ineligible_reasons: [], time_s: null, weight_g: null, material_cost: null, energy_cost: null, machine_cost: null, total_cost: null, output_path: null }));
    const active = () => { if (deps.signal?.aborted)
        throw new Stop('cancelled'); if (controller.signal.aborted || now() - started >= minutes * 60000)
        throw new Stop('budget_minutes'); };
    const reserve = () => { active(); if (slices >= max)
        throw new Stop('budget_slices'); slices++; };
    try {
        active();
        const sourcePath = path.resolve(args.path), before = hash(await readBoundedPrintFile(sourcePath)), source = await openProject(sourcePath);
        const scopeReasons = await effectiveScope(source);
        let sourcePlates;
        try {
            sourcePlates = membership(source);
        }
        catch { }
        await fs.mkdir(deps.tempDir, { recursive: true });
        scratch = await fs.mkdtemp(path.join(path.resolve(deps.tempDir), 'compare-printers-'));
        for (const [i, printer] of printers.entries()) {
            const row = rows[i];
            try {
                active();
                if (!sourcePlates) {
                    row.ineligible_reasons.push('unknown_source_plate_membership');
                    continue;
                }
                const target = await deps.target(printer.bambu_model);
                active();
                row.printer_preset = target.printerPreset;
                const written = await writeTunedProject({ source: sourcePath, output: path.join(scratch, `printer-${i + 1}.3mf`), target: { printerPreset: target.printerPreset }, changes: [], retarget: async (file) => {
                        let counted = 0;
                        const result = await target.retarget(file, { signal: controller.signal, beforeSlice: () => { reserve(); counted++; } });
                        active();
                        if ((result.slices ?? 0) !== counted)
                            throw Error('Retargeter did not account for every actual slice');
                        return result;
                    } });
                active();
                row.settings_report = written.retarget;
                row.settings_diff = written.combined_diff;
                row.warnings = written.warnings;
                let candidate = await openProject(written.path);
                row.ineligible_reasons.push(...await preserved(source, candidate));
                if (row.ineligible_reasons.length)
                    continue;
                reserve();
                const measured = await target.sliceAll(written.path, controller.signal);
                active();
                row.plates = measured;
                candidate = await openProject(written.path);
                row.ineligible_reasons.push(...await preserved(source, candidate));
                const ids = measured.map(p => p.plate), expected = sourcePlates.map(p => p.plate);
                if (ids.length !== expected.length || new Set(ids).size !== ids.length || expected.some(p => !ids.includes(p)))
                    row.ineligible_reasons.push('incomplete_plate_coverage');
                if (measured.some(p => p.gcode_complete !== true))
                    row.ineligible_reasons.push('incomplete_or_unverified_gcode');
                if (measured.some(p => typeof p.time_s !== 'number' || !Number.isFinite(p.time_s) || p.time_s < 0 || typeof p.weight_g !== 'number' || !Number.isFinite(p.weight_g) || p.weight_g < 0))
                    row.ineligible_reasons.push('missing_metrics');
                row.setting_checks = measured.flatMap(p => [...qualityFor(source.config ?? {}), ...materialFor(source.config ?? {})].map(key => ({ plate: p.plate, ...checkBlockValue(candidate.config ?? {}, p.block ?? {}, key, [...materialKeys, ...optionalMaterialKeys].includes(key) ? 'filament' : 'process') })));
                if (row.setting_checks.some((c) => c.ok !== true))
                    row.ineligible_reasons.push('settings_not_verified_in_gcode');
                if (!row.ineligible_reasons.includes('missing_metrics')) {
                    row.time_s = measured.reduce((sum, p) => sum + p.time_s, 0);
                    row.weight_g = measured.reduce((sum, p) => sum + p.weight_g, 0);
                }
                if ((row.time_s !== null && !Number.isFinite(row.time_s)) || (row.weight_g !== null && !Number.isFinite(row.weight_g))) {
                    row.ineligible_reasons.push('nonfinite_aggregate_metrics');
                    row.time_s = null;
                    row.weight_g = null;
                }
                if (row.time_s !== null && row.weight_g !== null) {
                    row.material_cost = price === undefined ? null : row.weight_g / 1000 * price;
                    row.energy_cost = energyRequested ? row.time_s / 3600 * printer.power_w / 1000 * electricity : null;
                    row.machine_cost = printer.machine_hourly_cost === undefined ? null : row.time_s / 3600 * printer.machine_hourly_cost;
                    row.total_cost = price === undefined ? null : row.material_cost + (row.energy_cost ?? 0) + (row.machine_cost ?? 0);
                }
                if (['material_cost', 'energy_cost', 'machine_cost', 'total_cost'].some(key => row[key] !== null && !Number.isFinite(row[key]))) {
                    row.ineligible_reasons.push('nonfinite_cost_estimate');
                    row.material_cost = null;
                    row.energy_cost = null;
                    row.machine_cost = null;
                    row.total_cost = null;
                }
                row.effective_scope = { status: scopeReasons.length ? 'unverified' : 'global_settings_verified', reasons: scopeReasons, description: 'Saved global settings and complete CONFIG_BLOCK checks; physical quality is not observed.' };
                row.ineligible_reasons.push(...scopeReasons);
                row.eligible = row.ineligible_reasons.length === 0;
                if (row.eligible) {
                    active();
                    if (!output) {
                        await fs.mkdir(deps.outputDir, { recursive: true });
                        output = await fs.mkdtemp(path.join(path.resolve(deps.outputDir), 'printer-comparison-'));
                    }
                    row.output_path = path.join(output, `printer-${i + 1}.3mf`);
                    await fs.copyFile(written.path, row.output_path, fs.constants.COPYFILE_EXCL);
                    active();
                }
            }
            catch (error) {
                if (error instanceof Stop) {
                    stop = error.reason;
                    row.ineligible_reasons.push(stop);
                    break;
                }
                active();
                row.ineligible_reasons.push('model_failed');
                row.error = error.message;
            }
        }
        if (stop === 'done')
            active();
        const after = hash(await readBoundedPrintFile(sourcePath));
        if (before !== after)
            throw Error('Source changed during printer comparison');
        active();
        if (stop === 'cancelled' || stop === 'budget_minutes') {
            if (output) {
                await fs.rm(output, { recursive: true, force: true });
                output = undefined;
            }
            for (const row of rows) {
                row.output_path = null;
                row.eligible = false;
                if (!row.ineligible_reasons.includes(stop))
                    row.ineligible_reasons.push(stop);
            }
        }
        const both = rows.every(r => r.eligible), rank = (key) => {
            if (!both || rows.some(r => typeof r[key] !== 'number' || !Number.isFinite(r[key])))
                return null;
            const [a, b] = rows.map(r => r[key]), best = Math.min(a, b);
            if (Math.abs(a - b) <= Math.max(best, 1e-12) * .03)
                return null;
            return rows[a < b ? 0 : 1].bambu_model;
        };
        const fastest = rank('time_s'), leastMaterial = rank('weight_g'), cheapest = rank('total_cost');
        const costKnown = rows.every(r => r.total_cost !== null), scope = costKnown ? 'time_and_provided_operating_costs' : 'time_and_material';
        let winner = null, reason = 'insufficient_comparable_evidence';
        if (both) {
            if (objective === 'time')
                winner = fastest;
            else if (objective === 'material')
                winner = leastMaterial;
            else if (objective === 'cost')
                winner = cheapest;
            else {
                const second = costKnown ? 'total_cost' : 'weight_g';
                const reference = (key) => { const positive = rows.map(r => r[key]).filter(v => v > 0); return positive.length ? Math.min(...positive) : 1; };
                const timeReference = reference('time_s'), secondReference = reference(second);
                const scores = rows.map(r => (r.time_s / timeReference + r[second] / secondReference) / 2), best = Math.min(...scores);
                winner = Math.abs(scores[0] - scores[1]) <= Math.max(best, 1e-12) * .03 ? null : rows[scores[0] < scores[1] ? 0 : 1].bambu_model;
            }
            reason = winner ? 'estimated_advantage' : objective === 'cost' && !costKnown ? 'unknown_cost_rates' : 'tie_within_3_percent_or_zero_reference';
        }
        const report = { tool: 'compare_slice_scenarios', mode: 'printer_models', source: { path: sourcePath, sha256_before: before, sha256_after: after, unchanged: true }, printers: rows, slices, max_slices: max, stop_reason: stop, currency, fastest, least_material: leastMaterial, cheapest, recommendation: { bambu_model: winner, objective, scope: objective === 'balanced' ? scope : objective, reason }, cost_scope: { material: price !== undefined, energy: energyRequested, machine_time: printers.every(p => p.machine_hourly_cost !== undefined), description: 'Print operating costs from supplied rates only; excluded components are unknown, not measured zero. No printer purchase ROI.' }, warnings: ['Tempo, material e custos são estimativas de fatiamento; revise os projetos no Bambu Studio. Nenhuma impressão física foi observada.', 'A recomendação exige configurações verificadas; consulte ineligible_reasons de cada modelo. Custos não incluem aquisição da impressora, falhas ou manutenção não informada.'] };
        if (output)
            await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
        active();
        return report;
    }
    catch (error) {
        if (output)
            await fs.rm(output, { recursive: true, force: true });
        if (error instanceof Stop || deps.signal?.aborted || controller.signal.aborted) {
            const reason = deps.signal?.aborted ? 'cancelled' : error instanceof Stop ? error.reason : 'budget_minutes';
            return { tool: 'compare_slice_scenarios', mode: 'printer_models', printers: rows.map(r => ({ ...r, eligible: false, output_path: null, ineligible_reasons: [...r.ineligible_reasons, reason] })), slices, stop_reason: reason, fastest: null, least_material: null, cheapest: null, recommendation: { bambu_model: null, reason } };
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
        deps.signal?.removeEventListener('abort', abort);
        if (scratch)
            await fs.rm(scratch, { recursive: true, force: true });
    }
}
