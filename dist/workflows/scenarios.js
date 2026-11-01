import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readBoundedPrintFile } from '../safety/archive.js';
import { openProject } from '../knowledge/facts/settings.js';
import { writeTunedProject } from '../tuning/project-writer.js';
import { checkBlockValue } from '../tuning/config-block.js';
import { sliceFacts } from '../tuning/slice-facts.js';
const numeric = { layer_height: [.05, .6], wall_loops: [1, 100, true], top_shell_layers: [0, 100, true], bottom_shell_layers: [0, 100, true], sparse_infill_density: [0, 100], brim_width: [0, 50], support_threshold_angle: [0, 90] };
const choices = { sparse_infill_pattern: ['grid', 'gyroid', 'rectilinear', 'honeycomb', 'line', 'cubic', 'adaptivecubic', 'supportcubic', 'lightning', '3dhoneycomb', 'triangles', 'tri-hexagon', 'concentric', 'crosshatch'], support_type: ['normal(auto)', 'tree(auto)', 'normal(manual)', 'tree(manual)'], brim_type: ['auto_brim', 'outer_only', 'inner_only', 'outer_and_inner', 'no_brim'], seam_position: ['nearest', 'aligned', 'back', 'random'], ironing_type: ['no ironing', 'top', 'topmost', 'all solid layer'] };
const settingProperties = Object.fromEntries([...Object.keys(numeric).map(k => [k, { type: ['number', 'string'] }]), ...Object.entries(choices).map(([k, values]) => [k, { type: 'string', enum: values }]), ['enable_support', { type: ['boolean', 'string', 'number'] }]]);
export const SCENARIO_TOOLS = [{ name: 'compare_slice_scenarios', description: 'Compare up to six process-setting variants of an existing 3MF project for the selected printer. Preserves the original, counts all slice attempts, saves unsliced candidates for GUI review. Time/material are estimates; no quality or strength guarantee. Use prepare_print_project first for STL or another printer.', inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'scenarios'], properties: {
                path: { description: 'Existing printer-compatible 3MF project; STL must be prepared first.', type: 'string', minLength: 1 }, bambu_model: { description: 'Printer model such as p1s or x2d; falls back to BAMBU_MODEL or asks.', type: 'string' }, plate_index: { description: 'Zero-based plate to slice in each scenario.', type: 'integer', minimum: 0, maximum: 999 }, max_slices: { description: 'Maximum CLI attempts in total, including failed attempts.', type: 'integer', minimum: 1, maximum: 6, default: 6 }, max_minutes: { description: 'Total wall-clock budget in minutes, including writing and slicing.', type: 'number', minimum: .1, maximum: 60, default: 10 },
                scenarios: { description: 'One to six named process variants; use empty settings for the baseline.', type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['name', 'settings'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, settings: { type: 'object', additionalProperties: false, properties: settingProperties } } } },
            } } }];
