import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { openProject, asArray, meta } from '../knowledge/facts/settings.js';
import { readBoundedPrintFile } from '../safety/archive.js';
import { parseProcessSettings } from '../workflows/settings-registry.js';
import { orientationRotations, writeOrientationCandidate } from '../workflows/orientations.js';
import { checkBlockValue } from './config-block.js';
import { writeTunedProject } from './project-writer.js';
import { runLayoutStage } from './layout-stage.js';
import { readLayoutModel } from './layout.js';
import { factBlockers } from './prepare.js';
import { parsePartContext } from './part-context.js';
import { parseOptimizationOptions } from './optimization-options.js';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const numbers = (v) => { const a = Array.isArray(v) ? v : [v]; const n = a.map(x => typeof x === 'string' && x.trim() ? Number(x.replace(/%$/, '')) : typeof x === 'number' ? x : NaN); return n.length && n.every(Number.isFinite) ? n : undefined; };
const protectedKeys = { wall_loops: { bound: 'min_wall_loops', minimum: true }, sparse_infill_density: { bound: 'min_infill_density', minimum: true }, skeleton_infill_density: { bound: 'min_infill_density', minimum: true }, skin_infill_density: { bound: 'min_infill_density', minimum: true }, top_shell_layers: { bound: 'min_top_shell_layers', minimum: true }, bottom_shell_layers: { bound: 'min_bottom_shell_layers', minimum: true }, layer_height: { bound: 'max_layer_height', minimum: false }, outer_wall_speed: { bound: 'max_outer_wall_speed', minimum: false }, outer_wall_acceleration: { bound: 'max_outer_wall_acceleration', minimum: false } };
function violations(config, original, options) {
    const out = [];
    for (const [key, { bound, minimum }] of Object.entries(protectedKeys)) {
        const before = numbers(original[key]), after = numbers(config[key]), explicit = options.constraints[bound];
        if (original[key] === undefined && config[key] === undefined)
            continue;
        if (!after || (!before && explicit === undefined)) {
            if (JSON.stringify(config[key]) !== JSON.stringify(original[key]))
                out.push(`${key}: unknown original or candidate bound`);
            continue;
        }
        const bounds = explicit === undefined ? before : after.map(() => explicit);
        if (bounds.length !== after.length && bounds.length !== 1) {
            out.push(`${key}: original vector cannot be mapped`);
            continue;
        }
        if (after.some((v, i) => minimum ? v < (bounds[i] ?? bounds[0]) - 1e-9 : v > (bounds[i] ?? bounds[0]) + 1e-9))
            out.push(`${key}: violates ${explicit === undefined ? 'original setting' : bound}`);
    }
    return out;
}
class BudgetStop extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
export async function optimizeProject(input, deps) {
    const options = parseOptimizationOptions(input.optimization);
    const declared = parsePartContext(input.partContext);
    if (input.selectRound !== undefined)
        throw Error('select_round refers to tuning rounds and cannot be combined with optimization');
    if (!Number.isInteger(input.maxSlices) || input.maxSlices < 2 || input.maxSlices > 50 || !Number.isFinite(input.maxMinutes) || input.maxMinutes < 1 || input.maxMinutes > 240)
        throw Error('Invalid optimization slice/time budget');
    if (input.outputName !== undefined && (!input.outputName.trim() || /[\\/\0]/.test(input.outputName)))
        throw Error('output_name must be a filename');
    const source = path.resolve(input.path);
    if (!/\.(3mf|stl)$/i.test(source))
        throw Error('optimization requires STL or3MF');
    input.signal?.throwIfAborted();
    const before = sha(await readBoundedPrintFile(source)), now = deps.now ?? Date.now, started = now();
    const controller = new AbortController(), abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted)
        abort();
    const timer = setTimeout(() => controller.abort(new BudgetStop('budget_minutes')), input.maxMinutes * 60000);
    timer.unref();
    let slices = 0, step = 0, stop = 'done';
    const reason = () => input.signal?.aborted ? 'cancelled' : controller.signal.aborted || now() - started >= input.maxMinutes * 60000 ? 'budget_minutes' : undefined;
    const active = () => {
        const r = reason();
        if (r)
            throw new BudgetStop(r);
    };
    const reserve = () => {
        active();
        if (input.dryRun)
            throw new BudgetStop('dry_run');
        if (slices >= input.maxSlices)
            throw new BudgetStop('budget_slices');
        slices++;
        input.onProgress?.({ step: ++step, slices, max: input.maxSlices, message: `Otimização: fatiamento ${slices}/${input.maxSlices}` });
    };
    const records = [];
    let openedInStudio = false;
    let selected, work, output, layout;
    const warnings = [];
    const protectedProfiles = new Map();
    const profileNames = ['Metadata/layer_heights_profile.txt', 'Metadata/layer_config_ranges.xml'];
    let installed = null;
    const cache = new Map();
    const all = async (file, signal) => {
        active();
        if (!deps.sliceAll)
            throw Error('Whole-project optimization requires the all-plates slicer');
        const key = sha(await readBoundedPrintFile(file)) + JSON.stringify([deps.printerPreset, installed]);
        if (cache.has(key))
            return cache.get(key);
        reserve();
        const result = await deps.sliceAll(file, controller.signal);
        active();
        cache.set(key, result);
        return result;
    };
    const expected = async (file) => {
        const p = await openProject(file), ps = asArray(p.modelSettings?.plate).filter(p => asArray(p.model_instance).length > 0).map(p => Number(meta(p, 'plater_id')));
        if (!ps.length || ps.some(v => !Number.isInteger(v) || v < 1) || new Set(ps).size !== ps.length)
            throw Error('Whole-project optimization requires reliable populated plate membership');
        return { project: p, plates: ps.sort((a, b) => a - b) };
    };
    const evaluate = async (record, base) => {
        records.push(record);
        try {
            active();
            const { project, plates } = await expected(record.path);
            for (const name of profileNames) {
                const bytes = await project.read?.(name);
                if ((bytes?.toString('utf8').trim() ?? '') !== (protectedProfiles.get(name) ?? ''))
                    record.ineligible_reasons.push(`layer_profile_changed: ${name}`);
            }
            record.ineligible_reasons.push(...violations(project.config ?? {}, base, options));
            if (record.ineligible_reasons.length && record.kind !== 'baseline') {
                record.status = 'rejected';
                return;
            }
            const measured = await all(record.path);
            active();
            record.status = 'measured';
            record.plates = measured;
            const ids = measured.map(m => m.plate);
            if (ids.length !== plates.length || new Set(ids).size !== ids.length || plates.some(p => !ids.includes(p)))
                record.ineligible_reasons.push('incomplete_plate_coverage');
            if (measured.some(m => m.gcode_complete !== true))
                record.ineligible_reasons.push('incomplete_or_unverified_gcode');
            if (measured.some(m => m.time_s === null || !Number.isFinite(m.time_s) || m.time_s < 0 || m.weight_g === null || !Number.isFinite(m.weight_g) || m.weight_g < 0))
                record.ineligible_reasons.push('missing_metrics');
            const verifiedKeys = [...new Set([...record.changes.map(c => c.key), ...Object.keys(protectedKeys).filter(k => project.config?.[k] !== undefined)])];
            const checks = measured.flatMap(m => verifiedKeys.map(key => ({ plate: m.plate, ...checkBlockValue(project.config ?? {}, m.block ?? {}, key, 'process') })));
            record.checks = checks;
            if (checks.some(c => c.ok !== true))
                record.ineligible_reasons.push('settings_not_verified_in_gcode');
            record.blockers = [];
            record.blockers_unknown = [];
            record.preflight = [];
            for (const plate of measured) {
                active();
                const judged = factBlockers(plate.metrics ?? {}, input.model);
                record.blockers.push(...judged.hits);
                record.blockers_unknown.push(...judged.unknown);
                const check = await deps.preflight({ file_path: record.path, bambu_model: input.model, plate_index: plate.plate - 1, min_severity: 'blocker', checks: { mesh: 'fast' }, context: { ...(declared.kind ? { object_kind: declared.kind } : {}), ...(['rigid', 'silicone'].includes(declared.mold_kind ?? '') ? { mold_kind: declared.mold_kind } : {}) } }, controller.signal);
                active();
                record.preflight.push(check);
                if (!Array.isArray(check.findings))
                    record.ineligible_reasons.push('preflight_unverified');
                else
                    record.blockers.push(...check.findings.filter((r) => r.severity === 'blocker'));
                const errors = check.analysis?.errors;
                if (Array.isArray(errors) && errors.length)
                    record.ineligible_reasons.push('geometry_analysis_incomplete');
            }
            if (record.blockers.length)
                record.ineligible_reasons.push('known_blocker');
            if (!record.ineligible_reasons.includes('missing_metrics')) {
                record.time_s = measured.reduce((a, m) => a + m.time_s, 0);
                record.weight_g = measured.reduce((a, m) => a + m.weight_g, 0);
            }
            record.eligible = record.ineligible_reasons.length === 0;
        }
        catch (e) {
            if (e instanceof BudgetStop)
                throw e;
            active();
            record.status = 'error';
            record.error = e.message;
            record.ineligible_reasons.push('candidate_error');
        }
    };
    const fresh = (id, name, kind, file, changes = []) => ({ id, name, kind, path: file, changes, status: 'not_run', eligible: false, ineligible_reasons: [], time_s: null, weight_g: null });
    try {
        await fs.mkdir(deps.tempDir, { recursive: true });
        work = await fs.mkdtemp(path.join(path.resolve(deps.tempDir), 'optimize-'));
        installed = await deps.installedStudio();
        active();
        const sourceProject = source.toLowerCase().endsWith('.3mf') ? await openProject(source) : undefined;
        if (sourceProject)
            for (const name of profileNames) {
                const bytes = await sourceProject.read?.(name);
                if (bytes)
                    protectedProfiles.set(name, bytes.toString('utf8').trim());
            }
        const retarget = deps.retarget ? async (file) => {
            let count = 0;
            const out = await deps.retarget(file, { beforeSlice: () => { reserve(); count++; }, signal: controller.signal });
            active();
            if ((out.slices ?? 0) !== count)
                throw Error('Retargeter did not account for slices through the global budget');
            return out;
        } : undefined;
        const written = await writeTunedProject({ source, output: path.join(work, 'baseline.3mf'), target: { printerPreset: deps.printerPreset }, changes: [], retarget });
        const p0 = await openProject(written.path), original = sourceProject?.config ?? p0.config ?? {};
        if (!sourceProject)
            for (const name of profileNames) {
                const bytes = await p0.read?.(name);
                if (bytes)
                    protectedProfiles.set(name, bytes.toString('utf8').trim());
            }
        if (input.dryRun) {
            stop = 'dry_run';
            await fs.rm(work, { recursive: true, force: true });
            work = undefined;
            return { tool: 'prepare_print_project', verdict: 'ready_with_caveats', delivered: null, optimization: { objective: options.objective, status: 'dry_run', constraints: options.constraints, allow_reorientation: options.allow_reorientation }, stop: { reason: stop, slices }, resumo: 'Plano de otimização: nenhum fatiamento executado e nenhum arquivo entregue.' };
        }
        await evaluate(fresh('baseline', 'Projeto original retargetado', 'baseline', written.path), original);
        const authoredTargets = options.allow_reorientation ? await Promise.all(options.targets.map(async (target) => {
            const model = await readLayoutModel(p0);
            const item = model.objects.find(o => o.itemIndex === target.item_index && o.plates.includes(target.plate_index));
            if (!item || item.plates.length !== 1)
                throw Error('Orientation target has no unique authored instance');
            return { ...target, key: item.key };
        })) : [];
        let searchSource = written.path;
        if ((input.layout?.mode ?? 'auto') !== 'off') {
            try {
                const result = await runLayoutStage({ p0: written.path, sourceConfig: sourceProject?.config, mode: input.layout?.mode ?? 'auto', dryRun: false, gapMm: input.layout?.gapMm, marginMm: input.layout?.marginMm, maxSlices: Math.max(1, Math.min(input.layout?.maxSlices ?? 6, input.maxSlices - slices)), maxMinutes: Math.max(.001, Math.min(input.layout?.maxMinutes ?? 12, input.maxMinutes - (now() - started) / 60000)), work, sliceAll: all, now, signal: controller.signal });
                layout = result;
                active();
                if (result.file) {
                    searchSource = result.file;
                    await evaluate(fresh('layout', 'Organização das mesas', 'layout', searchSource), original);
                }
                if (['blocked', 'locked', 'failed'].includes(result.status))
                    warnings.push(`Layout: ${result.status}; ${result.reason ?? 'revisão necessária'}`);
            }
            catch (e) {
                if (e instanceof BudgetStop)
                    throw e;
                active();
                warnings.push(`Layout não aplicado: ${e.message}`);
            }
        }
        const cfg = (await openProject(searchSource)).config ?? {};
        const candidates = options.candidates ?? automatic(cfg, options);
        for (const [i, candidate] of candidates.entries()) {
            active();
            if (slices >= input.maxSlices) {
                stop = 'budget_slices';
                break;
            }
            const changes = parseProcessSettings(candidate.settings);
            const file = await writeTunedProject({ source: searchSource, output: path.join(work, `settings-${i + 1}.3mf`), target: { printerPreset: deps.printerPreset }, changes });
            await evaluate(fresh(`settings-${i + 1}`, candidate.name, 'settings', file.path, changes), original);
        }
        const settingsBest = choose(records, options.objective);
        let geometrySource = searchSource;
        let steps = [];
        if (options.allow_reorientation) {
            for (const authored of authoredTargets) {
                active();
                if (slices >= input.maxSlices) {
                    stop = 'budget_slices';
                    break;
                }
                let target, rotations;
                try {
                    const model = await readLayoutModel(await openProject(geometrySource));
                    const item = model.objects.find(o => o.key === authored.key);
                    if (!item || item.plates.length !== 1)
                        throw Error('Orientation target has no unique current plate');
                    target = { plate_index: item.plates[0], item_index: item.itemIndex };
                    rotations = await orientationRotations(geometrySource, target.plate_index, target.item_index, 'sampled', controller.signal);
                }
                catch (e) {
                    active();
                    warnings.push(`Orientação do item ${authored.item_index} não aplicada: ${e.message}`);
                    continue;
                }
                for (const [i, rotation] of rotations.entries()) {
                    if (i === 0)
                        continue;
                    active();
                    if (slices >= input.maxSlices) {
                        stop = 'budget_slices';
                        break;
                    }
                    const id = `orientation-${target.item_index}-${i}`;
                    try {
                        const file = await writeOrientationCandidate(geometrySource, path.join(work, `${id}.3mf`), { plateIndex: target.plate_index, itemIndex: target.item_index, rotation }, controller.signal);
                        const row = fresh(id, rotation.name, 'orientation', file.path);
                        row.orientation = { steps: [...steps, { ...target, rotation }] };
                        await evaluate(row, original);
                    }
                    catch (e) {
                        if (e instanceof BudgetStop)
                            throw e;
                        active();
                        const row = fresh(id, rotation.name, 'orientation', '');
                        row.status = 'error';
                        row.error = e.message;
                        row.ineligible_reasons.push('orientation_error');
                        records.push(row);
                    }
                }
                const cumulative = choose(records.filter(r => r.kind === 'baseline' || r.kind === 'orientation'), options.objective);
                if (cumulative?.kind === 'orientation') {
                    geometrySource = cumulative.path;
                    steps = cumulative.orientation.steps;
                }
            }
        }
        const orientationBest = choose(records.filter(r => r.kind === 'baseline' || r.kind === 'orientation'), options.objective);
        if (settingsBest?.kind === 'settings' && orientationBest?.kind === 'orientation' && slices < input.maxSlices) {
            const orientationSteps = orientationBest.orientation.steps;
            let combinedSource = settingsBest.path;
            for (const [i, o] of orientationSteps.entries()) {
                active();
                const file = await writeOrientationCandidate(combinedSource, path.join(work, `combined-${i}.3mf`), { plateIndex: o.plate_index, itemIndex: o.item_index, rotation: o.rotation }, controller.signal);
                combinedSource = file.path;
            }
            const row = fresh('combined', 'Configuração e orientações combinadas', 'combined', combinedSource, settingsBest.changes);
            row.orientation = { steps: orientationSteps };
            await evaluate(row, original);
        }
    }
    catch (e) {
        if (e instanceof BudgetStop)
            stop = e.reason;
        else if (reason())
            stop = reason();
        else {
            stop = 'error';
            warnings.push(e.message);
        }
    }
    finally {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
    }
    try {
        const baseline = records.find(r => r.kind === 'baseline');
        selected = choose(records, options.objective);
        if (reason())
            stop = reason();
        if (stop === 'cancelled')
            selected = undefined;
        const after = sha(await readBoundedPrintFile(source));
        if (after !== before)
            throw Error('Source changed during optimization');
        if (selected) {
            active();
            await fs.mkdir(input.outputDir, { recursive: true });
            output = await fs.mkdtemp(path.join(path.resolve(input.outputDir), 'optimized-'));
            await fs.mkdir(path.join(output, 'alternatives'));
            for (const row of records.filter(r => r.eligible)) {
                active();
                const name = row === selected ? (input.outputName ?? 'optimized.3mf') : `${row.id}.3mf`;
                row.output_path = path.join(row === selected ? output : path.join(output, 'alternatives'), /\.3mf$/i.test(name) ? name : `${name}.3mf`);
                await fs.copyFile(row.path, row.output_path, fs.constants.COPYFILE_EXCL);
            }
            active();
            // Reuse the exact candidate's all-plate measurement from this run; never spend an uncounted final slice.
            if (input.openInStudio) {
                try {
                    await deps.openInStudio(selected.output_path);
                    openedInStudio = true;
                }
                catch (error) {
                    warnings.push(`Não foi possível abrir no Bambu Studio: ${error.message}`);
                }
                active();
            }
        }
        if (sha(await readBoundedPrintFile(source)) !== before)
            throw Error('Source changed during optimization');
        const report = { tool: 'prepare_print_project', verdict: selected ? 'ready_with_caveats' : 'not_ready', delivered: selected ? { path: selected.output_path, sliced: false, opened_in_studio: openedInStudio } : null,
            source: { path: source, sha256_before: before, sha256_after: after, unchanged: true }, printer: { model: input.model, preset: deps.printerPreset, studio_installed: installed }, layout,
            stop: { reason: stop, slices, max_slices: input.maxSlices, minutes: (now() - started) / 60000 },
            optimization: { objective: options.objective, layer_policy: 'preserve', status: selected ? selected.id === 'baseline' ? 'no_improvement' : 'improved' : 'unverified', constraints: options.constraints, allow_reorientation: options.allow_reorientation, baseline: baseline ? { time_s: baseline.time_s, weight_g: baseline.weight_g, material_by_plate: baseline.plates?.map(p => ({ plate: p.plate, observed: p.observed_extrusion ?? null })) } : null, selected: selected?.id ?? null, selected_estimates: selected ? { time_s: selected.time_s, weight_g: selected.weight_g } : null, candidates: records.map(({ path, ...row }) => row), not_verified: ['Qualidade visual, adesão e resistência precisam de avaliação física.', 'A busca é limitada pelo orçamento e não prova um ótimo global.'] },
            verification_all_plates: selected ? { checked: true, reused_current_run: true, plates: selected.plates } : null, warnings,
            resumo: selected ? `Otimização ${options.objective}: ${selected.id === 'baseline' ? 'nenhuma melhoria elegível acima do empate de 3%; projeto base preservado' : `alternativa ${selected.name} selecionada`}. ${slices}/${input.maxSlices} fatiamentos usados. Tempo e material são estimativas; revise no Bambu Studio.` : `Nenhum candidato com evidência suficiente foi entregue (${stop}).` };
        if (output)
            await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
        active();
        return report;
    }
    catch (e) {
        if (output)
            await fs.rm(output, { recursive: true, force: true });
        if (e instanceof BudgetStop)
            return { tool: 'prepare_print_project', verdict: 'not_ready', delivered: null, stop: { reason: e.reason, slices }, optimization: { objective: options.objective, selected: null, candidates: records.map(({ path, output_path, ...row }) => row) }, resumo: 'Otimização interrompida; arquivos desta execução removidos.' };
        throw e;
    }
    finally {
        if (work)
            await fs.rm(work, { recursive: true, force: true });
    }
}
function automatic(config, options) {
    const pattern = typeof config.sparse_infill_pattern === 'string' ? config.sparse_infill_pattern : undefined, density = numbers(config.sparse_infill_density);
    if (!pattern || !density || !density.every(v => v === density[0]))
        return [];
    const values = [density[0]], floor = options.constraints.min_infill_density;
    if (floor !== undefined && floor < density[0])
        values.push(floor);
    const rows = [];
    for (const value of values)
        for (const p of [pattern, 'adaptivecubic', 'gyroid'].filter((v, i, a) => a.indexOf(v) === i)) {
            if (p === pattern && value === density[0])
                continue;
            rows.push({ name: `${p} ${value}%`, settings: { sparse_infill_pattern: p, sparse_infill_density: value, ...(floor === undefined || config.skeleton_infill_density === undefined ? {} : { skeleton_infill_density: Math.min(numbers(config.skeleton_infill_density)?.[0] ?? value, value) }), ...(floor === undefined || config.skin_infill_density === undefined ? {} : { skin_infill_density: Math.min(numbers(config.skin_infill_density)?.[0] ?? value, value) }) } });
        }
    return rows.slice(0, 6);
}
function choose(rows, objective) {
    const baseline = rows.find(r => r.kind === 'baseline');
    if (!baseline || baseline.ineligible_reasons.some(r => ['incomplete_plate_coverage', 'incomplete_or_unverified_gcode', 'missing_metrics'].includes(r)) || !(baseline.time_s > 0) || !(baseline.weight_g > 0))
        return undefined;
    const good = rows.filter(r => r.eligible && r.time_s !== null && r.weight_g !== null);
    for (const r of good) {
        r.pareto = !good.some(o => o.time_s <= r.time_s && o.weight_g <= r.weight_g && (o.time_s < r.time_s || o.weight_g < r.weight_g));
        const t = r.time_s / baseline.time_s, m = r.weight_g / baseline.weight_g;
        r.score = objective === 'time' ? t : objective === 'material' ? m : (t + m) / 2;
    }
    const minimum = Math.min(...good.map(r => r.score));
    return good.filter(r => r.score <= minimum + .03 + 1e-12).sort((a, b) => ((a.kind === 'baseline' ? 0 : a.changes.length + (a.orientation?.steps?.length ?? 0) + (a.kind === 'layout' ? 1 : 0)) - (b.kind === 'baseline' ? 0 : b.changes.length + (b.orientation?.steps?.length ?? 0) + (b.kind === 'layout' ? 1 : 0))) || good.indexOf(a) - good.indexOf(b))[0];
}
