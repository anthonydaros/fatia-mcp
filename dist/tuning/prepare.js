// prepare_print_project: the plan-slice-measure-adjust loop. A part goes in (3MF project or STL); a NEW unsliced project 3MF with tuned parameters comes out,
// together with a report that says what was changed, what was measured and what was only predicted. The original is never written, nothing is printed,
// no printer is contacted. Slicing goes through the Bambu Studio CLI only (injected as deps.slice), one candidate per round.
//
//   baseline  P0 (the retargeted, untuned project) is sliced once and scanned: the "before" of the report. It is NOT engine state.
//   round 0   pre-slice facts -> applyTuning -> write candidate -> slice -> scan -> facts
//   round k   nextRound(facts of the last slice) -> write candidate -> slice -> scan -> facts ... until done, stalled, exhausted, cycle, budget,
//             cancellation or an error. Every round is kept; the best measured one is delivered (see rank).
//   deliver   the best round is written again to output_dir (never over an existing file), the source's SHA-256 is checked, preflight_check judges
//             the structure/volume blockers of the deliverable, and the file is opened (unsliced) in Bambu Studio unless told not to.
// Design, budget and how to read the report: docs/TUNING.md.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { evalCondition } from "../knowledge/condition.js";
import { openProject } from "../knowledge/facts/settings.js";
import { getKb } from "../knowledge/loader.js";
import { printerId } from "../knowledge/tools.js";
import { loadSafe3mfArchive, readBoundedPrintFile } from "../safety/archive.js";
import { removeQuietly } from "../stl/stl-manipulator.js";
import { checkBlockValue } from "./config-block.js";
import { applyTuning, eqv, nextRound } from "./engine.js";
import { collectFacts } from "./facts.js";
import { failedLayout, runLayoutStage } from "./layout-stage.js";
import { meshFactsFromProject, meshFactsFromStl } from "./mesh-facts.js";
import { parsePartContext } from "./part-context.js";
import { buildReport } from "./prepare-report.js";
import { writeTunedProject } from "./project-writer.js";
export const STRONG_CONFIDENCES = ["preset", "oficial", "bug conhecido"];
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
/** Strings and lists of strings, the only values the engine and the writer handle. */
function toSettings(config) {
    const out = {};
    for (const [key, value] of Object.entries(config)) {
        if (key === "__proto__")
            continue;
        if (typeof value === "string" || (Array.isArray(value) && value.every(e => typeof e === "string")))
            out[key] = value;
    }
    return out;
}
async function readConfig(file) {
    const zip = await loadSafe3mfArchive(await readBoundedPrintFile(file));
    const text = await zip.file("Metadata/project_settings.config")?.async("string");
    if (text === undefined)
        throw new Error(`${path.basename(file)} has no Metadata/project_settings.config.`);
    return JSON.parse(text.replace(/^﻿/, ""));
}
/** The values to write against P0: every key whose engine value differs from the base, with its scope. */
function deltaOf(base, plan, scopes, warnings) {
    const changes = Object.keys(plan.settings_after).sort()
        .filter(key => !eqv(base[key], plan.settings_after[key]))
        .map(key => ({ key, value: plan.settings_after[key], scope: scopes.get(key) ?? "process" }));
    const overrides = {};
    for (const [key, value] of Object.entries(plan.object_overrides).sort(([a], [b]) => (a < b ? -1 : 1))) {
        const one = Array.isArray(value) ? (value.every(v => v === value[0]) ? value[0] : undefined) : value;
        if (typeof one === "string")
            overrides[key] = one;
        else
            warnings.push(`O ajuste por objeto ${key} tem valores diferentes por elemento; não foi escrito.`);
    }
    return { changes, overrides };
}
const hashOf = (d) => sha256(Buffer.from(JSON.stringify([d.changes.map(c => [c.key, c.value]), Object.entries(d.overrides)]))).slice(0, 16);
/**
 * Blocker rules the run's own facts decide: the G-code ones, plus the 3MF-structure and mesh ones (volume, prime tower). preflight_check cannot judge those
 * on a 3MF (it cannot read mesh.size_* from one), so they are evaluated here on the facts the collector already holds; a rule whose facts are missing is
 * listed as undecidable, never silently passed.
 */