function settings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('settings must be an object');
    return Object.entries(value).map(([key, raw]) => {
        let value;
        if (key in numeric) {
            const [min, max, int] = numeric[key];
            if (!['string', 'number'].includes(typeof raw) || String(raw).trim() === '')
                throw Error(`${key} setting must be finite`);
            const n = Number(String(raw).replace(/%$/, ''));
            if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n)))
                throw Error(`Invalid ${key} setting: expected ${min}..${max}`);
            value = String(n) + (key === 'sparse_infill_density' ? '%' : '');
        }
        else if (key === 'enable_support') {
            if (![true, false, 0, 1, '0', '1'].includes(raw))
                throw Error('enable_support setting must be boolean or 0/1');
            value = raw === true || raw === 1 || raw === '1' ? '1' : '0';
        }
        else if (key in choices && typeof raw === 'string' && choices[key].includes(raw))
            value = raw;
        else
            throw Error(`Unsupported setting ${key}`);
        return { key, value, scope: 'process' };
    });
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export async function compareSliceScenarios(args, deps) {
    if (typeof args.path !== 'string' || !args.path.toLowerCase().endsWith('.3mf'))
        throw Error('path must be an existing printer-compatible 3MF project; prepare STL/other-printer projects first');
    if (!Array.isArray(args.scenarios) || args.scenarios.length < 1 || args.scenarios.length > 6)
        throw Error('scenarios must contain 1..6 variants');
    const scenarios = args.scenarios.map((s) => {
        if (!s || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 80)
            throw Error('scenario name must contain 1..80 characters');
        return { name: s.name, changes: settings(s.settings) };
    });
    if (new Set(scenarios.map(s => s.name)).size !== scenarios.length)
        throw Error('scenario names must be unique');
    const max = args.max_slices ?? 6, minutes = args.max_minutes ?? 10, plate = args.plate_index ?? 0;
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 6)
        throw Error('max_slices must be 1..6');
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < .1 || minutes > 60)
        throw Error('max_minutes must be .1..60');
    if (typeof plate !== 'number' || !Number.isInteger(plate) || plate < 0 || plate > 999)
        throw Error('plate_index must be 0..999');
    const now = deps.now ?? Date.now, started = now();
    let slices = 0, stop = 'done';
    const before = sha(await readBoundedPrintFile(args.path));
    const source = await openProject(args.path);
    if (source.config?.printer_settings_id !== deps.printerPreset)
        throw Error('Project must already match the selected printer; run prepare_print_project first');
    await fs.mkdir(deps.tempDir, { recursive: true });
    await fs.mkdir(deps.outputDir, { recursive: true });
    const work = await fs.mkdtemp(path.join(path.resolve(deps.tempDir), 'compare-'));
    const delivered = await fs.mkdtemp(path.join(path.resolve(deps.outputDir), 'scenarios-'));
    const controller = new AbortController();
    const abort = () => controller.abort(deps.signal?.reason);
    deps.signal?.addEventListener('abort', abort, { once: true });
    if (deps.signal?.aborted)
        abort();
    const timer = setTimeout(() => controller.abort(Error('Scenario time budget exhausted')), minutes * 60000);
    timer.unref();
    const records = [];
    const stopped = () => deps.signal?.aborted ? 'cancelled' : controller.signal.aborted || now() - started >= minutes * 60000 ? 'budget_minutes' : slices >= max ? 'budget_slices' : undefined;
    try {
        for (let i = 0; i < scenarios.length; i++) {
            const scenario = scenarios[i], record = { scenario_id: i, name: scenario.name, status: 'not_run', settings: Object.fromEntries(scenario.changes.map(c => [c.key, c.value])), time_s: null, weight_g: null };
            records.push(record);
            const why = stopped();
            if (why) {
                stop = why;
                continue;
            }
            try {
                const written = await writeTunedProject({ source: args.path, output: path.join(work, `candidate-${i}.3mf`), target: { printerPreset: deps.printerPreset }, changes: scenario.changes });
                const beforeSlice = stopped();
                if (beforeSlice) {
                    stop = beforeSlice;
                    continue;
                }
                slices++;
                const outcome = await deps.slice(written.path, controller.signal, plate);
                // Reaching the slice budget is fine after its last permitted completed call.
                if (deps.signal?.aborted || controller.signal.aborted || now() - started >= minutes * 60000) {
                    stop = deps.signal?.aborted ? 'cancelled' : 'budget_minutes';
                    continue;
                }
                const facts = sliceFacts({ ...outcome.slice, gcode: outcome.gcode, plateIndex: plate });
                const candidate = await openProject(written.path);
                const reach = scenario.changes.map(c => checkBlockValue(candidate.config ?? {}, outcome.block ?? {}, c.key, 'process'));
                record.status = 'measured';
                record.time_s = facts.facts['plate.time_s'] ?? null;
                record.weight_g = facts.facts['plate.weight_g'] ?? null;
                record.evidence = facts.evidence;
                record.blind = facts.blind;
                record.setting_checks = reach;
                record.gcode_complete = outcome.gcode.complete;
                record.metrics = outcome.gcode.facts;
                record.comparable = outcome.gcode.complete && reach.every(r => r.ok === true);
                record.warnings = [...written.warnings, ...(record.comparable ? [] : ['Settings or G-code analysis are unverified; excluded from ranking.'])];
                const target = path.join(delivered, `scenario-${i}.3mf`);
                await fs.copyFile(written.path, target, fs.constants.COPYFILE_EXCL);
                record.output_path = target;
            }
            catch (error) {
                if (deps.signal?.aborted || controller.signal.aborted) {
                    stop = deps.signal?.aborted ? 'cancelled' : 'budget_minutes';
                    continue;
                }
                record.status = 'error';
                record.error = error instanceof Error ? error.message : String(error);
            }
        }
        const after = sha(await readBoundedPrintFile(args.path));
        if (before !== after)
            throw Error('Source project changed during comparison');
        if (deps.signal?.aborted || controller.signal.aborted) {
            stop = deps.signal?.aborted ? 'cancelled' : 'budget_minutes';
        }
        if (stop === 'cancelled') {
            await fs.rm(delivered, { recursive: true, force: true });
            for (const r of records) {
                delete r.output_path;
                r.artifacts_removed = true;
            }
        }
        else if (!records.some(r => r.output_path))
            await fs.rm(delivered, { recursive: true, force: true });
        const winner = (key) => { const rows = records.filter(r => r.status === 'measured' && r.comparable && typeof r[key] === 'number' && Number.isFinite(r[key])); return rows.length ? rows.reduce((a, b) => a[key] <= b[key] ? a : b).scenario_id : null; };
        return { stop_reason: stop, slices, max_slices: max, minutes: (now() - started) / 60000, plate_index: plate, scenarios: records, fastest: stop === 'cancelled' ? null : winner('time_s'), least_material: stop === 'cancelled' ? null : winner('weight_g'), source_sha256: { before, after }, notes: ['Candidates are unsliced projects for review in Bambu Studio.', 'Time and material are slicer estimates; quality, fit and strength require physical testing.'] };
    }
    catch (error) {
        await fs.rm(delivered, { recursive: true, force: true });
        throw error;
    }
    finally {
        clearTimeout(timer);
        deps.signal?.removeEventListener('abort', abort);
        await fs.rm(work, { recursive: true, force: true });
    }
}
