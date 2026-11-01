import { geometryFromConfig, gridColumns, type BedGeometry, type LayoutModel, type LayoutObject } from "./layout.js";
export interface PackPolicy {
    /** Edge-to-edge distance kept between two objects of a plate. */
    gapMm: number;
    /** Distance kept from the edge of the usable area. */
    marginMm: number;
}
/** Brim in the project settings (any brim_type but no_brim and a positive width) widens the default gap so neighbours' brims never touch. */
export declare function defaultPolicy(config: Record<string, unknown> | undefined, over?: Partial<PackPolicy>): PackPolicy & {
    brimMm: number;
};
/** The edge-to-edge distance below which the analysis calls two neighbours overlapping: brims touching, or 2 mm of bare clearance. */
export declare const minimumGap: (brimMm: number) => number;
export interface Placement {
    key: string;
    name: string;
    /** Lower-left corner of the final (rotated) bounding box, in the plate's local coordinates. */
    x: number;
    y: number;
    /** Final dimensions (after the rotation). */
    w: number;
    d: number;
    rotate: 0 | 90;
}
export interface PlannedPlate {
    classKey: string;
    slots: number[];
    items: Placement[];
    /** Estimated print volume (footprint x height) of the plate's objects: the proxy the balanced candidates are split by. */
    load: number;
}
export type Strategy = "authored" | "authored_rebased" | "min_plates" | "plus_1" | "plus_2";
export interface Candidate {
    id: string;
    strategy: Strategy;
    label: string;
    plates: PlannedPlate[];
    /** true: the project exactly as it is (nothing to write). */
    unchanged?: boolean;
    notes: string[];
}
export interface Blocker {
    objects: string[];
    reason: string;
    evidence: Record<string, unknown>;
}
export interface ClassSummary {
    class: string;
    slots: number[];
    objects: number;
    load: number;
    min_plates: number;
    lower_bound: number;
    usable_mm: [number, number];
    height_limit_mm: number;
    nozzles: number[];
}
export interface PlanResult {
    candidates: Candidate[];
    blockers: Blocker[];
    classes: ClassSummary[];
}
export interface PlanOptions {
    policy: PackPolicy;
    /** Whole-project candidates (fewest plates, +1, +2). Default 3. */
    maxCandidates?: number;
}
export declare function planLayouts(objects: LayoutObject[], geo: BedGeometry, options: PlanOptions): PlanResult;
/**
 * The project as the authors laid it out, moved onto the target's plate grid and nothing else: every plate keeps its objects and their positions
 * relative to the plate. A plate whose group no longer fits the target's usable area is centred in it; one that still does not fit (or whose
 * neighbours end up closer than `minGap`) makes the reference unavailable, with the reason.
 */
export declare function authoredRebased(model: LayoutModel, target: BedGeometry, policy: PackPolicy, minGap: number, source?: BedGeometry): Candidate | {
    unavailable: string;
};
export interface Measured {
    id: string;
    plates: number;
    /** Objects per plate, in plate order. */
    objects_per_plate: number[];
    /** Predicted seconds per plate; the candidate is only comparable when every plate has one. */
    time_s: Array<number | null>;
    /** A measuring stick, not a proposal (the project as authored, moved onto the new grid): it wins only when more than 3% faster in total than every proposal. */
    reference?: boolean;
}
export declare const TIE_BAND = 0.03;
export interface RankedCandidate {
    id: string;
    total_s: number;
    longest_s: number;
    max_objects: number;
    within_band: boolean;
    eligible: boolean;
}
export interface Choice {
    id: string;
    reason: string;
    ranking: RankedCandidate[];
}
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
export declare function chooseCandidate(list: Measured[], incumbent?: string): Choice | undefined;
export { geometryFromConfig, gridColumns };
