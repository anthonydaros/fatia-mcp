import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readBoundedPrintFile } from '../safety/archive.js';
import { buildItems } from './scoped-settings.js';
import { asArray, meta, plateInstances } from '../knowledge/facts/settings.js';
import { openProject } from '../knowledge/facts/settings.js';
import { writeTunedProject } from '../tuning/project-writer.js';
import { checkBlockValue } from '../tuning/config-block.js';
import { sliceFacts } from '../tuning/slice-facts.js';
import { PROCESS_SETTING_PROPERTIES, parseProcessSettings } from './settings-registry.js';
export const OBJECT_SETTINGS_PROPERTY = { type: 'array', maxItems: 500, description: 'Per-object process settings selected by global build-item indices. Shared objects require all their instances.', items: { type: 'object', additionalProperties: false, required: ['item_indices', 'settings'], properties: { item_indices: { type: 'array', minItems: 1, maxItems: 500, uniqueItems: true, items: { type: 'integer', minimum: 0 } }, settings: { type: 'object', additionalProperties: false, properties: PROCESS_SETTING_PROPERTIES } } } };
export function parseObjectSettings(raw) {
    if (raw === undefined)
        return [];
    if (!Array.isArray(raw) || raw.length > 500)
        throw Error('object_settings must contain at most500 groups');
    const used = new Set();
    return raw.map(group => { if (!group || typeof group !== 'object' || !Array.isArray(group.item_indices) || !group.item_indices.length || group.item_indices.length > 500 || new Set(group.item_indices).size !== group.item_indices.length || group.item_indices.some((i) => !Number.isInteger(i) || i < 0 || used.has(i)))
        throw Error('Invalid or overlapping item_indices'); for (const i of group.item_indices)
        used.add(i); return { itemIndices: group.item_indices, settings: Object.fromEntries(parseProcessSettings(group.settings).map(c => [c.key, String(c.value)])) }; });
}
export const SCENARIO_TOOLS = [{ name: 'compare_slice_scenarios', description: 'Compare up to six process-setting variants of an existing 3MF project for the selected printer. Preserves the original, counts all slice attempts, saves unsliced candidates for GUI review. Time/material are estimates; no quality or strength guarantee. Use prepare_print_project first for STL or another printer.', inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'scenarios'], properties: {
                path: { description: 'Existing printer-compatible 3MF project; STL must be prepared first.', type: 'string', minLength: 1 }, bambu_model: { description: 'Printer model such as p1s or x2d; falls back to BAMBU_MODEL or asks.', type: 'string' }, plate_index: { description: 'Zero-based plate to slice in each scenario.', type: 'integer', minimum: 0, maximum: 999 }, max_slices: { description: 'Maximum CLI attempts in total, including failed attempts.', type: 'integer', minimum: 1, maximum: 6, default: 6 }, max_minutes: { description: 'Total wall-clock budget in minutes, including writing and slicing.', type: 'number', minimum: .1, maximum: 60, default: 10 },
                scenarios: { description: 'One to six named process variants; use empty settings for the baseline.', type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['name', 'settings'], properties: { object_settings: OBJECT_SETTINGS_PROPERTY, layer_height_policy: { type: 'string', enum: ['preserve', 'uniform'], description: 'Preserve authored per-object/height profiles by default. Uniform removes only selected conflicts and requires G-code verification.' }, name: { type: 'string', minLength: 1, maxLength: 80 }, settings: { type: 'object', additionalProperties: false, properties: PROCESS_SETTING_PROPERTIES } } } },
            } } }];
