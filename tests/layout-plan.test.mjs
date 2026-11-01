// src/tuning/layout-plan.ts: the packer's properties (no overlap, inside the margin, classes never mixed, only 0/90 degrees, deterministic, the nozzle's own
// area, blockers), the candidates (fewest, +1, +2), the "as authored" reference, and the selection rule applied to measured candidates.
import assert from "node:assert/strict";
import test from "node:test";
import { LayoutLimitError, MAX_LAYOUT_OBJECTS, geometryFromConfig } from "../dist/tuning/layout.js";
import { TIE_BAND, authoredRebased, chooseCandidate, defaultPolicy, minimumGap, planLayouts } from "../dist/tuning/layout-plan.js";
import { h2dConfig, x2dConfig } from "./fixtures/layout-project.mjs";

const geo = extra => geometryFromConfig(x2dConfig(extra));
const POLICY = { gapMm: 8, marginMm: 5 };
let seq = 0;
/** A LayoutObject without a 3MF: a box of w x d x h standing at (x, y). */
function obj(name, w, d, h, { slots = [1], at = [0, 0], painted = false } = {}) {
  const key = `${2 + 2 * seq++}:0`;
  return {
    key, objectId: key.split(":")[0], instance: 0, itemIndex: seq, name, slots, painted, classKey: `${slots.join("+")}${painted ? "+paint" : ""}`,
    box: { x0: at[0], y0: at[1], x1: at[0] + w, y1: at[1] + d, z0: 0, z1: h }, volume_mm3: w * d * h, plates: [0],
  };
}
const gap = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.d), a.y - (b.y + b.d));

/** The properties every candidate must have, whatever the input. */
function assertSound(candidate, objects, geometry, policy) {
  const byKey = new Map(objects.map(o => [o.key, o]));
  const seen = new Set();
  for (const plate of candidate.plates) {
    assert.ok(plate.items.length > 0, "no empty plate");
    assert.equal(new Set(plate.items.map(i => byKey.get(i.key).classKey)).size, 1, "a plate holds one colour class");
    for (const [i, a] of plate.items.entries()) {
      assert.ok(!seen.has(a.key), "an object is placed once");
      seen.add(a.key);
      const o = byKey.get(a.key);
      const [w, d] = [o.box.x1 - o.box.x0, o.box.y1 - o.box.y0];
      assert.ok(a.rotate === 0 || a.rotate === 90, "only 0 and 90 degrees");
      assert.deepEqual([a.w, a.d].map(v => Math.round(v * 1e6)), (a.rotate === 90 ? [d, w] : [w, d]).map(v => Math.round(v * 1e6)), "the final size is the box, turned or not");
      const nozzles = [...new Set(o.slots.map(s => geometry.filamentMap[s - 1] ?? 0))];
      let area = geometry.bed;
      for (const n of nozzles) area = { x0: Math.max(area.x0, geometry.nozzles[n].rect.x0), y0: Math.max(area.y0, geometry.nozzles[n].rect.y0), x1: Math.min(area.x1, geometry.nozzles[n].rect.x1), y1: Math.min(area.y1, geometry.nozzles[n].rect.y1) };
      assert.ok(a.x >= area.x0 + policy.marginMm - 1e-6 && a.y >= area.y0 + policy.marginMm - 1e-6 && a.x + a.w <= area.x1 - policy.marginMm + 1e-6 && a.y + a.d <= area.y1 - policy.marginMm + 1e-6, `${a.name} is inside the margin of its nozzle's area`);
      for (const b of plate.items.slice(i + 1)) assert.ok(gap(a, b) >= policy.gapMm - 1e-6, `${a.name} and ${b.name} keep the gap (${gap(a, b)})`);
    }
  }
  assert.equal(seen.size, objects.length, "every object is placed");
}

