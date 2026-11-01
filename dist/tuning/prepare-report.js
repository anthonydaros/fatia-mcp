// The report of prepare_print_project: structured JSON plus a short Portuguese summary ("resumo"). Pure: it only reads what the loop recorded.
// The honesty rule it enforces: every claim is VERIFIED (measured on the sliced G-code, the slice result, the mesh or the 3MF), PREDICTED ONLY (fired
// from part facts or guide rules and not checkable by slicing) or UNSEEN (what the engine cannot see). It never says "tested every possibility".
import { getKb, leaves } from "../knowledge/loader.js";
import { printerId } from "../knowledge/tools.js";
import { declarationImpact, factsRead, partContextFacts, skippedByUndeclared, suggestDeclarations } from "./part-context.js";
const WEAK = new Set(["hipotese", "nao verificado"]);
const STRENGTH = ["preset", "oficial", "bug conhecido", "teste de revisor", "relato", "hipotese", "nao verificado"];
const SEVERITY = ["blocker", "warning", "tip"];
const METRICS = [
    ["plate.time_s", "Tempo de impressão estimado (s)"], ["plate.weight_g", "Peso estimado (g)"],
    ["gcode.unprotected_travel_count", "Travels sem retração nem Z-hop"], ["gcode.unprotected_travel_crossing_count", "Travels sem retração que cruzam extrusão da mesma camada"],
    ["gcode.unprotected_travel_curl_risk_count", "Desses, os que cruzam overhang, ponte ou topo"], ["gcode.unprotected_travel_over_20mm_count", "Travels sem retração acima de 20 mm"],
    ["gcode.zhop_lift_count", "Subidas de Z-hop"], ["gcode.support_weight_g", "Peso de suporte (g)"], ["gcode.support_line_count", "Linhas de suporte"],
    ["gcode.first_layer_brim_present", "Brim na primeira camada"], ["plate.tool_changes", "Trocas de ferramenta"], ["plate.waste_weight_g", "Descarte (g)"],
    ["gcode.layer_count", "Camadas"], ["slicer.warning_count", "Avisos do fatiador"],
];
const STOP_TEXT = {
    done: "o motor não tem mais nada a ajustar nas medições",
    stalled: "o motor ficou sem o que mudar e sem poder declarar o projeto pronto",
    exhausted: "as escadas que ainda disparam ficaram sem degraus",
    cycle: "a próxima rodada repetiria uma configuração já testada",
    budget_slices: "acabou o orçamento de fatiamentos",
    budget_minutes: "acabou o orçamento de tempo",
    cancelled: "cancelado",
    error: "um fatiamento falhou",
    dry_run: "plano apenas (dry_run): nada foi fatiado nem medido",
};
export const READY_MEANS = "\"Pronto\" aqui significa: no último fatiamento medido o motor não achou mais nenhum problema que consiga ver e nada do que ele aplicou ficou sem verificação. Não é garantia de impressão: nenhuma impressora foi usada para validar, regras fracas (relato, hipótese) são palpites do guia, e o que o motor não enxerga está na lista UNSEEN.";
/** The slicer's own warnings on a measured round (slicer.warning_count and slicer.warnings, from the slice result). */
const sliceWarnings = (r) => {
    const f = r?.measure?.facts;
    const list = Array.isArray(f?.["slicer.warnings"]) ? f["slicer.warnings"] : [];
    const n = f?.["slicer.warning_count"];
    return list.length || typeof n !== "number" || n === 0 ? list : [`${n} aviso(s) sem texto`];
};
const round2 = (n) => Math.round(n * 100) / 100;
const clip = (text, max = 400) => (text == null ? null : text.length > max ? `${text.slice(0, max - 1)}… (texto completo: consult_knowledge)` : text);
const short = (v, max = 80) => {
    const text = Array.isArray(v) ? (v.length > 1 && v.every(x => x === v[0]) ? `${String(v[0])} (x${v.length})` : v.join(",")) : v === null || v === undefined ? "(ausente)" : String(v);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const triggerFacts = (a) => (a?.kind === "ladder" ? [...new Set([...leaves(a.trigger)].map(l => l.fact))] : []);
/** `plan` is the round the change list comes from, `round` the measured one that judges it (undefined in a dry run), `write` the file that carries it. */
function changeViews(run, round, plan, write) {
    if (!write || !plan)
        return [];
    const upTo = plan.round;
    const actionById = new Map(run.tuning.actions.map(a => [a.id, a]));
    const pick = (slot) => {
        const list = (run.items.get(slot) ?? []).filter(i => i.round <= upTo);
        const item = list[list.length - 1];
        let first = item?.round ?? 0;
        for (let i = list.length - 1; i >= 0 && !list[i].reverted && list[i].kind !== "revert"; i--)
            first = list[i].round;
        return { item, first };
    };
    const views = [];
    const add = (key, scope, from, fromP0, to) => {
        const { item, first } = pick(`${scope === "object" ? "o" : "s"}\0${key}`);
        const a = item ? actionById.get(item.action) : undefined;
        const reached = scope === "object" ? null : (round?.measure?.reach[key] ?? null);
        views.push({
            key, scope, from, from_p0: fromP0, to, action: item?.action ?? "engine", title: a?.title ?? null, kind: item?.kind ?? "definite",
            why: item ? clip(item.why ?? item.rationale) : null, confidence: item?.confidence ?? null, risk: item?.risk ?? null, rules: item?.rules ?? [], src: item?.src ?? [],
            round: item?.round ?? 0, first_round: first, ...(item?.cost ? { cost: item.cost } : {}), ...(item?.expect ? { expect: clip(item.expect) } : {}),
            verification: verification(run, item, a, first, round, reached),
            reached_slice: reached,
        });
    };
    const combined = new Map(write.combined_diff.map(d => [d.key, d.from]));
    for (const c of write.changed_keys)
        add(c.key, c.scope, combined.has(c.key) ? (combined.get(c.key) ?? null) : c.from, c.from, c.to);
    for (const o of write.object_overrides)
        if (!views.some(v => v.scope === "object" && v.key === o.key))
            add(o.key, "object", o.from, o.from, o.to);
    return views;
}
function verification(run, item, a, first, round, reached) {
    const predicted = (note) => ({ status: "predicted_only", note });
    if (!item || !a)
        return predicted("sem ação do motor para esta chave");
    if (!round?.judged || !round.collected || !round.engine)
        return predicted("a rodada que carrega esta mudança não foi medida");
    // The measurement says nothing about a value the slicer did not use: its CONFIG_BLOCK shows another one.
    if (reached === false)
        return predicted("o Bambu Studio não usou este valor no fatiamento (o CONFIG_BLOCK do G-code mostra outro); a medição desta rodada não vale para esta mudança");
    const measured = round.measure.facts;
    if (a.kind === "ladder") {
        const status = round.engine.ladders.find(l => l.action === a.id);
        const before = run.rounds.find(r => r.round === first - 1)?.collected?.facts ?? {};
        const by = triggerFacts(a).map(fact => ({ fact, before: before[fact] ?? null, after: measured[fact] ?? null }));
        if (status?.trigger === false)
            return { status: "verified", outcome: "cleared", by, note: "o gatilho foi medido de novo no fatiamento depois do degrau e não dispara" };
        if (status?.trigger === true)
            return { status: "verified", outcome: "not_cleared", by, note: "o degrau foi aplicado e medido, e o gatilho continua disparando" };
        return predicted("o gatilho da escada não pôde ser avaliado depois do degrau");
    }
    if (a.kind === "choice") { // the engine never compares evaluated_by with a target, and the action's own note says a file cannot show the real effect
        const by = a.evaluated_by?.length ? ` Fatos medidos relacionados: ${a.evaluated_by.join(", ")} (o motor não os compara com uma meta).` : "";
        return predicted(`valor escolhido pelo guia; o efeito real não se mede em arquivo.${by}${a.evaluated_note ? ` ${a.evaluated_note}` : ""}`);
    }
    const read = [...factsRead(a)].filter(f => !f.startsWith("settings."));
    return predicted(`disparou por ${read.length ? read.join(", ") : "regra do guia"}; o fatiamento não consegue medir o efeito disso na peça real`);
}
function metricRows(run, after) {
    const b = run.baseline?.measure.facts;
    const a = after?.measure?.facts;
    return METRICS.map(([fact, label]) => {
        const [x, y] = [b?.[fact], a?.[fact]];
        return { fact, label, before: x ?? null, after: y ?? null, delta: typeof x === "number" && typeof y === "number" ? round2(y - x) : null };
    }).filter(r => r.before !== null || r.after !== null);
}
function untouchedRisks(run) {
    const kb = getKb();
    const scope = printerId(run.input.model);
    const rows = [];
    let tips = 0;
    for (const na of run.tuning.noAction) {
        if (!["hardware", "manual", "risk"].includes(na.reason))
            continue;
        const r = kb.ruleById.get(na.rule);
        if (!r || r.domain !== "bambu" || (r.printers.length && (!scope || !r.printers.includes(scope))))
            continue;
        if (r.severity === "tip") {
            tips++;
            continue;
        }
        rows.push({ rule: r.id, severity: r.severity, confidence: r.confidence, title: r.title, advice: r.solution.message || r.solution.steps.slice(0, 3).join(" "), why_untouched: na.note, src: r.src });
    }
    rows.sort((x, y) => SEVERITY.indexOf(x.severity) - SEVERITY.indexOf(y.severity) || STRENGTH.indexOf(x.confidence) - STRENGTH.indexOf(y.confidence) || (x.rule < y.rule ? -1 : 1));
    return { printer: scope ?? run.input.model, note: "Regras sem ajuste possível no projeto (hardware, conferência manual, risco). Filtradas pela impressora, não pelo material. O motor não mexe nelas: confira você.", shown: rows.length, tips_not_listed: tips, items: rows.slice(0, 30) };
}
const lastMeasured = (run) => [...run.rounds].reverse().find(r => r.measure && r.judged);
/** A ladder is only seen exhausted in the round that ran out of steps, which is the last one, not always the delivered one. */
const exhaustedLadders = (run) => lastMeasured(run)?.judged?.exhausted ?? [];
/** The verdict and its reasons. ready only when nothing is left to say; every caveat is listed. */
function decide(run, views) {
    const best = run.best;
    const judged = best?.judged;
    const stop = run.stop.reason;
    const notReady = [];
    const blockers = [...run.preflight.blockers.map(b => String(b.rule_id)), ...(judged?.blockers.map(b => b.rule) ?? [])];
    if (blockers.length)
        notReady.push({ code: "blocker", text: `Regra(s) de severidade bloqueadora disparou: ${[...new Set(blockers)].join(", ")}.` });
    if (stop === "error")
        notReady.push({ code: "failed_slice", text: run.stop.detail });
    if (stop === "cancelled")
        notReady.push({ code: "cancelled", text: run.stop.detail });
    if (stop === "dry_run")
        notReady.push({ code: "dry_run", text: run.stop.detail });
    if (!best && stop !== "cancelled" && stop !== "dry_run")
        notReady.push({ code: "nothing_measured", text: "Nenhuma rodada foi fatiada e medida com sucesso: não há projeto entregue." });
    if (run.source.sha256_before !== run.source.sha256_after)
        notReady.push({ code: "source_changed", text: "O arquivo original mudou durante a execução." });
    const caveats = [];
    const add = (code, text) => caveats.push({ code, text });
    if (stop === "budget_slices" || stop === "budget_minutes")
        add("budget", `Parou pelo orçamento (${STOP_TEXT[stop]}); o motor ainda queria ${run.pending.length} mudança(s) que não foram testadas.`);
    if (stop === "stalled" || stop === "cycle")
        add("not_converged", `O laço não chegou a "pronto": ${run.stop.detail}`);
    const last = lastMeasured(run);
    if (best && last && best !== last)
        add("earlier_round_delivered", `Foi entregue a rodada ${best.round}, não a última medida (${last.round}): ${run.bestWhy}.`);
    const exhausted = exhaustedLadders(run);
    if (exhausted.length)
        add("exhausted_ladders", `Escada(s) sem degraus e o problema continua: ${exhausted.map(e => e.action).join(", ")}.`);
    else if (judged?.triggers_true.length)
        add("unresolved_trigger", `Gatilho(s) ainda disparando no fatiamento entregue: ${judged.triggers_true.join(", ")}.`);
    const predicted = views.filter(v => v.verification.status === "predicted_only");
    if (predicted.length)
        add("predicted_only_applied", `${predicted.length} mudança(s) aplicada(s) só por previsão (nenhuma medição confirma o efeito): ${predicted.slice(0, 8).map(v => v.key).join(", ")}${predicted.length > 8 ? ", …" : ""}.`);
    const ignored = views.filter(v => v.reached_slice === false);
    if (ignored.length)
        add("not_reached_slice", `O Bambu Studio não usou ${ignored.length} valor(es) no fatiamento medido, então a medição não confirma: ${ignored.slice(0, 8).map(v => v.key).join(", ")}.`);
    const weak = views.filter(v => v.confidence !== null && WEAK.has(v.confidence));
    if (weak.length)
        add("weak_steps_applied", `${weak.length} mudança(s) de confiança fraca (hipótese ou não verificado), aplicada(s) porque um gatilho medido as confere: ${weak.slice(0, 8).map(v => v.key).join(", ")}.`);
    const warned = sliceWarnings(best);
    if (warned.length)
        add("slicer_warnings", `O próprio Bambu Studio avisou no fatiamento entregue: ${warned.slice(0, 5).map(w => clip(w, 160)).join(" | ")}${warned.length > 5 ? ` | … e mais ${warned.length - 5}` : ""}.`);
    if (judged?.blind_facts.length)
        add("blind_facts", `Fatos que o motor não consegue ver e que seguram uma decisão: ${judged.blind_facts.join(", ")}.`);
    const declared = Object.keys(partContextFacts(run.declared).facts);
    const usedDeclared = declared.filter(f => views.some(v => { const a = run.tuning.actions.find(x => x.id === v.action); return a && factsRead(a).has(f); }));
    if (usedDeclared.length)
        add("declared_unchecked", `Fatos declarados por você que decidiram mudanças e que nenhuma medição confere: ${usedDeclared.join(", ")}.`);
    if (run.preflight.error)
        add("preflight_unavailable", `O preflight_check não pôde julgar o arquivo (${run.preflight.error}): bloqueadores de estrutura e volume não foram conferidos.`);
    const verdict = notReady.length ? "not_ready" : stop === "done" && caveats.length === 0 ? "ready" : "ready_with_caveats";
    return { verdict, not_ready: notReady, caveats };
}
const VERDICT_PT = { ready: "PRONTO", ready_with_caveats: "PRONTO COM RESSALVAS", not_ready: "NÃO PRONTO" };
export function buildReport(run) {
    const dry = run.stop.reason === "dry_run";
    const planRound = dry ? run.rounds[0] : run.best;
    const ref = run.delivered?.write ?? planRound?.write;
    const views = changeViews(run, run.best, planRound, ref);
    const { verdict, not_ready, caveats } = decide(run, views);
    const engine = planRound?.engine;
    const judged = run.best?.judged;
    const collected = planRound?.collected;
    const undescribed = engine ? skippedByUndeclared(engine) : undefined;
    const undescribedText = undescribed?.count ? `${undescribed.count} ação(ões) não foram avaliadas porque a peça não foi descrita: ${Object.entries(undescribed.by_fact).sort((a, b) => b[1].length - a[1].length).map(([f, ids]) => `${f} (${ids.length})`).join(", ")}. Declare o que o usuário disse em part_context e rode de novo.` : "Nenhuma ação foi pulada por falta de descrição da peça.";
    const provided = Object.keys(collected?.facts ?? {});
    const declare = engine
        ? declarationImpact(run.tuning.actions, provided).filter(i => !i.declared && undescribed?.by_fact[i.fact]).map(i => ({ fact: i.fact, would_enable: i.actions.filter(a => undescribed.by_fact[i.fact].includes(a.id)).map(a => ({ action: a.id, title: a.title, also_needs: a.also_needs })) }))
        : [];
    const otherSkips = engine ? [...engine.skipped_unknown.map(s => ({ action: s.action, reason: s.reason, missing: s.missing })), ...engine.unknown.map(u => ({ action: u.action, reason: `ladder ${u.where} unknown`, missing: [...u.missing, ...u.blind] }))]
        .filter(s => s.missing.some(f => !f.startsWith("object."))).slice(0, 40) : [];
    const suggestions = engine ? [...new Map(engine.suggested.map(s => [`${s.action}\0${s.key}`, s])).values()].map(s => ({
        action: s.action, key: s.key, scope: s.scope, would_set: s.to, from: s.from, confidence: s.confidence, risk: s.risk, why: clip(s.rationale), rules: s.rules, src: s.src,
        reason: `confiança "${s.confidence}" é fraca: fica só como sugestão (apply: ${run.input.apply})`,
    })) : [];
    const warnings = [...run.warnings];
    const worse = run.best?.judged && run.baseline && run.baseline.measure.facts["gcode.unprotected_travel_crossing_count"] < run.best.measure?.facts["gcode.unprotected_travel_crossing_count"];
    if (worse)
        warnings.push("O projeto entregue tem MAIS travels que cruzam extrusão do que o projeto sem ajustes: confira antes de usar.");
    const predictedOnly = views.filter(v => v.verification.status === "predicted_only").map(v => ({ key: v.key, to: v.to, action: v.action, confidence: v.confidence, why: v.why, basis: v.verification.note, src: v.src }));
    const verifiedChanges = views.filter(v => v.verification.status === "verified").map(v => ({ key: v.key, to: v.to, action: v.action, outcome: v.verification.outcome, by: v.verification.by, reached_slice: v.reached_slice }));
    const evidence = collected?.evidence ?? {};
    const unseenFacts = (collected?.unavailable ?? []).slice(0, 40).map(f => ({ fact: f, why: evidence[f]?.notes ?? "" }));
    const kb = getKb();
    const bambu = kb.rules.filter(r => r.domain === "bambu");
    const weakShare = bambu.length ? Math.round((bambu.filter(r => ["relato", "hipotese", "nao verificado"].includes(r.confidence)).length / bambu.length) * 100) : null;
    const measuredNow = judged ? {
        metrics: metricRows(run, run.best).filter(r => r.after !== null).map(r => ({ fact: r.fact, value: r.after })),
        ladders_cleared: [...new Set(views.filter(v => v.verification.outcome === "cleared").map(v => v.action))],
        gcode_blockers_checked_and_clear: judged.blockers_clear,
        slicer_warnings: sliceWarnings(run.best),
        values_reached_the_slice: views.filter(v => v.reached_slice === true).map(v => v.key),
        source_untouched: run.source.sha256_before === run.source.sha256_after,
        deliverable_reopened_and_checked_by_the_writer: !!run.delivered,
    } : undefined;
    const unseen = {
        blind_facts: (engine?.blind_facts ?? []).map(f => ({ fact: f, why: evidence[f]?.notes ?? "" })),
        facts_no_analyzer_can_give: unseenFacts,
        gcode_blockers_not_decidable: (judged?.blockers_unknown ?? []).map(b => ({ rule: b.rule, title: b.title, missing: b.missing })),
        preflight_unchecked: run.preflight.unchecked ?? null,
        actions_skipped_for_lack_of_a_part_description: undescribed?.count ?? 0,
        weak_rules: weakShare === null ? "" : `${weakShare}% das regras de Bambu Studio da base são fracas (relato, hipótese ou não verificado): o guia sugere, nenhuma medição própria confirmou.`,
        no_printer: "Nenhuma impressora foi usada para validar: empenamento, aderência, queda de peça e qualidade real da superfície não são medidos por fatiamento.",
    };
    const stopOut = {
        reason: run.stop.reason, text: STOP_TEXT[run.stop.reason], detail: run.stop.detail, rounds_measured: run.rounds.filter(r => r.measure).length,
        slices_used: { loop: run.slices.loop, retarget: run.slices.retarget, total: run.slices.loop + run.slices.retarget, max: run.slices.max },
        minutes_used: run.minutes, max_minutes: run.input.maxMinutes,
    };
    const history = run.rounds.map(r => ({
        round: r.round, settings_hash: r.hash,
        slice: r.measure ? { measured: true, ms: r.measure.ms, reused_from: r.measure.reused_from ?? null } : { measured: false, error: r.error ?? null },
        print_time_s: r.measure?.facts["plate.time_s"] ?? null, weight_g: r.measure?.facts["plate.weight_g"] ?? null,
        metrics: Object.fromEntries(METRICS.map(([f]) => [f, r.measure?.facts[f] ?? null]).filter(([, v]) => v !== null)),
        changes: r.changes.map(c => ({ action: c.action, key: c.key, scope: c.scope, from: c.from, to: c.to, confidence: c.confidence, kind: c.kind, ...(c.level ? { level: c.level, step: c.step } : {}) })),
        advanced: r.advanced, relaxed: r.relaxed,
        triggers: r.judged ? { true: r.judged.triggers_true, unknown: r.judged.triggers_unknown, false: r.judged.triggers_false } : null,
        exhausted: r.judged?.exhausted.map(e => e.action) ?? [], blockers: r.judged?.blockers.map(b => b.rule) ?? [],
        done: r.judged?.done ?? false, stalled: r.judged?.stalled ?? false, delivered: r === run.best && !dry,
    }));
    const diffTuning = views.map(v => ({
        key: v.key, from: v.from, to: v.to, scope: v.scope, action: v.action, title: v.title, kind: v.kind, why: v.why, confidence: v.confidence, risk: v.risk, rules: v.rules, src: v.src,
        round: v.round, first_round: v.first_round, ...(v.cost ? { cost: v.cost } : {}), ...(v.expect ? { expect: v.expect } : {}),
        verified: v.verification.status === "verified", verification: v.verification, reached_slice: v.reached_slice,
    }));
    const report = {
        tool: "prepare_print_project",
        verdict,
        verdict_text: VERDICT_PT[verdict],
        reasons: [...not_ready.map(x => ({ kind: "not_ready", ...x })), ...caveats.map(x => ({ kind: "caveat", ...x }))],
        not_ready_reasons: not_ready,
        caveats,
        ready_means: READY_MEANS,
        stop: stopOut,
        delivered: run.delivered ? {
            path: run.delivered.path, round: run.best?.round ?? null, why_this_round: run.bestWhy ?? null, sliced: false,
            opened_in_studio: !!run.delivered.opened, open_error: run.delivered.open_error ?? null,
            note: "Projeto NOVO e sem fatiar: abra no Bambu Studio, revise os ajustes listados em diff.tuning, fatie e imprima você mesmo. A ferramenta nunca imprime.",
        } : null,
        source: { path: run.source.path, sha256_before: run.source.sha256_before, sha256_after: run.source.sha256_after, unchanged: run.source.sha256_before === run.source.sha256_after },
        printer: { model: run.input.model, preset: run.printerPreset, studio_installed: run.installed },
        part: { plate_index: run.input.plateIndex, declared: run.declared, mesh: { size_x_mm: run.mesh.facts["mesh.size_x_mm"] ?? null, size_y_mm: run.mesh.facts["mesh.size_y_mm"] ?? null, height_mm: run.mesh.facts["mesh.height_mm"] ?? null, triangles: run.mesh.stats.triangles }, questions_for_the_user: suggestDeclarations(run.mesh.facts) },
        diff: {
            retarget: ref ? { applied: ref.retarget.applied, reason: ref.retarget.reason, printer_ids: ref.retarget.printer_ids, kept: ref.retarget.kept.slice(0, 30), not_kept: ref.retarget.not_kept.slice(0, 30), changed_keys_count: ref.retarget.changed_keys.length, changed_keys_shown: Math.min(30, ref.retarget.changed_keys.length), changed_keys: ref.retarget.changed_keys.slice(0, 30) } : run.p0.retarget,
            tuning: diffTuning,
            combined_vs_original: { count: ref?.combined_diff.length ?? 0, shown: Math.min(40, ref?.combined_diff.length ?? 0), keys: (ref?.combined_diff ?? []).slice(0, 40) },
            unchanged_requested: ref?.unchanged_keys ?? [],
        },
        metrics: { baseline_error: run.baselineError ?? null, rows: metricRows(run, planRound), note: "plate.weight_g pode ou não incluir descarte e torre: compare só entre fatiamentos deste mesmo projeto." },
        history,
        suggestions_not_applied: suggestions,
        skipped: { for_undescribed_part: undescribed ? { count: undescribed.count, text: undescribedText, by_fact: undescribed.by_fact } : null, declare_to_enable: declare, other: otherSkips },
        ladders: {
            unresolved: (judged?.triggers_true ?? []).filter(id => !exhaustedLadders(run).some(e => e.action === id)),
            exhausted: exhaustedLadders(run).map(e => ({ action: e.action, title: e.title, steps: e.steps, text: e.text, rules: e.rules })),
        },
        pending_next_round: run.pending.map(c => ({ action: c.action, key: c.key, to: c.to, confidence: c.confidence })),
        blockers: {
            preflight: run.preflight.blockers.map(b => ({ rule_id: b.rule_id, title: b.title, problem: b.problem, confidence: b.confidence, evidence: b.evidence, fix: b.fix })),
            preflight_checked_file: run.preflight.checked,
            gcode: judged?.blockers ?? [],
        },
        verified: measuredNow ? { measured: measuredNow, changes: verifiedChanges } : { measured: null, changes: [] },
        predicted_only: predictedOnly,
        unseen,
        untouched_risks: untouchedRisks(run),
        warnings,
        kb: { tuning_version: run.tuning.version ?? null, integrity: run.tuning.integrity ?? null },
    };
    report.resumo = resumo(run, report, views, { verdict, not_ready, caveats });
    return report;
}
function resumo(run, report, views, d) {
    const lines = [];
    const name = run.delivered ? run.delivered.path.split(/[\\/]/).pop() : run.source.path.split(/[\\/]/).pop();
    lines.push(`## Projeto preparado: ${name}`, "", `**Veredito: ${VERDICT_PT[d.verdict]}.** ${(d.not_ready.length ? d.not_ready : d.caveats).slice(0, 3).map(r => r.text).join(" ") || `O motor não achou mais nada que consiga ver nas medições; veja o que ele não enxerga em UNSEEN.${report.unseen.actions_skipped_for_lack_of_a_part_description ? ` ${report.unseen.actions_skipped_for_lack_of_a_part_description} ação(ões) nem foram avaliadas porque a peça não foi descrita.` : ""}`}`, "");
    const s = report.stop;
    lines.push(`- Parada: ${s.text}. ${s.slices_used.total} de ${s.slices_used.max} fatiamentos${s.slices_used.retarget ? ` (${s.slices_used.retarget} só para montar o projeto)` : ""}, ${s.minutes_used} min, ${s.rounds_measured} rodada(s) medida(s).`);
    if (run.delivered)
        lines.push(`- Arquivo novo, sem fatiar (o original não foi tocado): \`${run.delivered.path}\` — ${run.delivered.opened ? "aberto no Bambu Studio" : "não aberto no Studio"}. Rodada entregue: ${run.best?.round}.`);
    else
        lines.push(`- Nenhum arquivo foi entregue. O original não foi tocado.`);
    if (views.length) {
        lines.push("", `### Mudanças (${views.length})`);
        for (const v of views.slice(0, 14))
            lines.push(`- \`${v.key}\`: ${short(v.from, 30)} → ${short(v.to, 30)} [${v.confidence ?? "?"}, ${v.action}, rodada ${v.round}] — ${v.verification.status === "verified" ? `VERIFICADO${v.verification.outcome === "not_cleared" ? " (aplicado, mas o problema continua)" : ""}` : "SÓ PREVISTO"}`);
        if (views.length > 14)
            lines.push(`- … e mais ${views.length - 14} (veja \`diff.tuning\`).`);
    }
    else
        lines.push("", "### Mudanças", "- Nenhuma: o motor não achou o que ajustar.");
    const rows = report.metrics.rows.filter(r => r.before !== null && r.after !== null && r.before !== r.after).slice(0, 6);
    if (rows.length)
        lines.push("", "### Antes → depois (medido no G-code / resultado do fatiamento)", ...rows.map(r => `- ${r.label}: ${short(r.before)} → ${short(r.after)}`));
    else if (run.baseline && run.best?.measure)
        lines.push("", "### Antes → depois", "- Sem diferença medida nos números acompanhados.");
    if (d.caveats.length)
        lines.push("", "### Ressalvas", ...d.caveats.map(c => `- ${c.text}`));
    if (report.ladders.exhausted.length)
        lines.push("", "### Escadas esgotadas", ...report.ladders.exhausted.map((e) => `- \`${e.action}\`: veja \`ladders.exhausted\` para o que a configuração não alcança.`));
    const skipped = report.skipped.for_undescribed_part;
    if (skipped?.count)
        lines.push("", "### Não avaliado porque a peça não foi descrita", `- ${skipped.text}`);
    if (report.suggestions_not_applied.length)
        lines.push("", `### Sugestões fracas não aplicadas (${report.suggestions_not_applied.length})`, "- Veja `suggestions_not_applied`: ficam por sua decisão.");
    lines.push("", "### Riscos que ninguém ajusta por você", `- ${report.untouched_risks.shown} verificação(ões) de hardware/manual (ex.: folga do bico, parafusos soltos, filamento úmido) estão em \`untouched_risks\`.`);
    if (report.warnings.length)
        lines.push("", "### Avisos", ...report.warnings.slice(0, 5).map((w) => `- ${w}`));
    lines.push("", `> ${READY_MEANS}`);
    return lines.join("\n");
}
