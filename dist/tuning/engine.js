// Tuning engine: the TypeScript port of kb/tuning/evaluate-tuning.mjs (the reference). Pure: no IO, no clock, no randomness, and it
// never mutates its input (state included). Parity with the reference is what tests/tuning-engine.test.mjs proves (eval.json + a
// golden file of reference outputs). The decisions below are the reference's; read its header before changing any of them.
//
// Facts = {"settings.<k>": base value for every base key} overlaid by the given facts (explicit facts win). Conditions and refs are
//   evaluated against the BASE project in every round (no cascading). Facts are never carried between rounds: a missing fact is unknown.
// applyTuning = round 0 (default phase pre-slice), nextRound = round state.round+1 (default phase all). One core; round 0 = every level 0.
// definite/choice: selected when printers, applies_to and `when` are true; STICKY (state.applied) once written, so a measured condition that
//   clears after the fix does not undo it. Suggest-only, false and unknown actions are re-evaluated every round.
// ladder: `when` unknown/false -> no move; `when` true and trigger true -> level+1 (one step per round) or exhausted at the last level;
//   trigger unknown -> the level never moves; relax:true and level>0 -> trigger false twice in a row steps one level back. Level k writes
//   the fold of steps 1..k every round (no un-doing). A step that is already in effect, or whose only_if guard is provably false, is
//   skipped (advanced[].skipped_noop) and never written.
// Conflicts per (scope,key): priority, then stronger confidence, then lower risk, then id. A winning bound (at_least/at_most) is folded
//   over the highest-order written set-mode loser instead of erasing it (bound-on-top). `elements` limits a list write to labelled elements.
// done (rounds >= 1) = no ladder trigger true, no ladder unknown for a fact that should be available, and nothing changed this round.
//
// Intentional differences from the reference, both unreachable with the shipped tuning.json (the parity test proves it):
//  - The three-valued evaluator is src/knowledge/condition.ts: two "%" strings compare numerically there ("15.0%" == "15%") and as plain
//    strings in the reference; a `matches` subject over 4096 characters or an invalid regex is unknown there and throws in the reference.
//  - applies_to uses src/knowledge/version.ts: ">", "<=" and "=" with a truncated version ("> 2.8") count the missing segments as 0 there
//    and compare only the segments named in the reference. scripts/validate-knowledge.mjs rejects those three forms in tuning.json.
import { evalCondition, modelId } from "../knowledge/condition.js";
import { leaves } from "../knowledge/loader.js";
import { matchVersion, parseVersionPredicate } from "../knowledge/version.js";
export const CONF = ["preset", "oficial", "bug conhecido", "teste de revisor", "relato", "hipotese", "nao verificado"]; // strong -> weak
export const APPLY_DEFAULT = CONF.slice(0, 5);
export const RISK = ["low", "medium", "high"];
export const KINDS = ["definite", "choice", "ladder"];
export const LADDER_COST = ["tempo", "material", "qualidade", "resistencia", "nenhum"];
const tri = (c, facts) => evalCondition(c, facts) ?? null;
const and3 = (a, b) => (a === false || b === false ? false : a === null || b === null ? null : true);
// \d+(\.\d*)? and not \d+\.?\d*: same language, but overlapping digit runs backtrack quadratically on a hostile 3MF value.
const NUM = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const PCT = /^[-+]?(\d+(\.\d*)?|\.\d+)%$/;
const unit = (v) => (typeof v !== "string" ? null : NUM.test(v.trim()) ? "n" : PCT.test(v.trim()) ? "%" : null);
const val = (v) => Number(String(v).replace("%", ""));
/** Two numeric strings compare numerically ("0.20" == "0.2"), two percents too ("15%" == "15.0%"), a number never equals a percent, the rest as strings. */
export const same = (a, b) => (unit(a) && unit(a) === unit(b) ? val(a) === val(b) : String(a) === String(b));
const fmt = (x, round) => String(Number(x.toFixed(round ?? 6)));
const clone = (x) => JSON.parse(JSON.stringify(x));
const kindOf = (a) => a.kind ?? "definite";
const eqv = (x, y) => Array.isArray(x) || Array.isArray(y) ? Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => same(v, y[i])) : same(x, y);
const blindTest = (list = []) => (f) => list.some(p => (p.endsWith(".") ? f.startsWith(p) : f === p));
const missingFacts = (c, facts) => [...new Set([...leaves(c)].map(l => l.fact).filter(f => facts[f] === undefined || facts[f] === null))];
const uncond = (c) => !!c && "all" in c && Array.isArray(c.all) && !c.all.length && Object.keys(c).length === 1;
/** What one contribution wants for one key against the base value. `elements` restricts the write to the list elements whose label in the
 *  aligned base list `index_by` starts with `starts_with`; without such a list the selection is unknowable ("unresolvable-elements"). */