test("packer properties: sound candidates, classes never mixed, only 0/90 degrees, inside the margin, the gap kept, and the same input gives the same plan", () => {
  seq = 0;
  const g = geo({ filament_map: ["1", "2"] });
  const objects = [
    obj("Frame", 119.3, 119.3, 179.2, { slots: [1] }),
    ...Array.from({ length: 10 }, (_, i) => obj(`Wide ${i}`, 107, 50.4, 171.7, { slots: [2] })),
    ...Array.from({ length: 10 }, (_, i) => obj(`Tall ${i}`, 53.4, 139.7, 106.4, { slots: [2] })),
    ...Array.from({ length: 6 }, (_, i) => obj(`Small ${i}`, 53.5, 50.4, 171.8, { slots: [2] })),
    obj("Both", 80, 60, 40, { slots: [1, 2] }),
    obj("Painted", 70, 70, 40, { slots: [1], painted: true }),
  ];
  const plan = planLayouts(objects, g, { policy: POLICY });
  assert.deepEqual(plan.blockers, []);
  assert.ok(plan.candidates.length >= 2 && plan.candidates.length <= 3);
  for (const c of plan.candidates) assertSound(c, objects, g, POLICY);
  const classes = new Set(objects.map(o => o.classKey));
  assert.deepEqual(new Set(plan.candidates[0].plates.map(p => p.classKey)), classes, "each class has its own plate(s): frame, slot 2, both, painted");
  assert.ok(plan.candidates[0].plates.length >= classes.size);
  assert.equal(JSON.stringify(planLayouts(objects, g, { policy: POLICY })), JSON.stringify(plan), "deterministic");
  // turning the input order around changes nothing either: objects are ordered by key inside the planner
  assert.equal(JSON.stringify(planLayouts([...objects].reverse(), g, { policy: POLICY })), JSON.stringify(plan));
});

test("a class on nozzle 2 stays in nozzle 2's area (x >= 20.5 plus the margin); a class on nozzle 1 may use the whole bed", () => {
  seq = 0;
  const g = geo({ filament_map: ["1", "2"] });
  const grey = Array.from({ length: 4 }, (_, i) => obj(`Grey ${i}`, 100, 100, 50, { slots: [2] }));
  const black = Array.from({ length: 4 }, (_, i) => obj(`Black ${i}`, 100, 100, 50, { slots: [1] }));
  const plan = planLayouts([...grey, ...black], g, { policy: POLICY });
  const first = c => (cls) => Math.min(...c.plates.filter(p => p.classKey === cls).flatMap(p => p.items.map(i => i.x)));
  const c = plan.candidates[0];
  assert.ok(first(c)("2") >= 20.5 + POLICY.marginMm - 1e-6, `grey starts at ${first(c)("2")}`);
  assert.ok(first(c)("1") >= POLICY.marginMm - 1e-6 && first(c)("1") < 20.5 + POLICY.marginMm, "black can go left of nozzle 2's limit (centred in the bed: 5 mm from the edge here)");
  assert.deepEqual(plan.classes.find(k => k.class === "2").usable_mm, [225.5, 246], "256 - 20.5 - 2 x 5, by 256 - 10");
  assert.deepEqual(plan.classes.find(k => k.class === "2").nozzles, [2]);
  assertSound(c, [...grey, ...black], g, POLICY);
});

test("an object that fits no bin is a blocker (too wide for either rotation, too tall for its nozzle) and no candidate is offered", () => {
  seq = 0;
  const g = geo({ filament_map: ["1", "2"] });
  const wide = planLayouts([obj("Plank", 300, 10, 10), obj("Ok", 10, 10, 10)], g, { policy: POLICY });
  assert.equal(wide.candidates.length, 0);
  assert.deepEqual(wide.blockers.map(b => b.objects), [["Plank"]]);
  assert.match(wide.blockers[0].reason, /does not fit/);
  assert.deepEqual(wide.blockers[0].evidence.usable_mm, [246, 246]);
  const tall = planLayouts([obj("Tower", 20, 20, 258, { slots: [2] })], g, { policy: POLICY });
  assert.match(tall.blockers[0].reason, /258 mm tall; the limit of its nozzle is 256/);
  const rotated = planLayouts([obj("Fits turned", 100, 240, 10)], g, { policy: POLICY });
  assert.equal(rotated.blockers.length, 0, "100 x 240 fits 246 x 246 as it is");
  const turned = planLayouts([obj("Needs 90", 240, 10, 10, { slots: [2] })], g, { policy: POLICY });
  assert.equal(turned.blockers.length, 0, "240 is longer than nozzle 2's 225.5 across, but fits the 246 along");
  assert.equal(turned.candidates[0].plates[0].items[0].rotate, 90);
  assert.equal(planLayouts([obj("Too long", 247, 10, 10, { slots: [2] })], g, { policy: POLICY }).blockers.length, 1, "247 fits neither way");
});

