import JSZip from "jszip";
import { analyzeLayout, type BedGeometry, type LayoutModel } from "./layout.js";
/** The plate pictures: they render the old positions. plate_N, plate_no_light_N, top_N, pick_N and every *_small.png. */
export declare const STALE_IMAGE: RegExp;
/** Where the plan puts one object: its final bounding-box centre in WORLD coordinates and the turn about Z (about the box centre) it needs first. */
export interface WorldItem {
    key: string;
    cx: number;
    cy: number;
    rotate: 0 | 90;
}
export interface WorldPlate {
    name: string;
    items: WorldItem[];
}
export interface WorldPlan {
    plates: WorldPlate[];
}
/**
 * The 12 numbers "m00 m01 m02 m10 m11 m12 m20 m21 m22 tx ty tz" (row vectors, v' = v*M + t) after turning the object about the vertical axis through
 * (cx, cy) and putting its bounding-box centre at (nx, ny). A quarter turn is M' = M * Rz(90) with Rz(90) = [[0,1,0],[-1,0,0],[0,0,1]]; the new translation
 * is t' = (t - c) * Rz + c'. tz never changes, so the object stays on the bed. Untouched numbers keep their original text.
 */
export declare function moveTransform(tokens: string[], from: {
    cx: number;
    cy: number;
}, to: {
    cx: number;
    cy: number;
}, rotate: 0 | 90): string[];
/** Rewrites the transform of the build `<item>` tags listed in `edits` (by position among all `<item>` tags); everything else keeps its bytes. */
export declare function spliceItemTransforms(xml: string, edits: Map<number, {
    objectId: string;
    move(tokens: string[]): string[];
}>): string;
/**
 * Rebuilds the <plate> blocks of model_settings.config: the first block is the template (its keys, order and indentation); plater_id and plater_name are
 * new, locked becomes false, the four picture lines go, gcode_file (if the template has it) is blank, and each plate holds the model_instance blocks of
 * its objects, copied verbatim so identify_id survives. Instances without a mesh (not printable) stay on the first plate. Everything else is untouched.
 */
export declare function rebuildPlates(xml: string, plan: WorldPlan, unplaced?: string[]): string;
/** filament_sequence.json with one empty entry per plate of the new layout; undefined when the file is not a per-plate object (it stays as it is). */
export declare function filamentSequenceFor(json: string, plates: number): string | undefined;
export interface LayoutProof {
    ok: boolean;
    checks: Array<{
        check: string;
        ok: boolean;
        detail: string;
    }>;
    /** The analysis of the written file. */
    plates: ReturnType<typeof analyzeLayout>["plates"];
}
export interface MovedObject {
    key: string;
    name: string;
    plate: number;
    from: {
        x: number;
        y: number;
    };
    to: {
        x: number;
        y: number;
    };
    rotate_deg: 0 | 90;
}
export interface WriteLayoutResult {
    path: string;
    sha256_of_source_before_and_after: {
        before: string;
        after: string;
    };
    dropped_entries: string[];
    rewritten_entries: string[];
    moved: MovedObject[];
    proof: LayoutProof;
}
export interface WriteLayoutOptions {
    source: string;
    /** Must not exist. */
    output: string;
    plan: WorldPlan;
    geometry: BedGeometry;
    /** The overlap threshold the proof uses. */
    minGapMm: number;
}
export declare function writeLaidOutProject(o: WriteLayoutOptions): Promise<WriteLayoutResult>;
interface Before {
    model: LayoutModel;
    zip: JSZip;
    order: Array<{
        name: string;
        stored: boolean;
    }>;
    dropped: Set<string>;
    rewritten: Map<string, string>;
}
/** Opens the written file again and checks it against the plan and against its source. Does not throw for a failed check: the caller decides. */
export declare function proveLayout(a: {
    file: string;
    expectedPlan: WorldPlan;
    before: Before;
    geometry: BedGeometry;
    minGapMm: number;
}): Promise<LayoutProof>;
export {};