function resolve(mode, key, spec, base, studioKeys, elements) {
    const b = base[key];
    const isList = Array.isArray(b) || (b === undefined && !!studioKeys?.[key]?.is_list);
    const n = Array.isArray(b) ? b.length : isList ? studioKeys[key].project_array_len || 1 : 1;
    const bi = (i) => (Array.isArray(b) ? b[i] : b);
    let sel = null;
    if (elements) {
        const idx = base[elements.index_by];
        if (!Array.isArray(b) || !Array.isArray(idx) || idx.length !== n)
            return { unresolved: "unresolvable-elements", missing: [`settings.${Array.isArray(b) ? elements.index_by : key}`] };
        sel = idx.map(v => String(v).startsWith(elements.starts_with));
    }
    const target = [];
    for (let i = 0; i < n; i++) {
        if (typeof spec === "string")
            target.push(spec);
        else {
            const rk = String(spec.ref).replace(/^settings\./, "");
            const r = base[rk];
            const s = Array.isArray(r) ? (r.length === n ? r[i] : r[0]) : r;
            if (unit(s) !== "n")
                return { unresolved: "unresolvable-ref", missing: [`settings.${rk}`] };
            target.push(fmt(val(s) * (spec.mul ?? 1) + (spec.add ?? 0), spec.round));
        }
    }
    const to = target.map((t, i) => {
        if (sel && !sel[i])
            return bi(i);
        if (mode === "set" || bi(i) === undefined)
            return t;
        if (!unit(t) || unit(t) !== unit(bi(i)))
            return null;
        return (mode === "at_least" ? val(bi(i)) < val(t) : val(bi(i)) > val(t)) ? t : bi(i);
    });
    if (to.includes(null))
        return { unresolved: "unit-mismatch" };
    return { from: b === undefined ? null : b, to: isList ? to : to[0], unchanged: to.every((t, i) => bi(i) !== undefined && same(bi(i), t)) };
}
/** printers, applies_to and `when` AND-ed three-valued (throws with the action id on malformed input). */
function select(a, all, printer, version) {
    let st = true;
    const missing = [];
    try {
        if (a.printers?.length) {
            const ok = printer === undefined || printer === null ? null : [].concat(printer).every(x => a.printers.includes(modelId(x)));
            if (ok === null)
                missing.push("printer.model");
            st = and3(st, ok);
        }
        if (a.applies_to?.bambu_studio !== undefined) {
            if (!parseVersionPredicate(a.applies_to.bambu_studio))
                throw new TypeError(`bad version predicate "${a.applies_to.bambu_studio}"`);
            const m = matchVersion(a.applies_to.bambu_studio, version === undefined || version === null ? null : String(version));
            const ok = m === "unknown" ? null : m === "applies";
            if (ok === null)
                missing.push("studio.version");
            st = and3(st, ok);
        }
        const w = uncond(a.when) ? true : tri(a.when, all);
        if (w === null)
            missing.push(...missingFacts(a.when, all));
        st = and3(st, w);
    }
    catch (e) {
        throw new Error(`action ${a.id}: ${e.message}`);
    }
    return { st, missing: [...new Set(missing)] };
}
function ladderTrigger(a, all) {
    if (!a.trigger || !Array.isArray(a.steps) || !a.steps.length)
        throw new Error(`action ${a.id}: a ladder needs a trigger and steps`);
    try {
        const v = tri(a.trigger, all);
        return { v, missing: v === null ? missingFacts(a.trigger, all) : [] };
    }
    catch (e) {
        throw new Error(`action ${a.id}: ${e.message}`);
    }
}
function specsOf(a) {
    if (kindOf(a) === "choice") {
        const c = a;
        if (c.candidates?.[c.start] === undefined)
            throw new Error(`action ${a.id}: choice start ${c.start} is not a candidate index`);
        return [{ key: c.key, spec: c.candidates[c.start], mode: "set" }];
    }
    const d = a;
    return Object.entries(d.set ?? {}).map(([key, spec]) => ({ key, spec, mode: d.mode ?? "set", elements: d.elements }));
}
/** True when a ladder step is not worth a slice round: its `only_if` guard (settings.* over the base project) is provably false, or every key
 *  already has the step's target (resolved against the base) in `cur`, the settings in effect (round 0: the base; later: the previous round's). */