function verifyObjectSettings(groups, project, items, plate, outcome, uniform) {
    const counts = new Map();
    const instances = items.map(item => { const instance = counts.get(item.objectId) ?? 0; counts.set(item.objectId, instance + 1); return { ...item, instance }; });
    const node = asArray(project.modelSettings?.plate).find(p => Number(meta(p, 'plater_id')) === plate + 1), members = asArray(node?.model_instance);
    const targetIndices = instances.flatMap((item, index) => members.some(m => String(meta(m, 'object_id')) === item.objectId && Number(meta(m, 'instance_id') ?? 0) === item.instance) ? [index] : []);
    const requestedIndices = new Set(groups.flatMap(g => g.itemIndices));
    const coversPlate = targetIndices.length > 0 && targetIndices.every(i => requestedIndices.has(i));
    const labelCounts = new Map();
    for (const member of members) {
        const label = String(meta(member, 'identify_id') ?? '');
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    return groups.map(group => {
        const observations = group.itemIndices.map(index => { const target = instances[index]; const member = members.find(m => String(meta(m, 'object_id')) === target?.objectId && Number(meta(m, 'instance_id') ?? 0) === target?.instance); const label = String(meta(member, 'identify_id') ?? ''); return labelCounts.get(label) === 1 ? outcome.gcode.details?.objectObservations?.[label] : undefined; });
        const verified = outcome.gcode.complete && group.itemIndices.length > 0 && Object.entries(group.settings).every(([key, value]) => {
            const number = Number(value), global = outcome.gcode.details?.layerHeights?.all;
            if (key === 'layer_height') {
                const proves = (o) => o?.complete && o.layer_heights_complete && Math.abs((o.min_layer_height_mm ?? NaN) - number) < 1e-5 && Math.abs((o.max_layer_height_mm ?? NaN) - number) < 1e-5;
                if (observations.some(o => o !== undefined && !proves(o)))
                    return false;
                if (observations.every(proves))
                    return true;
                return uniform && coversPlate && global?.complete === true && Math.abs((global.min_mm ?? NaN) - number) < 1e-5 && Math.abs((global.max_mm ?? NaN) - number) < 1e-5;
            }
            const names = { outer_wall_speed: 'outer_wall_speed_max_mm_s', inner_wall_speed: 'inner_wall_speed_max_mm_s', outer_wall_acceleration: 'outer_wall_acceleration_max_mm_s2', inner_wall_acceleration: 'inner_wall_acceleration_max_mm_s2' };
            const field = names[key];
            return !!field && number > 0 && observations.every(o => o?.complete && typeof o[field] === 'number' && o[field] <= number + 1e-3);
        });
        return { item_indices: group.itemIndices, requested: group.settings, verified_in_project: true, verified_in_gcode: verified, verification_method: 'Observed object-labelled extrusion speed/acceleration caps and layer heights; unsupported setting families remain unverified.', observations };
    });
}
function uniformRequest(scenario) {
    const own = scenario.objects.filter(g => g.settings.layer_height !== undefined);
    const global = scenario.changes.find(c => c.key === 'layer_height');
    if (own.length) {
        const heights = new Set(own.map(g => g.settings.layer_height));
        if (heights.size !== 1 || global)
            throw Error('Uniform scope requires one layer height, either global or per-object');
        return { height: own[0].settings.layer_height, itemIndices: own.flatMap(g => g.itemIndices) };
    }
    if (!global)
        throw Error('Uniform layer policy requires an explicit layer_height');
    return { height: String(global.value) };
}
function uniformVerified(outcome, request, objectChecks) {
    if (request.itemIndices?.length)
        return objectChecks.length > 0 && objectChecks.every(c => c.verified_in_gcode);
    const evidence = outcome.gcode.details?.layerHeights;
    if (!evidence || !outcome.gcode.complete)
        return false;
    const global = evidence.all;
    if (global?.complete === true && Math.abs(global.min_mm - Number(request.height)) < 1e-5 && Math.abs(global.max_mm - Number(request.height)) < 1e-5)
        return true;
    const rows = request.itemIndices?.map(i => evidence.objects?.[i]) ?? [global];
    return rows.length > 0 && rows.every(row => row && row.complete === true && Math.abs(row.min_mm - Number(request.height)) < 1e-5 && Math.abs(row.max_mm - Number(request.height)) < 1e-5);
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
        if (s.layer_height_policy !== undefined && !['preserve', 'uniform'].includes(s.layer_height_policy))
            throw Error('Invalid layer_height_policy');
        return { name: s.name, changes: parseProcessSettings(s.settings), objects: parseObjectSettings(s.object_settings), policy: s.layer_height_policy ?? 'preserve' };
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
    let selectedBuildItems = [];
    for (const scenario of scenarios) {
        if (scenario.policy === 'uniform')
            uniformRequest(scenario);
        if (scenario.objects.length) {
            const { loadSafe3mfArchive } = await import('../safety/archive.js');
            const items = selectedBuildItems.length ? selectedBuildItems : await buildItems(await loadSafe3mfArchive(await readBoundedPrintFile(args.path)));
            selectedBuildItems = items;
            const members = plateInstances(source.modelSettings, plate), counts = new Map();
            for (const [index, item] of items.entries()) {
                const instance = counts.get(item.objectId) ?? 0;
                counts.set(item.objectId, instance + 1);
                if (scenario.objects.some(g => g.itemIndices.includes(index)) && !members?.includes(`${item.objectId}:${instance}`))
                    throw Error('Per-object scenario targets must belong to the selected plate');
            }
        }
    }
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
                const written = await writeTunedProject({ source: args.path, output: path.join(work, `candidate-${i}.3mf`), target: { printerPreset: deps.printerPreset }, changes: scenario.changes, objectSettings: scenario.objects, ...(scenario.policy === 'uniform' ? { uniformLayerHeight: uniformRequest(scenario) } : {}) });
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
                record.layer_height_policy = scenario.policy;
                record.object_settings = scenario.objects;
                record.layer_profiles_present = !!(await candidate.read?.('Metadata/layer_heights_profile.txt'))?.toString().trim();
                const objectChecks = verifyObjectSettings(scenario.objects, candidate, selectedBuildItems, plate, outcome, scenario.policy === 'uniform');
                record.object_setting_checks = objectChecks;
                const uniformProof = scenario.policy !== 'uniform' || uniformVerified(outcome, uniformRequest(scenario), objectChecks);
                record.uniform_height_verified = scenario.policy === 'uniform' ? uniformProof : null;
                record.gcode_complete = outcome.gcode.complete;
                record.metrics = outcome.gcode.facts;
                record.comparable = outcome.gcode.complete && reach.every(r => r.ok === true) && uniformProof && objectChecks.every(c => c.verified_in_gcode);
                if (objectChecks.some(c => !c.verified_in_gcode))
                    record.blind.push('Per-object effective settings are not exposed by this G-code scan; comparison is excluded from ranking');
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
