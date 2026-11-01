// Layout planner. Pure and deterministic: objects and the target printer's geometry in, whole-project candidate layouts out. Policy (the user's):
//   - one colour class per plate, never mixed (a class is the set of filament slots an object uses; a painted object is a class of its own);
//   - rotations only 0 and 90 degrees about Z, so the authors' tilt is kept;
//   - a class prints in the area its nozzle(s) can reach and under the lowest height limit of those nozzles;
//   - several candidates (fewest plates the packer finds, then +1 and +2 plates for the largest class, balanced by estimated print volume) are handed
//     to layout-stage.ts, which MEASURES them with the slicer; this module also holds the selection rule applied to those measurements.
// Packing is MaxRects (best short side fit) over several item orders. Everything is capped: objects, and a work counter against hostile input.
import { MAX_LAYOUT_OBJECTS, LayoutLimitError, binFor, gapBetween, geometryFromConfig, gridColumns, intersection, plateOrigin, } from "./layout.js";
/** Brim in the project settings (any brim_type but no_brim and a positive width) widens the default gap so neighbours' brims never touch. */
export function defaultPolicy(config, over = {}) {
    const width = Number(config?.brim_width);
    const type = typeof config?.brim_type === "string" ? config.brim_type : "";
    const brimMm = Number.isFinite(width) && width > 0 && type !== "no_brim" ? width : 0;
    return { gapMm: over.gapMm ?? Math.max(8, brimMm > 0 ? 2 * brimMm + 2 : 0), marginMm: over.marginMm ?? 5, brimMm };
}
/** The edge-to-edge distance below which the analysis calls two neighbours overlapping: brims touching, or 2 mm of bare clearance. */
export const minimumGap = (brimMm) => (brimMm > 0 ? 2 * brimMm : 2);
const r1 = (n) => Math.round(n * 10) / 10;
const itemOf = (o) => {
    const [w, d] = [o.box.x1 - o.box.x0, o.box.y1 - o.box.y0];
    return { key: o.key, name: o.name, w, d, h: o.box.z1, volume: w * d * Math.max(o.box.z1, 0) };
};
/** Free-rectangle bin (MaxRects). Dimensions are those of the usable area plus one gap, and items are inflated by one gap, so that two neighbours end up a gap apart. */
class MaxRects {
    constructor(w, h, budget) {
        this.w = w;
        this.h = h;
        this.budget = budget;
        this.free = [{ x0: 0, y0: 0, x1: w, y1: h }];
    }
    spend(n) {
        this.budget.left -= n;
        if (this.budget.left < 0)
            throw new LayoutLimitError("the layout planner exceeded its work budget; the project is too large to pack");
    }
    /** Best short side fit over both orientations; nothing is placed. */
    find(w, h) {
        this.spend(this.free.length);
        let best;
        for (const f of this.free) {
            for (const [iw, ih, rotate] of [[w, h, 0], [h, w, 90]]) {
                if (rotate === 90 && Math.abs(w - h) < 1e-9)
                    continue;
                if (iw > f.x1 - f.x0 + 1e-9 || ih > f.y1 - f.y0 + 1e-9)
                    continue;
                const [a, b] = [f.x1 - f.x0 - iw, f.y1 - f.y0 - ih];
                const score = [Math.min(a, b), Math.max(a, b)];
                if (!best || score[0] < best.score[0] - 1e-9 || (Math.abs(score[0] - best.score[0]) <= 1e-9 && score[1] < best.score[1] - 1e-9))
                    best = { x: f.x0, y: f.y0, w: iw, h: ih, rotate, score };
            }
        }
        return best;
    }
    place(x, y, w, h) {
        this.spend(this.free.length * 2 + 8);
        const next = [];
        const [x1, y1] = [x + w, y + h];
        for (const f of this.free) {
            if (x >= f.x1 - 1e-9 || x1 <= f.x0 + 1e-9 || y >= f.y1 - 1e-9 || y1 <= f.y0 + 1e-9) {
                next.push(f);
                continue;
            }
            if (x > f.x0 + 1e-9)
                next.push({ x0: f.x0, y0: f.y0, x1: x, y1: f.y1 });
            if (x1 < f.x1 - 1e-9)
                next.push({ x0: x1, y0: f.y0, x1: f.x1, y1: f.y1 });
            if (y > f.y0 + 1e-9)
                next.push({ x0: f.x0, y0: f.y0, x1: f.x1, y1: y });
            if (y1 < f.y1 - 1e-9)
                next.push({ x0: f.x0, y0: y1, x1: f.x1, y1: f.y1 });
        }
        this.spend(next.length * next.length / 2 + 1);
        this.free = next.filter((a, i) => !next.some((b, j) => i !== j && b.x0 <= a.x0 + 1e-9 && b.y0 <= a.y0 + 1e-9 && b.x1 >= a.x1 - 1e-9 && b.y1 >= a.y1 - 1e-9 && (i > j || b.x0 < a.x0 - 1e-9 || b.y0 < a.y0 - 1e-9 || b.x1 > a.x1 + 1e-9 || b.y1 > a.y1 + 1e-9)));
    }
}
const ORDERS = [
    ["area", (a, b) => b.w * b.d - a.w * a.d],
    ["longest side", (a, b) => Math.max(b.w, b.d) - Math.max(a.w, a.d)],
    ["height", (a, b) => b.h - a.h || b.w * b.d - a.w * a.d],
    ["shortest side", (a, b) => Math.min(b.w, b.d) - Math.min(a.w, a.d)],
];
const stable = (cmp) => (a, b) => cmp(a, b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const fresh = (c) => ({ bin: new MaxRects(c.usableW + c.gap, c.usableD + c.gap, c.budget), items: [], load: 0 });
function put(slot, item, c, at) {
    slot.bin.place(at.x, at.y, at.w, at.h);
    slot.items.push({ key: item.key, name: item.name, x: at.x, y: at.y, w: at.w - c.gap, d: at.h - c.gap, rotate: at.rotate, h: item.h, volume: item.volume });
    slot.load += item.volume;
}
/** Fewest bins the packer finds: every order, first fit by best short side fit across the open bins. Ties keep the more even split. */
function packFewest(items, c) {
    let best;
    for (const [, cmp] of ORDERS) {
        const slots = [];
        for (const item of [...items].sort(stable(cmp))) {
            let pick;
            for (const slot of slots) {
                const at = slot.bin.find(item.w + c.gap, item.d + c.gap);
                if (at && (!pick || at.score[0] < pick.at.score[0] - 1e-9 || (Math.abs(at.score[0] - pick.at.score[0]) <= 1e-9 && at.score[1] < pick.at.score[1] - 1e-9)))
                    pick = { slot, at };
            }
            if (!pick) {
                const slot = fresh(c);
                const at = slot.bin.find(item.w + c.gap, item.d + c.gap); // fits an empty bin: checked before
                slots.push(slot);
                pick = { slot, at };
            }
            put(pick.slot, item, c, pick.at);
        }
        const peak = (s) => Math.max(...s.map(x => x.load));
        if (!best || slots.length < best.length || (slots.length === best.length && peak(slots) < peak(best) - 1e-9))
            best = slots;
    }
    return best;
}
/** Exactly `k` bins, split by estimated print volume (longest first into the lightest bin that still has room); undefined when no order makes it fit. */
function packBalanced(items, k, c) {
    let best;
    const orders = [(a, b) => b.volume - a.volume, (a, b) => b.w * b.d - a.w * a.d];
    for (const cmp of orders) {
        const slots = Array.from({ length: k }, () => fresh(c));
        let ok = true;
        for (const item of [...items].sort(stable(cmp))) {
            const lightest = slots.map((s, i) => ({ s, i })).sort((a, b) => a.s.load - b.s.load || a.i - b.i);
            let placed = false;
            for (const { s } of lightest) {
                const at = s.bin.find(item.w + c.gap, item.d + c.gap);
                if (at) {
                    put(s, item, c, at);
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                ok = false;
                break;
            }
        }
        if (!ok || slots.some(s => s.items.length === 0))
            continue;
        const peak = (s) => Math.max(...s.map(x => x.load));
        if (!best || peak(slots) < peak(best) - 1e-9)
            best = slots;
    }
    return best;
}
/** The packed bin in the plate's local coordinates, its used extent centred on the usable area (gaps kept). */
function toPlate(slot, classKey, slots, bin, margin, c) {
    const x0 = Math.min(...slot.items.map(i => i.x)), y0 = Math.min(...slot.items.map(i => i.y));
    const x1 = Math.max(...slot.items.map(i => i.x + i.w)), y1 = Math.max(...slot.items.map(i => i.y + i.d));
    const [dx, dy] = [(c.usableW - (x1 - x0)) / 2 - x0, (c.usableD - (y1 - y0)) / 2 - y0];
    return {
        classKey, slots, load: slot.load,
        items: slot.items.map(i => ({ key: i.key, name: i.name, x: bin.rect.x0 + margin + i.x + dx, y: bin.rect.y0 + margin + i.y + dy, w: i.w, d: i.d, rotate: i.rotate })),
    };
}
export function planLayouts(objects, geo, options) {
    const { gapMm: gap, marginMm: margin } = options.policy;
    if (objects.length > MAX_LAYOUT_OBJECTS)
        throw new LayoutLimitError(`the layout planner accepts at most ${MAX_LAYOUT_OBJECTS} objects (${objects.length} given)`);
    const budget = { left: 40000000 };
    const byClass = new Map();
    for (const o of [...objects].sort((a, b) => (a.key < b.key ? -1 : 1)))
        (byClass.get(o.classKey) ?? byClass.set(o.classKey, []).get(o.classKey)).push(o);
    const classes = [...byClass.entries()].sort(([a, x], [b, y]) => x[0].slots[0] - y[0].slots[0] || (a < b ? -1 : 1));
    const blockers = [];
    const ctxOf = new Map();
    for (const [classKey, list] of classes) {
        const slots = [...new Set(list.flatMap(o => o.slots))].sort((a, b) => a - b);
        const bin = binFor(slots, geo);
        const usable = { w: bin.rect.x1 - bin.rect.x0 - 2 * margin, d: bin.rect.y1 - bin.rect.y0 - 2 * margin };
        const items = list.map(itemOf);
        for (const item of items) {
            const fits = usable.w > 0 && usable.d > 0 && ((item.w <= usable.w + 1e-9 && item.d <= usable.d + 1e-9) || (item.d <= usable.w + 1e-9 && item.w <= usable.d + 1e-9));
            const evidence = { size_mm: [r1(item.w), r1(item.d), r1(item.h)], usable_mm: [r1(usable.w), r1(usable.d)], height_limit_mm: bin.height, nozzles: bin.nozzles.map(n => n + 1), margin_mm: margin };
            if (!fits)
                blockers.push({ objects: [item.name], reason: `${item.name} (${r1(item.w)} x ${r1(item.d)} mm) does not fit the usable area of its nozzle${bin.nozzles.length > 1 ? "s" : ""} (${r1(usable.w)} x ${r1(usable.d)} mm) in either 0 or 90 degrees`, evidence });
            else if (item.h > bin.height + 1e-9)
                blockers.push({ objects: [item.name], reason: `${item.name} is ${r1(item.h)} mm tall; the limit of its nozzle${bin.nozzles.length > 1 ? "s" : ""} is ${bin.height} mm`, evidence });
        }
        ctxOf.set(classKey, { ctx: { gap, usableW: Math.max(usable.w, 0), usableD: Math.max(usable.d, 0), budget }, bin, items, slots });
    }
    if (blockers.length)
        return { candidates: [], blockers, classes: [] };
    const fewest = new Map();
    const summaries = [];
    for (const [classKey] of classes) {
        const c = ctxOf.get(classKey);
        const slots = packFewest(c.items, c.ctx);
        fewest.set(classKey, slots);
        const cell = (c.ctx.usableW + gap) * (c.ctx.usableD + gap);
        summaries.push({
            class: classKey, slots: c.slots, objects: c.items.length, load: Math.round(c.items.reduce((s, i) => s + i.volume, 0)),
            min_plates: slots.length, lower_bound: Math.max(1, Math.ceil(c.items.reduce((s, i) => s + (i.w + gap) * (i.d + gap), 0) / cell - 1e-9)),
            usable_mm: [r1(c.ctx.usableW), r1(c.ctx.usableD)], height_limit_mm: c.bin.height, nozzles: c.bin.nozzles.map(n => n + 1),
        });
    }
    const plateOf = (classKey, slot) => { const c = ctxOf.get(classKey); return toPlate(slot, classKey, c.slots, c.bin, margin, c.ctx); };
    const build = (id, strategy, label, overrides, notes) => ({
        id, strategy, label, notes,
        plates: classes.flatMap(([classKey]) => (overrides.get(classKey) ?? fewest.get(classKey)).map(s => plateOf(classKey, s))),
    });
    const candidates = [];
    const total = (m) => classes.reduce((s, [k]) => s + (m.get(k) ?? fewest.get(k)).length, 0);
    candidates.push(build("fewest", "min_plates", `${total(new Map())} plate(s): the fewest the packer found`, new Map(), []));
    const largest = [...summaries].sort((a, b) => b.load - a.load || (a.class < b.class ? -1 : 1))[0];
    const cap = options.maxCandidates ?? 3;
    for (const extra of [1, 2]) {
        if (candidates.length >= cap || !largest)
            break;
        const c = ctxOf.get(largest.class);
        const k = largest.min_plates + extra;
        if (k > c.items.length)
            break;
        const balanced = packBalanced(c.items, k, c.ctx);
        if (!balanced)
            continue;
        const m = new Map([[largest.class, balanced]]);
        candidates.push(build(`plus${extra}`, extra === 1 ? "plus_1" : "plus_2", `${total(m)} plate(s): class ${largest.class} spread over ${k} (+${extra}), balanced by estimated volume`, m, [`class ${largest.class} split over ${k} plates by estimated print volume (footprint x height)`]));
    }
    return { candidates, blockers: [], classes: summaries };
}
/**
 * The project as the authors laid it out, moved onto the target's plate grid and nothing else: every plate keeps its objects and their positions
 * relative to the plate. A plate whose group no longer fits the target's usable area is centred in it; one that still does not fit (or whose
 * neighbours end up closer than `minGap`) makes the reference unavailable, with the reason.
 */
export function authoredRebased(model, target, policy, minGap, source) {
    const sourceGeo = source ?? target;
    const count = model.plates.length;
    const byKey = new Map(model.objects.map(o => [o.key, o]));
    const plates = [];
    for (const plate of model.plates) {
        const here = plate.keys.map(k => byKey.get(k)).filter((o) => !!o);
        if (!here.length)
            continue;
        const o = plateOrigin(plate.index, count, sourceGeo);
        const local = here.map(x => ({ o: x, x0: x.box.x0 - o.x, y0: x.box.y0 - o.y, x1: x.box.x1 - o.x, y1: x.box.y1 - o.y }));
        let area = target.bed;
        for (const x of here)
            area = intersection(area, binFor(x.slots, target).rect);
        area = { x0: area.x0 + policy.marginMm, y0: area.y0 + policy.marginMm, x1: area.x1 - policy.marginMm, y1: area.y1 - policy.marginMm };
        const [ux0, uy0, ux1, uy1] = [Math.min(...local.map(l => l.x0)), Math.min(...local.map(l => l.y0)), Math.max(...local.map(l => l.x1)), Math.max(...local.map(l => l.y1))];
        const [uw, ud] = [ux1 - ux0, uy1 - uy0];
        if (uw > area.x1 - area.x0 + 1e-9 || ud > area.y1 - area.y0 + 1e-9)
            return { unavailable: `plate ${plate.index + 1}'s objects (${r1(uw)} x ${r1(ud)} mm together) do not fit the target's usable area (${r1(area.x1 - area.x0)} x ${r1(area.y1 - area.y0)} mm)` };
        const fits = ux0 >= area.x0 - 1e-9 && uy0 >= area.y0 - 1e-9 && ux1 <= area.x1 + 1e-9 && uy1 <= area.y1 + 1e-9;
        const [dx, dy] = fits ? [0, 0] : [(area.x0 + area.x1) / 2 - (ux0 + ux1) / 2, (area.y0 + area.y1) / 2 - (uy0 + uy1) / 2];
        for (let i = 0; i < local.length; i++)
            for (let j = i + 1; j < local.length; j++) {
                if (gapBetween(local[i], local[j]) < minGap - 1e-3)
                    return { unavailable: `on plate ${plate.index + 1} ${local[i].o.name} and ${local[j].o.name} are closer than ${minGap} mm` };
            }
        plates.push({
            classKey: [...new Set(here.map(x => x.classKey))].join(","), slots: [...new Set(here.flatMap(x => x.slots))].sort((a, b) => a - b),
            load: here.reduce((s, x) => s + itemOf(x).volume, 0),
            items: local.map(l => ({ key: l.o.key, name: l.o.name, x: l.x0 + dx, y: l.y0 + dy, w: l.x1 - l.x0, d: l.y1 - l.y0, rotate: 0 })),
        });
    }
    return { id: "authored_rebased", strategy: "authored_rebased", label: `${plates.length} plate(s): as authored, moved onto the target's grid`, plates, notes: ["every plate keeps its objects and their positions relative to the plate; no rotation"] };
}
export const TIE_BAND = 0.03;
/**
 * Lowest TOTAL predicted time (the sum over plates is what one printer needs). Candidates within 3% of the lowest total are tied: the smaller
 * longest-plate time wins, then fewer objects on the fullest plate, then fewer plates, then the candidate's order in the list.
 * A candidate with an unmeasured plate cannot be compared and is left out; undefined when none remains.
 *
 * The reference (the authors' one-object-per-plate layout moved onto the new grid) is measured and listed, but it would win every tie by construction
 * (its longest plate is the longest single object, its fullest plate has one object), and what it costs is not in the slicer's estimate: starting and
 * clearing every plate, and a first layer that must stick on each. So it is eligible only when its total is more than 3% below every proposal's.
 * `incumbent` is a project that has no layout problem: it keeps a tie.
 */
export function chooseCandidate(list, incumbent) {
    const ok = list.map((m, order) => ({ m, order })).filter(({ m }) => m.time_s.length > 0 && m.time_s.every(t => typeof t === "number" && Number.isFinite(t)));
    if (!ok.length)
        return undefined;
    const rows = ok.map(({ m, order }) => {
        const t = m.time_s;
        return { id: m.id, total_s: t.reduce((a, b) => a + b, 0), longest_s: Math.max(...t), max_objects: Math.max(...m.objects_per_plate, 0), plates: m.plates, order, reference: !!m.reference };
    });
    const proposals = rows.filter(r => !r.reference);
    const lowestProposal = proposals.length ? Math.min(...proposals.map(r => r.total_s)) : Infinity;
    const eligible = rows.filter(r => !r.reference || r.total_s * (1 + TIE_BAND) < lowestProposal || !proposals.length);
    const lowest = Math.min(...eligible.map(r => r.total_s));
    const ranked = rows.map(r => ({ ...r, eligible: eligible.includes(r), within_band: eligible.includes(r) && r.total_s <= lowest * (1 + TIE_BAND) + 1e-9 }));
    const tied = ranked.filter(r => r.within_band).sort((a, b) => a.longest_s - b.longest_s || a.max_objects - b.max_objects || a.plates - b.plates || a.order - b.order);
    let winner = tied[0];
    if (incumbent !== undefined) {
        const inc = ranked.find(r => r.id === incumbent);
        if (inc && inc.within_band && winner.id !== inc.id)
            winner = inc;
    }
    const lowestRow = ranked.find(r => r.eligible && r.total_s === lowest);
    const excluded = ranked.filter(r => !r.eligible);
    const why = winner.id === lowestRow.id && tied.length === 1
        ? `${winner.id}: lowest total predicted time (${Math.round(winner.total_s)} s over ${winner.plates} plate(s)); no other candidate within ${TIE_BAND * 100}% of it`
        : `${winner.id}: within ${TIE_BAND * 100}% of the lowest total (${Math.round(lowest)} s, ${lowestRow.id})${winner.id === incumbent ? "; the project as it stands keeps ties" : `, so the smaller longest plate decides (${Math.round(winner.longest_s)} s)`}; ${winner.plates} plate(s)`;
    const note = excluded.length ? `. ${excluded.map(r => r.id).join(", ")} (the project as authored, one object per plate) is measured and listed but would win every tie by construction, so it counts only when more than ${TIE_BAND * 100}% faster in total than every proposal (${Math.round(excluded[0].total_s)} s against ${Math.round(lowestProposal)} s)` : "";
    return { id: winner.id, reason: why + note, ranking: ranked.map(({ id, total_s, longest_s, max_objects, within_band, eligible: e }) => ({ id, total_s: Math.round(total_s), longest_s: Math.round(longest_s), max_objects, within_band, eligible: e })) };
}
export { geometryFromConfig, gridColumns };