function skipStep(a, step, all, base, cur, studioKeys) {
    try {
        if (step.only_if && tri(step.only_if, all) === false)
            return true;
    }
    catch (e) {
        throw new Error(`action ${a.id}: only_if: ${e.message}`);
    }
    return Object.entries(step.set).every(([k, v]) => {
        const r = resolve("set", k, v, base, studioKeys);
        return !("unresolved" in r) && (r.unchanged || eqv(cur[k], r.to));
    });
}
/** A fresh state for nextRound/simulate. */
export function initialState(base = {}) {
    return { base: clone(base), settings: clone(base), object_overrides: {}, levels: {}, quiet: {}, skipped: {}, applied: {}, owners: {}, history: [], round: -1 };
}
/** The one round: actions, st0 (not mutated), the facts of this round, options. Returns the round result including the new state. */
function core(tuning, st0, facts, options, round, defaultPhase) {
    const applySet = new Set(options.applyConfidences ?? APPLY_DEFAULT);
    const phase = options.phase ?? defaultPhase;
    const isBlind = blindTest(options.unavailable);
    const st = clone(st0);
    const base = st.base;
    const all = { ...Object.fromEntries(Object.entries(base).map(([k, v]) => [`settings.${k}`, v])), ...facts };
    const printer = options.printer ?? all["printer.model"];
    const version = options.studioVersion ?? all["studio.version"];
    const out = {
        round, changes: [], suggested: [], unchanged_already: [], skipped_unknown: [], conflicts: [], object_overrides: {}, settings_after: clone(base),
        advanced: [], relaxed: [], exhausted: [], unknown: [], ladders: [], choices: [], done: false, stalled: false, missing_facts: [], blind_facts: [], state: st,
    };
    const prev = { s: st.settings, o: st.object_overrides };
    const byId = new Map(tuning.map(a => [a.id, a]));
    const split = (miss) => ({ missing: miss.filter(f => !isBlind(f)), blind: miss.filter(isBlind) });
    const contribs = [];
    const relaxEvents = [];
    for (const a of tuning) {
        const kind = kindOf(a);
        if (!KINDS.includes(kind))
            throw new Error(`action ${a.id}: bad kind ${kind}`);
        if (phase !== "all" && a.phase !== phase)
            continue;
        if (kind !== "ladder") {
            const fresh = !st.applied[a.id];
            if (fresh) {
                const s = select(a, all, printer, version);
                if (s.st === null) {
                    out.skipped_unknown.push({ action: a.id, missing: s.missing, rules: a.rules, reason: "unknown-condition" });
                    continue;
                }
                if (!s.st)
                    continue;
            }
            for (const sp of specsOf(a))
                contribs.push({ a, ...sp, kind, fresh, conf: a.confidence, src: a.src });
            continue;
        }
        // ladder
        const lad = a;
        const lvl0 = st.levels[a.id] ?? 0;
        let lvl = lvl0, quiet = st.quiet[a.id] ?? 0, trig;
        const sk = new Set((st.skipped?.[a.id] ?? []).filter(i => i < lvl0)); // 0-based indices of steps below the level that were skipped (never written)
        const s = select(a, all, printer, version);
        if (s.st === null) {
            out.unknown.push({ action: a.id, where: "when", ...split(s.missing), rules: a.rules });
            quiet = 0;
        }
        else if (s.st) {
            const t = ladderTrigger(lad, all);
            trig = t.v;
            if (t.v === null) {
                out.unknown.push({ action: a.id, where: "trigger", ...split(t.missing), rules: a.rules });
                quiet = 0;
            }
            else if (t.v) {
                quiet = 0;
                // A step that is already in effect, or whose only_if guard is false, is skipped (no slice round is spent on it); when every
                // remaining step is skipped the ladder is exhausted right away.
                const cur = a.scope === "object" ? { ...base, ...st.object_overrides } : st.settings;
                let to = lvl + 1;
                if (lvl < lad.steps.length)
                    while (to <= lad.steps.length && skipStep(lad, lad.steps[to - 1], all, base, cur, options.studioKeys))
                        sk.add(to++ - 1);
                if (lvl < lad.steps.length && to <= lad.steps.length) {
                    lvl = to;
                    out.advanced.push({ action: a.id, from: lvl0, to: lvl, steps: lad.steps.length, why: lad.steps[lvl - 1].why, ...(to > lvl0 + 1 ? { skipped_noop: to - lvl0 - 1 } : {}) });
                }
                else {
                    lvl = lad.steps.length;
                    out.exhausted.push({ action: a.id, level: lvl, steps: lad.steps.length, title: a.title, text: lad.exhausted, rules: a.rules });
                }
            }
            else if (lad.relax && lvl > 0 && ++quiet >= 2) {
                quiet = 0;
                lvl--;
                relaxEvents.push({ a: lad, from: lvl0, to: lvl, step: lad.steps[lvl0 - 1] });
                out.relaxed.push({ action: a.id, from: lvl0, to: lvl });
            }
        }
        else
            quiet = 0;
        st.levels[a.id] = lvl;
        st.quiet[a.id] = quiet;
        (st.skipped ?? (st.skipped = {}))[a.id] = [...sk].sort((x, y) => x - y);
        out.ladders.push({ action: a.id, level: lvl, steps: lad.steps.length, relevant: s.st, ...(trig === undefined ? {} : { trigger: trig }) });
        const writes = new Map();
        for (let i = 0; i < lvl; i++)
            if (!sk.has(i))
                for (const [key, spec] of Object.entries(lad.steps[i].set))
                    writes.set(key, { spec, i });
        for (const [key, { spec, i }] of writes)
            contribs.push({ a, key, spec, mode: "set", kind, fresh: lvl > lvl0, conf: lad.steps[i].confidence, src: lad.steps[i].src, step: i, level: lvl });
    }
    // conflicts per (scope,key); a winner is resolved against the base and diffed against the previous round
    const groups = new Map();
    for (const c of contribs) {
        const g = `${c.a.scope}\0${c.key}`;
        if (!groups.has(g))
            groups.set(g, []);
        groups.get(g).push(c);
    }
    const order = (x, y) => (y.a.priority - x.a.priority) || (CONF.indexOf(x.conf) - CONF.indexOf(y.conf)) || (RISK.indexOf(x.a.risk) - RISK.indexOf(y.a.risk)) || (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0);
    const tag = (scope) => (scope === "object" ? "o" : "s");
    const usable = (c) => c.kind === "ladder" || applySet.has(c.conf); // written, not just suggested
    for (const list of groups.values()) {
        list.sort(order);
        const [w, ...losers] = list;
        // Bound-on-top: a winner that is a bound does not erase the losers it is compatible with. The highest-order written set-mode contributor
        // gives the starting value (instead of the base value) and every written bound of the winner's own direction is folded over it (at_most
        // by min, at_least by max, each only on its own `elements`). The owner of the result is the last contributor that changed the value.
        // A weak (suggested) winner keeps the plain winner-takes-all rule.
        let r, owner = w;
        const combined = new Set();
        if (w.mode !== "set" && usable(w)) {
            const setter = losers.find(l => l.mode === "set" && usable(l));
            let cur = base;
            let touched = false;
            if (setter) {
                const rs = resolve("set", setter.key, setter.spec, base, options.studioKeys, setter.elements);
                if (!("unresolved" in rs)) {
                    cur = { ...base, [w.key]: rs.to };
                    owner = setter;
                    combined.add(setter);
                    touched = true;
                }
            }
            for (const b of [w, ...losers.filter(l => l.mode === w.mode && usable(l))]) {
                const rb = resolve(b.mode, b.key, b.spec, cur, options.studioKeys, b.elements);
                if ("unresolved" in rb) {
                    out.skipped_unknown.push({ action: b.a.id, key: w.key, missing: rb.missing ?? [], rules: b.a.rules, reason: rb.unresolved });
                    continue;
                }
                if (b !== w)
                    combined.add(b);
                if (!rb.unchanged)
                    owner = b;
                cur = { ...cur, [w.key]: rb.to };
                touched = true;
            }
            r = touched ? { from: base[w.key] === undefined ? null : base[w.key], to: cur[w.key], unchanged: eqv(base[w.key], cur[w.key]) } : { skipped: true };
        }
        else
            r = resolve(w.mode, w.key, w.spec, base, options.studioKeys, w.elements);
        for (const l of losers) {
            const reason = w.a.priority !== l.a.priority ? "priority" : w.conf !== l.conf ? "confidence" : w.a.risk !== l.a.risk ? "risk" : "id-order";
            out.conflicts.push({ scope: w.a.scope, key: w.key, winner: w.a.id, loser: l.a.id, reason, same_value: JSON.stringify(w.spec) === JSON.stringify(l.spec), winner_value: w.spec, loser_value: l.spec, ...(combined.has(l) ? { combined: true } : {}) });
        }
        if ("skipped" in r)
            continue;
        if ("unresolved" in r) {
            out.skipped_unknown.push({ action: owner.a.id, key: w.key, missing: r.missing ?? [], rules: owner.a.rules, reason: r.unresolved });
            continue;
        }
        const item = { action: owner.a.id, key: w.key, scope: owner.a.scope, kind: owner.kind, mode: owner.mode, from: r.from, to: r.to, confidence: owner.conf, risk: owner.a.risk, rationale: owner.a.rationale, src: owner.src, rules: owner.a.rules, round };
        if (owner.kind === "ladder") {
            const sp = owner.a.steps[owner.step];
            Object.assign(item, { level: owner.level, step: owner.step + 1, why: sp.why, cost: sp.cost, expect: sp.expect, weak: !applySet.has(owner.conf) });
        }
        else if (owner.kind === "choice")
            Object.assign(item, { why: owner.a.start_why ?? "valor inicial do guia", candidate: owner.a.start });
        if (r.unchanged) {
            if (owner.fresh)
                out.unchanged_already.push(item);
            continue;
        }
        if (owner.kind !== "ladder" && !applySet.has(owner.conf)) {
            out.suggested.push(item);
            continue;
        }
        const store = owner.a.scope === "object" ? out.object_overrides : out.settings_after;
        store[w.key] = r.to;
        st.owners[`${tag(owner.a.scope)}\0${w.key}`] = { action: owner.a.id, step: owner.step };
        const pv = (owner.a.scope === "object" ? prev.o : prev.s)[w.key];
        if (!eqv(pv, r.to))
            out.changes.push({ ...item, from: pv === undefined ? null : pv });
    }
    // keys that moved without an applied winner (a relax back to an earlier value or to the base, a weak winner shadowing an applied one)
    for (const [pm, nm, tg] of [[prev.s, out.settings_after, "s"], [prev.o, out.object_overrides, "o"]]) {
        for (const key of new Set([...Object.keys(pm), ...Object.keys(nm)])) {
            if (eqv(pm[key], nm[key]) || out.changes.some(c => c.key === key && tag(c.scope) === tg))
                continue;
            const ow = st.owners[`${tg}\0${key}`];
            const a = byId.get(ow?.action);
            out.changes.push({
                action: ow?.action ?? "engine", key, scope: a?.scope ?? (tg === "o" ? "object" : "process"), kind: "revert", mode: "set",
                from: pm[key] === undefined ? null : pm[key], to: nm[key] === undefined ? null : nm[key],
                confidence: a?.confidence ?? null, risk: a?.risk ?? null, rationale: a?.rationale ?? null, src: a?.src ?? [], rules: a?.rules ?? [], round, reverted: true,
            });
        }
    }
    for (const ev of relaxEvents)
        for (const key of Object.keys(ev.step.set)) {
            const i = out.changes.findIndex(c => c.key === key && tag(c.scope) === tag(ev.a.scope));
            if (i >= 0) {
                out.changes[i] = {
                    action: ev.a.id, key, scope: ev.a.scope, kind: "ladder", mode: "set", from: out.changes[i].from, to: out.changes[i].to, confidence: ev.step.confidence, risk: ev.a.risk,
                    rationale: ev.a.rationale, src: ev.step.src, rules: ev.a.rules, round, level: ev.to, why: `Relax: gatilho falso por 2 rodadas seguidas; volta ao nivel ${ev.to}.`, cost: ev.step.cost, relax: true,
                };
            }
        }
    for (const c of contribs)
        if (c.kind !== "ladder" && c.fresh && applySet.has(c.conf))
            st.applied[c.a.id] = true;
    for (const c of contribs)
        if (c.kind === "choice") {
            const wanted = c.a.evaluated_by ?? [];
            const miss = wanted.filter(f => all[f] === undefined || all[f] === null);
            out.choices.push({ action: c.a.id, key: c.key, start: c.a.start, value: c.spec, verified: wanted.length > 0 && !miss.length, evaluated_by: wanted, missing: miss });
        }
    const blocking = out.unknown.some(u => u.missing.length);
    out.done = round > 0 && !out.ladders.some(l => l.trigger === true) && !blocking && !out.changes.length;
    out.stalled = round > 0 && !out.done && !out.changes.length && !out.advanced.length;
    out.missing_facts = [...new Set(out.unknown.flatMap(u => u.missing))];
    out.blind_facts = [...new Set(out.unknown.flatMap(u => u.blind))];
    st.round = round;
    st.settings = clone(out.settings_after);
    st.object_overrides = clone(out.object_overrides);
    st.history.push({ round, changes: out.changes.map(c => ({ action: c.action, key: c.key, from: c.from, to: c.to })), advanced: out.advanced.map(x => x.action), relaxed: out.relaxed.map(x => x.action), exhausted: out.exhausted.map(x => x.action), done: out.done });
    return out;
}
/** Round 0. actions: the shipped tuning actions; facts: flat {name: value}; base: the project's settings {key: string | string[]}. */
export function applyTuning(tuning, facts = {}, base = {}, options = {}) {
    const { changes, ...rest } = core(tuning, initialState(base), facts, options, 0, "pre-slice");
    return { applied: changes, ...rest };
}
/** One escalation round after a slice: state from applyTuning(...).state, a previous nextRound or initialState(base). */
export function nextRound(tuning, state, facts = {}, options = {}) {
    if (!state || typeof state !== "object" || !state.base || !state.levels)
        throw new TypeError("nextRound needs a state (applyTuning(...).state, a previous nextRound state or initialState(base))");
    return core(tuning, state, facts, options, Math.max(1, state.round + 1), "all");
}
/** Rounds 0..n over scripted facts (round 0 = applyTuning, then nextRound). Never stops early: done_at says when it first became true. */
export function simulate(tuning, baseSettings = {}, factsPerRound = [{}], options = {}) {
    const rounds = [];
    let state;
    let doneAt = null;
    (factsPerRound.length ? factsPerRound : [{}]).forEach((facts, i) => {
        const r = i === 0 ? applyTuning(tuning, facts, baseSettings, options) : nextRound(tuning, state, facts, options);
        state = r.state;
        const { state: _s, settings_after, ...rest } = r;
        const { applied, changes, ...tail } = rest;
        const delta = {};
        for (const k of new Set([...Object.keys(settings_after), ...Object.keys(baseSettings)]))
            if (!eqv(settings_after[k], baseSettings[k]))
                delta[k] = settings_after[k];
        rounds.push({ ...tail, changes: (applied ?? changes), settings_delta: delta });
        if (r.done && doneAt === null)
            doneAt = i;
    });
    const last = rounds[rounds.length - 1];
    return { rounds, final: { settings_after: state.settings, object_overrides: state.object_overrides, levels: state.levels, done: last.done, done_at: doneAt, exhausted: last.exhausted.map(e => e.action), unknown: last.unknown, history: state.history } };
}
