import { type BedGeometry, type LayoutIssue, type PlateStat } from "./layout.js";
import { type Blocker, type Candidate, type ClassSummary } from "./layout-plan.js";
import { type LayoutProof, type MovedObject, type WorldPlan } from "./layout-writer.js";
export type LayoutMode = "auto" | "check_only" | "off";
export declare const LAYOUT_DEFAULTS: {
    readonly maxSlices: 6;
    readonly maxMinutes: 12;
    readonly maxCandidates: 3;
    readonly maxReferencePlates: 20;
};
/** What the slicer predicted for one plate of a candidate. null: not available. */
export interface PlateMeasure {
    /** 1-based. */
    plate: number;
    time_s: number | null;
    weight_g: number | null;
    /** gcode.unprotected_travel_crossing_count of the plate's G-code. */
    crossing: number | null;
    /** The nozzle each filament was sliced on (slice_info filament_maps), 1-based. */
    filament_maps?: number[];
    warnings: string[];
}
export type SliceAll = (project: string, signal?: AbortSignal) => Promise<PlateMeasure[]>;
export type LayoutStatus = "off" | "skipped" | "unchanged" | "applied" | "check_only" | "dry_run" | "blocked" | "locked" | "failed";
export interface CandidateReport {
    id: string;
    strategy: string;
    label: string;
    plates: number;
    objects_per_plate: number[];
    classes_per_plate: string[];
    measured: boolean;
    /** Why it was not measured (budget, no slicer, a failed slice). */
    not_measured_reason?: string;
    time_per_plate_s?: Array<number | null>;
    total_time_s?: number;
    longest_plate_s?: number;
    weight_g?: number;
    crossing_per_plate?: Array<number | null>;
    nozzle_maps_as_sliced?: Array<number[] | null>;
    slicer_warnings?: number;
    chosen: boolean;
    notes: string[];
}
export interface ChosenPlate {
    plate: number;
    name: string;
    class: string;
    colour: string;
    objects: Array<{
        name: string;
        centre_world_mm: [number, number];
        position_on_plate_mm: [number, number];
        size_mm: [number, number];
        rotation_deg: 0 | 90;
    }>;
    utilisation: number;
    predicted_time_s: number | null;
    predicted_weight_g: number | null;
}
export interface LayoutRun {
    mode: LayoutMode;
    status: LayoutStatus;
    reason?: string;
    policy?: {
        gap_mm: number;
        margin_mm: number;
        minimum_gap_mm: number;
        brim_mm: number;
        rotations_deg: number[];
        one_colour_class_per_plate: boolean;
        selection: string;
    };
    target?: {
        bed_mm: [number, number];
        height_mm: number;
        nozzles: Array<{
            nozzle: number;
            x_mm: [number, number];
            y_mm: [number, number];
            height_mm: number;
        }>;
        filament_map: number[];
        filament_map_mode: string | null;
        cell_mm: [number, number];
        notes: string[];
    };
    issues: LayoutIssue[];
    /** Issues still standing in the delivered project (errors the stage could not or was not asked to fix). */
    unfixed: LayoutIssue[];
    plates_before: PlateStat[];
    blockers: Blocker[];
    classes: ClassSummary[];
    candidates: CandidateReport[];
    chosen?: {
        id: string;
        reason: string;
        plates: ChosenPlate[];
        ranking?: unknown;
    };
    budget: {
        slices_used: number;
        max_slices: number;
        minutes_used: number;
        max_minutes: number;
        stopped_early: string | null;
    };
    proof?: LayoutProof;
    moved?: MovedObject[];
    dropped_entries?: string[];
    /** 0-based plate of the laid-out project the tuning loop measures, and why. */
    measured_plate?: {
        index: number;
        number: number;
        why: string;
    };
    /** The candidates were not measured: the choice is the planner's default, not a measurement. */
    unmeasured: boolean;
    not_verified: string[];
    /** The laid-out project, when one was written. */
    file?: string;
    plates_after?: number;
    plates_before_count?: number;
}
export declare function colourName(hex: string | undefined): string;
/** The plan in world coordinates (what the writer takes), with the plate names. */
export declare function worldPlan(candidate: Candidate, geo: BedGeometry, colours: string[]): WorldPlan;
export interface StageInput {
    /** P0: the project for the target printer, unsliced. */
    p0: string;
    /** The user's original settings (project_settings.config), to tell whether the bed changed. */
    sourceConfig?: Record<string, unknown>;
    mode: LayoutMode;
    dryRun: boolean;
    gapMm?: number;
    marginMm?: number;
    maxSlices?: number;
    maxMinutes?: number;
    maxCandidates?: number;
    /** Scratch folder for the candidate projects. */
    work: string;
    sliceAll?: SliceAll;
    now?: () => number;
    signal?: AbortSignal;
    progress?: (message: string) => void;
}
/** The run record of a stage that did not complete (an unexpected error): the project stays as it is and the report says why. */
export declare function failedLayout(mode: LayoutMode, reason: string): LayoutRun;
export declare function runLayoutStage(i: StageInput): Promise<LayoutRun>;