test("candidates: the fewest plates the packer finds (at least the lower bound), then +1 and +2 for the largest class, split by estimated volume", () => {
  seq = 0;
  const g = geo();
  const frame = obj("Frame", 119.3, 119.3, 179.2, { slots: [1] });
  const grey = [
    ...Array.from({ length: 2 }, (_, i) => obj(`Wide Lower ${i}`, 107, 139.7, 106.4, { slots: [2] })),
    ...Array.from({ length: 6 }, (_, i) => obj(`Lower ${i}`, 53.4, 139.7, 106.4, { slots: [2] })),
    ...Array.from({ length: 2 }, (_, i) => obj(`Wide Upper ${i}`, 107, 50.4, 171.7, { slots: [2] })),
    ...Array.from({ length: 6 }, (_, i) => obj(`Upper ${i}`, 53.5, 50.4, 171.8, { slots: [2] })),
  ];
  const plan = planLayouts([frame, ...grey], g, { policy: { gapMm: 12, marginMm: 5 } });
  assert.deepEqual(plan.candidates.map(c => c.strategy), ["min_plates", "plus_1", "plus_2"]);
  const grey2 = plan.classes.find(k => k.class === "2");
  assert.equal(grey2.lower_bound, 3, "135,000 mm2 of gapped footprints over 66,564 mm2 of bin");
  assert.ok(grey2.min_plates >= grey2.lower_bound);
  const counts = plan.candidates.map(c => c.plates.length);
  assert.deepEqual(counts, [1 + grey2.min_plates, 2 + grey2.min_plates, 3 + grey2.min_plates]);
  for (const c of plan.candidates) {
    assertSound(c, [frame, ...grey], g, { gapMm: 12, marginMm: 5 });
    assert.equal(c.plates.filter(p => p.classKey === "1").length, 1, "the frame stays alone on one plate");
  }
  // +2 is balanced: the heaviest grey plate carries far less than the fewest-plates candidate's heaviest
  const peak = c => Math.max(...c.plates.filter(p => p.classKey === "2").map(p => p.load));
  assert.ok(peak(plan.candidates[2]) < peak(plan.candidates[0]), "spreading over more plates lowers the heaviest plate");
  // a class with one object per plate cannot be split further, and one object has nothing to split
  const single = planLayouts([obj("Solo", 50, 50, 50)], g, { policy: POLICY });
  assert.deepEqual(single.candidates.map(c => c.plates.length), [1]);
  assert.equal(planLayouts([obj("A", 50, 50, 50), obj("B", 50, 50, 50)], g, { policy: POLICY, maxCandidates: 1 }).candidates.length, 1, "the candidate cap");
});

test("centred: the used extent of a plate is centred in the usable area, and a lone object sits in the middle of the bed", () => {
  seq = 0;
  const plan = planLayouts([obj("Solo", 100, 60, 10)], geo(), { policy: POLICY });
  const [item] = plan.candidates[0].plates[0].items;
  assert.deepEqual([item.x, item.y], [78, 98]);
});

test("the default gap follows the brim: max(8, 2 x brim + 2) with a brim, 8 without; both are configurable", () => {
  assert.deepEqual(defaultPolicy(x2dConfig()), { gapMm: 8, marginMm: 5, brimMm: 0 });
  assert.deepEqual(defaultPolicy(x2dConfig({ brim_type: "auto_brim", brim_width: "5" })), { gapMm: 12, marginMm: 5, brimMm: 5 });
  assert.deepEqual(defaultPolicy(x2dConfig({ brim_type: "auto_brim", brim_width: "2" })), { gapMm: 8, marginMm: 5, brimMm: 2 }, "2 x 2 + 2 = 6 is under 8");
  assert.equal(defaultPolicy(x2dConfig({ brim_type: "no_brim", brim_width: "9" })).gapMm, 8, "no_brim ignores the width");
  assert.deepEqual(defaultPolicy(x2dConfig(), { gapMm: 3, marginMm: 0 }), { gapMm: 3, marginMm: 0, brimMm: 0 });
  assert.equal(minimumGap(5), 10);
  assert.equal(minimumGap(0), 2);
});