function factBlockers(facts, model) {
    const hits = [];
    const unknown = [];
    const clear = [];
    const scope = printerId(model);
    for (const r of getKb().rules) {
        if (r.severity !== "blocker" || r.domain !== "bambu" || !["gcode", "3mf-structure", "mesh"].includes(r.detect.method) || !r.detect.when)
            continue;
        if (r.printers.length && (!scope || !r.printers.includes(scope)))
            continue;
        const verdict = evalCondition(r.detect.when, facts);
        if (verdict === true)
            hits.push({ rule: r.id, title: r.title, confidence: r.confidence, evidence: Object.fromEntries(r.detect.facts.filter(f => facts[f] !== undefined && facts[f] !== null).map(f => [f, facts[f]])) });
        else if (verdict === false)
            clear.push(r.id);
        else if (verdict === undefined)
            unknown.push({ rule: r.id, title: r.title, missing: r.detect.facts.filter(f => facts[f] === undefined || facts[f] === null) });
    }
    return { hits, unknown, clear };
}
const planItems = (plan) => ("applied" in plan ? plan.applied : plan.changes);
/** Fewest true triggers, then fewest blockers, then the shortest print time, then the later round. */
const rank = (r) => {
    const time = r.measure.facts["plate.time_s"];
    return [r.judged.triggers_true.length, r.judged.blockers.length, typeof time === "number" ? time : Infinity, -r.round];
};
function better(a, b) {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < x.length; i++)
        if (x[i] !== y[i])
            return x[i] < y[i];
    return false;
}
function defaultName(source) {
    return `${path.basename(source).replace(/(\.gcode)?\.(3mf|stl)$/i, "")}_tuned.3mf`;
}
export async function prepareProject(input, deps) {
    const now = deps.now ?? Date.now;
    const started = now();
    const source = path.resolve(input.path);
    if (!/\.(3mf|stl)$/i.test(source))
        throw new Error("prepare_print_project accepts a .3mf project or an .stl file.");
    if (input.outputName !== undefined && (!input.outputName.trim() || /[\\/]/.test(input.outputName) || input.outputName.includes("\0")))
        throw new Error("output_name must be a file name, not a path.");
    const outputName = input.outputName === undefined ? defaultName(source) : /\.3mf$/i.test(input.outputName) ? input.outputName : `${input.outputName}.3mf`;
    input.signal?.throwIfAborted();
    const sourceBytes = await readBoundedPrintFile(source);
    const before = sha256(sourceBytes);
    const isStl = /\.stl$/i.test(source);
    const declared = parsePartContext(input.partContext);
    const originalProject = isStl ? undefined : await openProject(source);
    let project = originalProject;
    const plateNode = originalProject?.modelSettings?.plate;
    const plates = plateNode === undefined ? 0 : Array.isArray(plateNode) ? plateNode.length : 1;
    const layoutMode = input.layout?.mode ?? "auto";
    const explicitPlate = input.plateIndexExplicit ?? input.plateIndex !== 0;
    // An explicit plate_index means the NEW numbering when the layout rewrites the plates (auto, not a dry run), so it is checked after the stage.
    const layoutRewrites = layoutMode === "auto" && !input.dryRun && !isStl;
    const outOfRange = (count) => new Error(`plate_index ${input.plateIndex} is out of range: the 3MF has ${count} plate(s), numbered from 0.`);
    if (plates > 0 && input.plateIndex >= plates && !(layoutRewrites && explicitPlate))
        throw outOfRange(plates);
    const warnings = [];
    const addWarnings = (list) => { for (const w of list)
        if (!warnings.includes(w))
            warnings.push(w); };
    await fs.mkdir(deps.tempDir, { recursive: true });
    const work = await fs.mkdtemp(path.join(deps.tempDir, "prepare-"));
    try {
        // The retarget runs once (an STL's costs a real slice); every write reuses its outcome.
        let retargetSlices = 0;
        let cached;
        const retarget = deps.retarget && (src => cached ?? (cached = deps.retarget(src).then(o => { retargetSlices += o.slices ?? 0; return o; })));
        const scopes = new Map();
        // Once the layout stage has written a laid-out copy of P0, every candidate is built on it; the diffs and the hash stay against the user's file.
        let writeSource = source;
        let origin;
        const write = (output, d) => writeTunedProject({
            source: writeSource, output, target: { printerPreset: deps.printerPreset }, changes: d.changes,
            ...(Object.keys(d.overrides).length ? { objectOverrides: { settings: d.overrides } } : {}), retarget, ...(origin ? { origin } : {}),
        });
        const aborted = () => input.signal?.aborted === true;
        let loopSlices = 0;
        let lastSliceMs = 0;
        const used = () => loopSlices + retargetSlices;
        let step = 0;
        const progress = (message) => input.onProgress?.({ step: ++step, slices: used(), max: input.maxSlices, message: `${message} (${used()} of ${input.maxSlices} slices used)` });
        const budgetStop = () => aborted() ? "cancelled" : used() >= input.maxSlices ? "budget_slices" : now() - started + lastSliceMs > input.maxMinutes * 60000 ? "budget_minutes" : undefined;
        // 1. P0: the project for the target printer, nothing tuned. It gives the engine its base settings.
        progress("Building the target-printer project (retarget)");
        const p0 = await write(path.join(work, "p0.3mf"), { changes: [], overrides: {} });
        addWarnings(p0.warnings);
        const base = toSettings(await readConfig(p0.path));
        const installed = await deps.installedStudio().catch(() => null);
        // 1b. The layout stage: are the objects on the target printer's plates, and is the number of plates the best one? Runs on P0.
        progress("Checking the layout against the target printer's plates");
        let layout;
        try {
            layout = await runLayoutStage({
                p0: p0.path, sourceConfig: originalProject?.config, mode: layoutMode, dryRun: input.dryRun, gapMm: input.layout?.gapMm, marginMm: input.layout?.marginMm,
                maxSlices: input.layout?.maxSlices, maxMinutes: input.layout?.maxMinutes, work, sliceAll: deps.sliceAll, now, signal: input.signal, progress,
            });
        }
        catch (error) {
            if (aborted())
                throw error;
            // A defect in the layout stage must not cost the tuning: the project stays as it is and the report says why.
            layout = failedLayout(layoutMode, `the layout stage failed: ${error.message.slice(0, 300)}`);
            warnings.push(`A etapa de layout falhou (${error.message.slice(0, 200)}); o projeto segue com o layout que tinha.`);
        }
        let plateIndex = input.plateIndex;
        let plateWhy = explicitPlate ? "plate_index as the caller passed it" : "the default plate (the first)";
        let plateKind = explicitPlate ? "explicit" : "default";
        if (layout.status === "applied" && layout.file) {
            writeSource = layout.file;
            origin = { path: source, retarget: p0.retarget };
            const count = layout.plates_after ?? 1;
            if (explicitPlate) {
                if (input.plateIndex >= count)
                    throw outOfRange(count);
                plateWhy = "plate_index as the caller passed it, in the NEW numbering of the laid-out project";
                plateKind = "explicit_new_numbering";
            }
            else if (layout.measured_plate) {
                plateIndex = layout.measured_plate.index;
                plateWhy = layout.measured_plate.why;
                plateKind = "longest_plate";
            }
            else {
                plateIndex = 0;
                plateWhy = "the first plate of the laid-out project (the candidates were not measured, so the longest plate is unknown)";
                plateKind = "first_plate_unmeasured";
            }
            // The facts read the laid-out files; the settings facts that describe the ORIGINAL project (its printer) still read the original's settings.
            const laid = await openProject(layout.file);
            project = { ...laid, config: originalProject?.config, configProblem: originalProject?.configProblem };
            for (let k = warnings.length - 1; k >= 0; k--)
                if (/^The source printer's bed/.test(warnings[k]))
                    warnings.splice(k, 1); // now a layout issue, fixed
        }
        else if (plates > 0 && plateIndex >= plates)
            throw outOfRange(plates);
        const mesh = isStl
            ? await meshFactsFromStl(source, { settings: base, signal: input.signal })
            : await meshFactsFromProject(project, plateIndex, { settings: base, signal: input.signal });
        const collect = (out) => collectFacts({
            project, plateIndex, targetModel: input.model, settingsBase: base, mesh, declared, actions: deps.tuning.actions,
            installedStudio: async () => installed, source: path.basename(source), ...(out ? { gcode: out.gcode, slice: out.slice } : {}),
        });
        const engineOptions = (unavailable) => ({
            printer: input.model, ...(installed ? { studioVersion: installed } : {}), unavailable,
            ...(input.apply === "strong_only" ? { applyConfidences: STRONG_CONFIDENCES } : {}), studioKeys: deps.studioKeys,
        });
        const measureOf = (collected, ms, reach) => ({
            facts: Object.fromEntries(Object.entries(collected.facts).filter(([k, v]) => /^(gcode|plate|slicer)\./.test(k) && v !== null && v !== undefined)), ms, reach,
        });
        // 2. The baseline: reporting only.
        const baselineHash = hashOf({ changes: [], overrides: {} });
        const measured = new Map();
        let baseline;
        let baselineError;
        let stop = aborted() ? { reason: "cancelled", detail: "Cancelado antes do primeiro fatiamento." } : undefined;
        if (!input.dryRun && !stop) {
            const why = budgetStop();
            if (why)
                stop = { reason: why, detail: "O orçamento de fatiamentos não permite nem o fatiamento de referência." };
            else {
                progress("Slicing the retargeted, untuned project (baseline)");
                try {
                    const t = now();
                    loopSlices++; // an attempt counts, whether or not it succeeds
                    const out = await deps.slice(writeSource === source ? p0.path : layout.file, input.signal, plateIndex);
                    lastSliceMs = now() - t;
                    const collected = await collect(out);
                    const measure = measureOf(collected, out.ms ?? lastSliceMs, {});
                    baseline = { measure, blockers: factBlockers(collected.facts, input.model).hits };
                    measured.set(baselineHash, { measure, collected });
                }
                catch (error) {
                    if (aborted())
                        stop = { reason: "cancelled", detail: "Cancelado durante o fatiamento de referência." };
                    else {
                        baselineError = error.message;
                        warnings.push(`O fatiamento de referência falhou (${baselineError}); o relatório fica sem os números de "antes".`);
                    }
                }
            }
        }
        // 3. Round 0 and the loop.
        const rounds = [];
        const items = new Map();
        let pending = [];
        const seen = new Set([baselineHash]);
        let pre;
        let plan;
        if (!stop) {
            pre = await collect();
            plan = applyTuning(deps.tuning.actions, pre.facts, base, engineOptions(pre.unavailable));
        }
        for (let n = 0; plan && !stop; n++) {
            const requested = planItems(plan);
            for (const item of requested) {
                const slot = `${item.scope === "object" ? "o" : "s"}\0${item.key}`;
                (items.get(slot) ?? items.set(slot, []).get(slot)).push(item);
                if (item.scope !== "object")
                    scopes.set(item.key, item.scope);
            }
            const delta = deltaOf(base, plan, scopes, warnings);
            const hash = hashOf(delta);
            const rec = { round: n, hash, delta, changes: requested, advanced: plan.advanced.map(a => a.action), relaxed: plan.relaxed.map(r => r.action) };
            if (n > 0 && seen.has(hash)) {
                stop = { reason: "cycle", detail: `A rodada ${n} repetiria os ajustes de uma rodada anterior (${hash}); parou antes de fatiá-la.` };
                pending = requested;
                break;
            }
            seen.add(hash);
            const file = path.join(work, `round-${n}.3mf`);
            try {
                if (input.dryRun) {
                    rec.write = await write(file, delta);
                    rec.engine = plan;
                    rec.collected = pre;
                    rounds.push(rec);
                    stop = { reason: "dry_run", detail: "Dry run: o plano foi montado só com os dados do próprio projeto; nada foi fatiado nem medido." };
                    break;
                }
                let collected;
                const reuse = n === 0 ? measured.get(hash) : undefined;
                if (reuse) {
                    // Nothing to change in round 0: the candidate is the baseline project, whose measurements are already in hand.
                    rec.measure = { ...reuse.measure, reused_from: "baseline" };
                    collected = reuse.collected;
                }
                else {
                    const why = budgetStop();
                    if (why) {
                        stop = { reason: why, detail: why === "cancelled" ? `Cancelado antes da rodada ${n}.` : why === "budget_slices" ? `O orçamento de ${input.maxSlices} fatiamentos acabou; a rodada ${n} foi planejada, mas não fatiada.` : `Outro fatiamento passaria do orçamento de ${input.maxMinutes} minutos; a rodada ${n} foi planejada, mas não fatiada.` };
                        pending = requested;
                        break;
                    }
                    rec.write = await write(file, delta);
                    addWarnings(rec.write.warnings);
                    progress(`Slicing round ${n}`);
                    const t = now();
                    loopSlices++;
                    const out = await deps.slice(file, input.signal, plateIndex);
                    lastSliceMs = now() - t;
                    collected = await collect(out);
                    const config = await readConfig(file);
                    const reach = Object.fromEntries(rec.write.changed_keys.map(c => [c.key, out.block ? checkBlockValue(config, out.block, c.key, c.scope).ok : null]));
                    rec.measure = measureOf(collected, out.ms ?? lastSliceMs, reach);
                }
                const next = nextRound(deps.tuning.actions, plan.state, collected.facts, engineOptions(collected.unavailable));
                const blockers = factBlockers(collected.facts, input.model);
                rec.engine = next;
                rec.collected = collected;
                rec.judged = {
                    triggers_true: next.ladders.filter(l => l.trigger === true).map(l => l.action),
                    triggers_false: next.ladders.filter(l => l.trigger === false).map(l => l.action),
                    triggers_unknown: next.unknown.map(u => u.action),
                    exhausted: next.exhausted, blind_facts: next.blind_facts, missing_facts: next.missing_facts, done: next.done, stalled: next.stalled,
                    next_changes: next.changes.length, blockers: blockers.hits, blockers_unknown: blockers.unknown, blockers_clear: blockers.clear,
                };
                rounds.push(rec);
                if (next.done)
                    stop = { reason: "done", detail: `O fatiamento da rodada ${n} não mostra nenhum gatilho e o motor não tem mais o que mudar.` };
                else if (next.stalled) {
                    const allExhausted = next.exhausted.length > 0 && next.ladders.filter(l => l.trigger === true).every(l => next.exhausted.some(e => e.action === l.action));
                    stop = allExhausted
                        ? { reason: "exhausted", detail: `Toda escada que ainda dispara ficou sem degraus (${next.exhausted.map(e => e.action).join(", ")}).` }
                        : { reason: "stalled", detail: `O motor não tem o que mudar e não está pronto${next.missing_facts.length ? `; ainda faltam os fatos ${next.missing_facts.join(", ")}` : ""}.` };
                }
                else
                    plan = next;
            }
            catch (error) {
                rec.error = error.message;
                if (!rounds.includes(rec))
                    rounds.push(rec);
                stop = aborted() ? { reason: "cancelled", detail: `Cancelado durante a rodada ${n}.` } : { reason: "error", detail: `A rodada ${n} falhou: ${rec.error}` };
            }
        }
        stop ?? (stop = { reason: "stalled", detail: "O laço terminou sem motivo registrado." });
        // 4. The best measured round is the deliverable (never after a cancellation: the person asked to stop).
        const good = rounds.filter(r => r.measure && r.judged);
        let best;
        for (const r of good)
            if (!best || better(r, best))
                best = r;
        const last = good[good.length - 1];
        let bestWhy;
        if (best) {
            bestWhy = best === last
                ? `rodada ${best.round}, a última medida`
                : `rodada ${best.round}, não a última medida (${last.round}): ${best.judged.triggers_true.length === last.judged.triggers_true.length ? "mesmo número de gatilhos verdadeiros, mas melhor em bloqueadores ou tempo de impressão" : `menos gatilhos verdadeiros (${best.judged.triggers_true.length}) que a rodada ${last.round} (${last.judged.triggers_true.length})`}`;
        }
        const outputDir = path.resolve(input.outputDir);
        let delivered;
        let preflightRun = { checked: source, blockers: [] };
        const target = stop.reason === "cancelled" ? undefined : best; // a dry run has no measured round, so nothing is delivered
        if (target) {
            try {
                const write2 = await write(path.join(outputDir, outputName), target.delta);
                addWarnings(write2.warnings);
                delivered = { path: write2.path, write: write2, opened: null };
            }
            catch (error) {
                // The measurements and history are the product of up to max_slices slices: a folder that cannot be written must not throw them away.
                const detail = `Não foi possível gravar o projeto entregue em ${outputDir}: ${error.message}`;
                stop = { reason: "error", detail };
                warnings.push(detail);
            }
        }
        // 5. The source is untouched; the deliverable has no structure/volume blocker; then it is opened for the person to review and slice.
        const after = sha256(await readBoundedPrintFile(source));
        if (after !== before)
            warnings.push(`${source} mudou enquanto o laço rodava (o SHA-256 difere); o projeto entregue não foi aberto.`);
        const check = delivered?.path ?? source;
        if (stop.reason !== "cancelled")
            try {
                const context = { ...(declared.kind ? { object_kind: declared.kind } : {}), ...(declared.mold_kind === "rigid" || declared.mold_kind === "silicone" ? { mold_kind: declared.mold_kind } : {}) };
                const result = await deps.preflight({ file_path: check, bambu_model: input.model, plate_index: plateIndex, min_severity: "blocker", max_findings: 50, context });
                const findings = (Array.isArray(result.findings) ? result.findings : []);
                preflightRun = { checked: check, blockers: findings.filter(f => f.severity === "blocker"), unchecked: result.unchecked };
            }
            catch (error) {
                preflightRun = { checked: check, blockers: [], error: error.message };
                warnings.push(`O preflight_check não conseguiu julgar ${path.basename(check)} (${preflightRun.error}); os bloqueadores de estrutura e volume não foram conferidos.`);
            }
        if (delivered && input.openInStudio && after === before) {
            try {
                delivered.opened = (await deps.openInStudio(delivered.path));
            }
            catch (error) {
                delivered.open_error = error.message;
                warnings.push(`Não foi possível abrir o projeto no Bambu Studio (${delivered.open_error}); abra ${delivered.path} você mesmo.`);
            }
        }
        return buildReport({
            input, tuning: deps.tuning, printerPreset: deps.printerPreset, declared, source: { path: source, sha256_before: before, sha256_after: after }, p0, base,
            baseline, baselineError, rounds, items, stop, slices: { loop: loopSlices, retarget: retargetSlices, max: input.maxSlices },
            minutes: Math.round(((now() - started) / 60000) * 100) / 100, best: input.dryRun ? undefined : best, bestWhy, pending, delivered, preflight: preflightRun, mesh, installed, warnings,
            layout, plate: { index: plateIndex, why: plateWhy, kind: plateKind },
        });
    }
    finally {
        await removeQuietly(work);
    }
}
