// The layout stage of prepare_print_project: analysis -> plan -> (measure the candidates with the slicer) -> choose -> write -> prove.
// It runs on P0 (the project already retargeted to the target printer) and hands back the laid-out project as a file, or says why nothing changed.
// Policy (the user's): never mix colour classes on a plate; prefer splitting across plates; decide the number of plates by what the slicer predicts for
// the whole project (the sum of plate times is what one printer needs), not by a rule of thumb. Every candidate is measured with ONE CLI call that slices
// all its plates. What that estimate cannot see is said in `not_verified`.
import fs from "node:fs/promises";
import path from "node:path";
import { openProject } from "../knowledge/facts/settings.js";
import { LayoutLimitError, analyzeLayout, bedChange, geometryFromConfig, plateOrigin, readLayoutModel, } from "./layout.js";
import { authoredRebased, chooseCandidate, defaultPolicy, minimumGap, planLayouts, } from "./layout-plan.js";
import { writeLaidOutProject } from "./layout-writer.js";
import { MeshReadError } from "./mesh-read.js";
export const LAYOUT_DEFAULTS = { maxSlices: 6, maxMinutes: 12, maxCandidates: 3, maxReferencePlates: 20 };
const NOT_VERIFIED = [
    "The choice rests on the slicer's predicted print time (sum over plates) and on the G-code scan of each plate; it is an estimate, not a print.",
    "A failure ruins a whole plate: more objects on one plate means more at risk when one detaches or a travel knocks one over; the estimate does not price that.",
    "Bed adhesion, warping and real cooling of tall thin walls on a crowded plate are not simulated.",
    "Nothing here opened Bambu Studio's GUI: that Studio shows the plates as written, and keeps the objects where they were put, follows from the file format and the CLI slice and is unconfirmed.",
    "The nozzle each filament really uses is taken from the project's filament_map; with an automatic grouping mode Studio may regroup at slice time (the per-candidate nozzle map from the slice is reported).",
];
const COLOUR_NAMES = [
    ["black", [0, 0, 0]], ["white", [255, 255, 255]], ["grey", [128, 128, 128]], ["red", [220, 40, 40]], ["orange", [255, 140, 0]], ["yellow", [240, 220, 40]],
    ["green", [40, 160, 60]], ["blue", [40, 80, 220]], ["purple", [130, 50, 170]], ["pink", [240, 130, 180]], ["brown", [120, 70, 30]], ["beige", [220, 200, 160]],
];
export function colourName(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? "");
    if (!m)
        return "unknown colour";
    const rgb = [m[1], m[2], m[3]].map(h => parseInt(h, 16));
    let best = COLOUR_NAMES[0];
    let bestD = Infinity;
    for (const c of COLOUR_NAMES) {
        const d = c[1].reduce((s, v, i) => s + (v - rgb[i]) ** 2, 0);
        if (d < bestD) {
            best = c;
            bestD = d;
        }
    }
    return best[0];
}
const r1 = (n) => Math.round(n * 10) / 10;
/** "Frame - black", "Filament 2 - grey (2/3)". */
function plateName(plate, ordinal, colours, objectNames) {
    const colour = [...new Set(plate.slots.map(s => colourName(colours[s - 1])))].join("/");
    const label = objectNames.length === 1 ? objectNames[0] : `Filament ${plate.slots.join("+")}${plate.classKey.endsWith("+paint") ? " (painted)" : ""}`;
    return `${label} - ${colour}${ordinal.of > 1 ? ` (${ordinal.n}/${ordinal.of})` : ""}`;
}
/** The plan in world coordinates (what the writer takes), with the plate names. */
export function worldPlan(candidate, geo, colours) {
    const count = candidate.plates.length;
    const perClass = new Map();
    for (const p of candidate.plates)
        perClass.set(p.classKey, (perClass.get(p.classKey) ?? 0) + 1);
    const seen = new Map();
    return {
        plates: candidate.plates.map((plate, i) => {
            const o = plateOrigin(i, count, geo);
            const n = (seen.get(plate.classKey) ?? 0) + 1;
            seen.set(plate.classKey, n);
            return {
                name: plateName(plate, { n, of: perClass.get(plate.classKey) }, colours, plate.items.map(x => x.name)),
                items: plate.items.map(x => ({ key: x.key, cx: o.x + x.x + x.w / 2, cy: o.y + x.y + x.d / 2, rotate: x.rotate })),
            };
        }),
    };
}
const configColours = (config) => (Array.isArray(config.filament_colour) ? config.filament_colour.map(String) : []);
const SELECTION = "Lowest total predicted time over all plates; layouts within 3% of it are tied and the smaller longest plate decides, then fewer objects on the fullest plate, then fewer plates. A project that is already free of problems stays as it is unless another layout is clearly (over 3%) faster.";
/** The run record of a stage that did not complete (an unexpected error): the project stays as it is and the report says why. */
export function failedLayout(mode, reason) {
    return { mode, status: "failed", reason, issues: [], unfixed: [], plates_before: [], blockers: [], classes: [], candidates: [], unmeasured: true, not_verified: [...NOT_VERIFIED], budget: { slices_used: 0, max_slices: 0, minutes_used: 0, max_minutes: 0, stopped_early: null } };
}
export async function runLayoutStage(i) {
    var _a, _b, _c, _d;
    const now = i.now ?? Date.now;
    const started = now();
    const maxSlices = i.maxSlices ?? LAYOUT_DEFAULTS.maxSlices;
    const maxMinutes = i.maxMinutes ?? LAYOUT_DEFAULTS.maxMinutes;
    const run = {
        mode: i.mode, status: "skipped", issues: [], unfixed: [], plates_before: [], blockers: [], classes: [], candidates: [], unmeasured: true, not_verified: [...NOT_VERIFIED],
        budget: { slices_used: 0, max_slices: maxSlices, minutes_used: 0, max_minutes: maxMinutes, stopped_early: null },
    };
    if (i.mode === "off")
        return { ...run, status: "off", reason: "layout: off" };
    const project = await openProject(i.p0);
    const config = project.config;
    const geo = config && geometryFromConfig(config);
    if (!config || !geo)
        return { ...run, reason: "the project settings carry no usable printable_area, so the plates cannot be placed" };
    let model;
    try {
        model = await readLayoutModel(project);
    }
    catch (error) {
        if (error instanceof MeshReadError || error instanceof LayoutLimitError)
            return { ...run, reason: `the layout stage could not read the project's geometry: ${error.message}`, ...(error instanceof LayoutLimitError ? { status: "failed" } : {}) };
        throw error;
    }
    if (!model.plates.length)
        return { ...run, reason: "the project has no plate definitions (Metadata/model_settings.config)" };
    const policy = defaultPolicy(config, { gapMm: i.gapMm, marginMm: i.marginMm });
    const minGap = minimumGap(policy.brimMm);
    run.policy = { gap_mm: policy.gapMm, margin_mm: policy.marginMm, minimum_gap_mm: minGap, brim_mm: policy.brimMm, rotations_deg: [0, 90], one_colour_class_per_plate: true, selection: SELECTION };
    run.target = {
        bed_mm: [r1(geo.bed.x1 - geo.bed.x0), r1(geo.bed.y1 - geo.bed.y0)], height_mm: geo.height,
        nozzles: geo.nozzles.map((n, k) => ({ nozzle: k + 1, x_mm: [n.rect.x0, n.rect.x1], y_mm: [n.rect.y0, n.rect.y1], height_mm: n.height })),
        filament_map: geo.filamentMap.map(n => n + 1), filament_map_mode: geo.mapMode ?? null, cell_mm: [r1(geo.strideX), r1(geo.strideY)], notes: geo.notes,
    };
    const analysis = analyzeLayout(model, geo, { minGapMm: minGap });
    const bed = bedChange(i.sourceConfig, geo);
    run.issues = [...(bed ? [bed] : []), ...analysis.issues];
    run.plates_before = analysis.plates;
    run.plates_before_count = model.plates.length;
    const errors = analysis.issues.filter(x => x.severity === "error");
    const locked = model.plates.some(p => p.locked);
    const colours = configColours(config);
    if (locked) {
        run.unfixed = errors;
        return { ...run, status: "locked", reason: "a plate is locked: the layout never moves its objects, and changing the number of plates moves every plate on the grid, so nothing was changed" };
    }
    const plan = planLayouts(model.objects, geo, { policy: { gapMm: policy.gapMm, marginMm: policy.marginMm }, maxCandidates: i.maxCandidates ?? LAYOUT_DEFAULTS.maxCandidates });
    run.blockers = plan.blockers;
    run.classes = plan.classes;
    const usedPlates = model.plates.filter(p => p.keys.some(k => model.objects.some(o => o.key === k))).length;
    const clean = analysis.clean;
    if (plan.blockers.length) {
        run.unfixed = [...plan.blockers.map((b) => ({ kind: "blocker", severity: "error", objects: b.objects, evidence: b.evidence, text: b.reason, fix: "Nothing the layout can change: scale or re-orient the object, or use a larger printer." })), ...errors];
        return { ...run, status: "blocked", reason: "an object cannot fit any plate of the target printer; no layout was applied" };
    }
    // The reference: the project as it stands (when it has no problem) or as the authors laid it out, moved onto the target's grid.
    const asIs = {
        id: "as_is", strategy: "authored", label: `${usedPlates} plate(s): the project as it is`, unchanged: true, notes: ["nothing is written for this one"],
        plates: model.plates.filter(p => p.keys.some(k => model.objects.some(o => o.key === k))).map(p => {
            const here = p.keys.map(k => model.objects.find(o => o.key === k)).filter((o) => !!o);
            const o = plateOrigin(p.index, model.plates.length, geo);
            return {
                classKey: [...new Set(here.map(x => x.classKey))].join(","), slots: [...new Set(here.flatMap(x => x.slots))].sort((a, b) => a - b), load: 0,
                items: here.map(x => ({ key: x.key, name: x.name, x: x.box.x0 - o.x, y: x.box.y0 - o.y, w: x.box.x1 - x.box.x0, d: x.box.y1 - x.box.y0, rotate: 0 })),
            };
        }),
    };
    let reference;
    const referenceCap = LAYOUT_DEFAULTS.maxReferencePlates;
    if (clean) {
        if (usedPlates > referenceCap)
            return { ...run, status: "unchanged", reason: `no layout problem found; the project has ${usedPlates} plates (over ${referenceCap}), too many to slice as it is for a comparison`, unmeasured: false };
        if (usedPlates <= plan.candidates[0].plates.length)
            return { ...run, status: "unchanged", reason: `no layout problem found, and the project already uses ${usedPlates} plate(s), no more than the ${plan.candidates[0].plates.length} the planner needs`, unmeasured: false };
        reference = asIs;
    }
    else if (usedPlates > referenceCap) {
        run.not_verified.push(`The reference "as authored, moved onto the target's grid" was not built: the project has ${usedPlates} plates (over ${referenceCap}).`);
    }
    else {
        const rebased = authoredRebased(model, geo, { gapMm: policy.gapMm, marginMm: policy.marginMm }, minGap, i.sourceConfig ? geometryFromConfig(i.sourceConfig) : undefined);
        if ("unavailable" in rebased)
            run.not_verified.push(`The reference "as authored, moved onto the target's grid" is not available: ${rebased.unavailable}.`);
        else
            reference = rebased;
    }
    const candidates = [...plan.candidates, ...(reference && (!clean || reference.plates.length > 0) ? [reference] : [])];
    // Slice the cheap ones first; the reference (often the most plates) last.
    const toReport = (c) => ({
        id: c.id, strategy: c.strategy, label: c.label, plates: c.plates.length, objects_per_plate: c.plates.map(p => p.items.length), classes_per_plate: c.plates.map(p => p.classKey),
        measured: false, chosen: false, notes: c.notes,
    });
    run.candidates = candidates.map(toReport);
    const report = (id) => run.candidates.find(c => c.id === id);
    if (i.mode === "check_only" || i.dryRun) {
        const why = i.dryRun ? "dry_run: nothing is sliced, so the candidates are not measured" : "layout: check_only: nothing is sliced or written";
        for (const c of run.candidates)
            c.not_measured_reason = why;
        const first = candidates[0];
        report(first.id).chosen = true;
        run.chosen = { id: first.id, reason: `${why}; this is the planner's default (the fewest plates it found), not a measured choice`, plates: describe(first, worldPlan(first, geo, colours), geo, [], colours) };
        run.unfixed = errors;
        return { ...run, status: i.dryRun ? "dry_run" : "check_only", reason: why };
    }
    // Measure.
    const measures = new Map();
    let lastMs = 0;
    const files = new Map();
    const fileOf = async (c) => {
        if (files.has(c.id))
            return files.get(c.id);
        if (c.unchanged) {
            const f = { path: i.p0 };
            files.set(c.id, f);
            return f;
        }
        const w = await writeLaidOutProject({ source: i.p0, output: path.join(i.work, `layout-${c.id}.3mf`), plan: worldPlan(c, geo, colours), geometry: geo, minGapMm: minGap });
        const f = { path: w.path, moved: w.moved, proof: w.proof, dropped: w.dropped_entries };
        files.set(c.id, f);
        return f;
    };
    const orderMeasure = [...candidates].sort((a, b) => Number(a.id === reference?.id) - Number(b.id === reference?.id));
    if (!i.sliceAll)
        for (const c of run.candidates)
            c.not_measured_reason = "no slicer was available to measure it";
    else
        for (const c of orderMeasure) {
            const item = report(c.id);
            if (i.signal?.aborted) {
                item.not_measured_reason = "cancelled";
                (_a = run.budget).stopped_early ?? (_a.stopped_early = "cancelled");
                continue;
            }
            if (run.budget.slices_used >= maxSlices) {
                item.not_measured_reason = `the layout slice budget (${maxSlices}) is used up`;
                (_b = run.budget).stopped_early ?? (_b.stopped_early = `layout slice budget of ${maxSlices} reached`);
                continue;
            }
            if (now() - started + lastMs > maxMinutes * 60000) {
                item.not_measured_reason = `another slice would pass the layout time budget (${maxMinutes} min)`;
                (_c = run.budget).stopped_early ?? (_c.stopped_early = `layout time budget of ${maxMinutes} min reached`);
                continue;
            }
            let f;
            try {
                f = await fileOf(c);
            }
            catch (error) {
                item.not_measured_reason = `it could not be written: ${error.message.slice(0, 300)}`;
                continue;
            }
            try {
                i.progress?.(`Layout: slicing candidate ${c.id} (${c.plates.length} plate(s)) with the Studio CLI`);
                const t = now();
                run.budget.slices_used++;
                const got = await i.sliceAll(f.path, i.signal);
                lastMs = now() - t;
                measures.set(c.id, got);
                fillMeasure(item, c, got);
            }
            catch (error) {
                lastMs = 0;
                if (i.signal?.aborted) {
                    item.not_measured_reason = "cancelled";
                    (_d = run.budget).stopped_early ?? (_d.stopped_early = "cancelled");
                    continue;
                }
                item.not_measured_reason = `its slice failed: ${error.message.slice(0, 300)}`;
            }
        }
    run.budget.minutes_used = Math.round(((now() - started) / 60000) * 100) / 100;
    const comparable = candidates.map(c => ({ id: c.id, plates: c.plates.length, objects_per_plate: c.plates.map(p => p.items.length), reference: c.strategy === "authored_rebased", time_s: (measures.get(c.id) ?? []).length === c.plates.length ? measures.get(c.id).slice().sort((a, b) => a.plate - b.plate).map(m => m.time_s) : [] }));
    const choice = chooseCandidate(comparable, clean ? "as_is" : undefined);
    let winner;
    if (choice) {
        winner = candidates.find(c => c.id === choice.id);
        run.chosen = { id: winner.id, reason: choice.reason, plates: [], ranking: choice.ranking };
        run.unmeasured = false;
    }
    else {
        winner = clean ? asIs : candidates[0];
        const why = `no candidate could be measured${run.budget.stopped_early ? ` (${run.budget.stopped_early})` : ""}`;
        run.chosen = { id: winner.id, reason: `${why}: ${clean ? "the project stays as it is" : "the planner's default (the fewest plates it found) was applied without a measurement"}`, plates: [] };
        run.unmeasured = true;
    }
    report(winner.id).chosen = true;
    if (run.budget.stopped_early && choice)
        run.chosen.reason += `. Candidate evaluation stopped early (${run.budget.stopped_early}); the best measured one was applied`;
    const sliced = measures.get(winner.id)?.slice().sort((a, b) => a.plate - b.plate) ?? [];
    const names = worldPlan(winner, geo, colours);
    run.chosen.plates = describe(winner, names, geo, sliced, colours);
    let keep;
    try {
        keep = winner.unchanged ? undefined : await fileOf(winner);
    }
    catch (error) {
        run.unfixed = errors;
        return { ...run, status: "failed", reason: `the laid-out project could not be written: ${error.message.slice(0, 400)}; nothing was changed` };
    }
    for (const file of files.values())
        if (file.path !== i.p0 && file.path !== keep?.path)
            await fs.rm(file.path, { force: true });
    if (winner.unchanged) {
        run.unfixed = errors;
        return { ...run, status: "unchanged", reason: choice ? `no candidate beat the project as it is by more than 3% (${choice.reason})` : "nothing was measured; the project stays as it is", ...(sliced.length ? { measured_plate: longest(sliced) } : {}) };
    }
    const f = keep;
    run.file = f.path;
    run.proof = f.proof;
    run.moved = f.moved;
    run.dropped_entries = f.dropped;
    run.plates_after = winner.plates.length;
    run.unfixed = [];
    const measuredPlate = sliced.length === winner.plates.length ? longest(sliced) : undefined;
    if (measuredPlate)
        run.measured_plate = measuredPlate;
    return { ...run, status: "applied", reason: `${run.plates_before_count} plate(s) became ${winner.plates.length}` };
}
function longest(sliced) {
    let best = sliced[0];
    for (const m of sliced)
        if ((m.time_s ?? -1) > (best.time_s ?? -1))
            best = m;
    return { index: best.plate - 1, number: best.plate, why: `the plate with the longest predicted time (${best.time_s ?? "?"} s) in the laid-out project` };
}
function fillMeasure(item, c, got) {
    const byPlate = new Map(got.map(m => [m.plate, m]));
    const per = c.plates.map((_, k) => byPlate.get(k + 1));
    item.time_per_plate_s = per.map(m => m?.time_s ?? null);
    item.crossing_per_plate = per.map(m => m?.crossing ?? null);
    item.nozzle_maps_as_sliced = per.map(m => m?.filament_maps ?? null);
    item.slicer_warnings = per.reduce((s, m) => s + (m?.warnings.length ?? 0), 0);
    item.measured = per.every(m => m && typeof m.time_s === "number");
    if (!item.measured)
        item.not_measured_reason = `the slice returned a time for ${per.filter(m => typeof m?.time_s === "number").length} of ${c.plates.length} plate(s)`;
    const times = item.time_per_plate_s.filter((t) => typeof t === "number");
    if (item.measured) {
        item.total_time_s = times.reduce((a, b) => a + b, 0);
        item.longest_plate_s = Math.max(...times);
    }
    const weights = per.map(m => m?.weight_g).filter((w) => typeof w === "number");
    if (weights.length === per.length)
        item.weight_g = Math.round(weights.reduce((a, b) => a + b, 0) * 100) / 100;
}
function describe(c, world, geo, sliced, colours) {
    const bedArea = (geo.bed.x1 - geo.bed.x0) * (geo.bed.y1 - geo.bed.y0);
    return c.plates.map((p, k) => ({
        plate: k + 1, name: world.plates[k].name, class: p.classKey, colour: [...new Set(p.slots.map(s => colourName(colours[s - 1])))].join("/"),
        objects: p.items.map((x, j) => ({ name: x.name, centre_world_mm: [r1(world.plates[k].items[j].cx), r1(world.plates[k].items[j].cy)], position_on_plate_mm: [r1(x.x), r1(x.y)], size_mm: [r1(x.w), r1(x.d)], rotation_deg: x.rotate })),
        utilisation: Math.round((p.items.reduce((s, x) => s + x.w * x.d, 0) / bedArea) * 100) / 100,
        predicted_time_s: sliced.find(m => m.plate === k + 1)?.time_s ?? null, predicted_weight_g: sliced.find(m => m.plate === k + 1)?.weight_g ?? null,
    }));
}