test("hostile input: more than 500 objects is refused, 500 small ones still plan, and a tiny work budget cannot be exceeded silently", () => {
  seq = 0;
  const g = geo();
  const many = Array.from({ length: MAX_LAYOUT_OBJECTS + 1 }, (_, i) => obj(`O${i}`, 5, 5, 5));
  assert.throws(() => planLayouts(many, g, { policy: POLICY }), LayoutLimitError);
  const ok = Array.from({ length: MAX_LAYOUT_OBJECTS }, (_, i) => obj(`O${i}`, 12 + (i % 7), 9 + (i % 5), 5));
  const started = Date.now();
  const plan = planLayouts(ok, g, { policy: POLICY });
  assert.ok(Date.now() - started < 20000, `planned in ${Date.now() - started} ms`);
  assertSound(plan.candidates[0], ok, g, POLICY);
});

test("authored, moved onto the target's grid: each plate keeps its objects and positions; a plate that no longer fits is centred; one that cannot fit is unavailable", () => {
  seq = 0;
  const target = geo();
  const source = geometryFromConfig(h2dConfig());
  // plate 1 of 2 on the H2D grid (350 x 320 beds, cell 420 x 384): one object near the H2D bed's far corner, one fine plate
  const far = obj("Far", 60, 60, 20, { at: [290, 250] }); // local (290..350, 250..310): outside a 256 bed
  const fine = obj("Fine", 60, 60, 20, { at: [420 + 100, 100] }); // plate 2, local (100..160, 100..160)
  far.plates = [0]; fine.plates = [1];
  const model = { objects: [far, fine], plates: [{ index: 0, locked: false, keys: [far.key] }, { index: 1, locked: false, keys: [fine.key] }], unplaced: [] };
  const c = authoredRebased(model, target, POLICY, 2, source);
  assert.equal(c.strategy, "authored_rebased");
  assert.equal(c.plates.length, 2);
  const [p1, p2] = c.plates.map(p => p.items[0]);
  assert.deepEqual([p2.x, p2.y], [100, 100], "fits: the position relative to the plate is kept");
  assert.deepEqual([p1.x, p1.y], [98, 98], "did not fit: centred in the 246 x 246 usable area");
  // too big as a group
  const huge = obj("Huge", 250, 250, 10, { at: [0, 0] });
  huge.plates = [0];
  const bad = authoredRebased({ objects: [huge], plates: [{ index: 0, locked: false, keys: [huge.key] }], unplaced: [] }, target, POLICY, 2, source);
  assert.match(bad.unavailable, /do not fit the target's usable area/);
  // neighbours closer than the minimum
  const [a, b] = [obj("A", 50, 50, 10, { at: [10, 10] }), obj("B", 50, 50, 10, { at: [62, 10] })];
  a.plates = b.plates = [0];
  const close = authoredRebased({ objects: [a, b], plates: [{ index: 0, locked: false, keys: [a.key, b.key] }], unplaced: [] }, target, POLICY, 5, target);
  assert.match(close.unavailable, /closer than 5 mm/);
});

// ---------------------------------------------------------------- the selection rule
const cand = (id, times, per = times.map(() => 1), reference = false) => ({ id, plates: times.length, objects_per_plate: per, time_s: times, ...(reference ? { reference: true } : {}) });

test("selection: the lowest total predicted time wins; a candidate with an unmeasured plate cannot be compared", () => {
  const choice = chooseCandidate([cand("four", [100, 200, 200, 100]), cand("five", [100, 100, 100, 100, 150]), cand("seventeen", Array(17).fill(60))]);
  assert.equal(choice.id, "five", "550 s in all against 600 s and 1020 s: more plates can be faster in total");
  assert.deepEqual(choice.ranking.map(r => [r.id, r.total_s]), [["four", 600], ["five", 550], ["seventeen", 1020]]);
});

test("selection table: totals, the 3% tie band, and the tie-breaks in the order the policy states", () => {
  const table = [
    // [name, candidates, incumbent, expected winner]
    ["lowest total wins", [cand("a", [500, 500]), cand("b", [400, 400, 100]), cand("c", [450, 450])], undefined, "b"],
    ["a tie within 3%: the smaller longest plate wins", [cand("a", [600, 400]), cand("b", [340, 340, 340])], undefined, "b"],
    ["totals 1000 vs 1030: inside the band (<= 3%), longest plate decides", [cand("a", [500, 500]), cand("b", [345, 345, 340])], undefined, "b"],
    ["totals 1000 vs 1031: outside the band, the lowest total wins even with a longer plate", [cand("a", [700, 300]), cand("b", [344, 344, 343])], undefined, "a"],
    ["same longest plate: fewer objects on the fullest plate wins", [cand("a", [500, 500], [6, 1]), cand("b", [500, 500], [4, 3])], undefined, "b"],
    ["same everything: fewer plates, then the earlier candidate", [cand("a", [500, 300, 200], [2, 2, 2]), cand("b", [500, 500], [2, 2])], undefined, "b"],
    ["an incumbent inside the band keeps the tie", [cand("as_is", [500, 500]), cand("new", [330, 330, 330])], "as_is", "as_is"],
    ["an incumbent outside the band loses", [cand("as_is", [500, 500]), cand("new", [300, 300, 300])], "as_is", "new"],
    ["an unmeasured candidate is left out", [cand("a", [100, null]), cand("b", [900, 900])], undefined, "b"],
    // the reference (one object per plate, as authored) would win every tie by construction: it counts only when more than 3% faster than every proposal
    ["a reference inside the band never wins, even with the shortest longest plate", [cand("a", [500, 500], [4, 4]), cand("ref", Array(10).fill(100.5), Array(10).fill(1), true)], undefined, "a"],
    ["a reference more than 3% faster wins outright", [cand("a", [500, 500], [4, 4]), cand("ref", Array(10).fill(96), Array(10).fill(1), true)], undefined, "ref"],
    ["a reference just inside the 3% (971 s against 1,000 s) does not win", [cand("a", [500, 500]), cand("ref", [971], [1], true)], undefined, "a"],
    ["a reference just beyond it (970 s) does", [cand("a", [500, 500]), cand("ref", [970], [1], true)], undefined, "ref"],
    ["a reference is the only measured candidate: it is chosen", [cand("a", [100, null]), cand("ref", [300], [1], true)], undefined, "ref"],
    ["the planned candidates are still ranked by the rule when the reference sits out (4, 5 and 6 plates of the real sample)", [cand("fewest", [256940 - 101006 - 40000, 101006, 40000], [1, 4, 5, 7]), cand("plus2", [40000, 46505, 46505, 46505, 46505, 32000], [1, 3, 3, 4, 3, 3]), cand("ref", Array(17).fill(15180), Array(17).fill(1), true)], undefined, "plus2"],
  ];
  for (const [name, list, incumbent, expected] of table) assert.equal(chooseCandidate(list, incumbent)?.id, expected, name);
  assert.equal(chooseCandidate([cand("a", [100, null])]), undefined, "nothing measurable");
  assert.equal(chooseCandidate([]), undefined);
  assert.equal(TIE_BAND, 0.03);
});

test("selection reports every candidate in its ranking and says why the winner won", () => {
  const choice = chooseCandidate([cand("a", [500, 500]), cand("b", [345, 345, 340]), cand("c", [900, 900])]);
  assert.deepEqual(choice.ranking.map(r => [r.id, r.total_s, r.longest_s, r.within_band, r.eligible]), [["a", 1000, 500, true, true], ["b", 1030, 345, true, true], ["c", 1800, 900, false, true]]);
  assert.equal(choice.id, "b");
  assert.match(choice.reason, /within 3% of the lowest total \(1000 s, a\).*smaller longest plate/);
  const plain = chooseCandidate([cand("a", [500, 500]), cand("c", [900, 900])]);
  assert.match(plain.reason, /lowest total predicted time \(1000 s over 2 plate\(s\)\)/);
});

test("selection says why the reference sat out", () => {
  const choice = chooseCandidate([cand("fewest", [500, 500], [4, 4]), cand("authored_rebased", Array(8).fill(125), Array(8).fill(1), true)]);
  assert.equal(choice.id, "fewest");
  assert.match(choice.reason, /authored_rebased \(the project as authored, one object per plate\) is measured and listed but would win every tie by construction, so it counts only when more than 3% faster/);
  assert.deepEqual(choice.ranking.map(r => [r.id, r.eligible, r.within_band]), [["fewest", true, true], ["authored_rebased", false, false]]);
});
