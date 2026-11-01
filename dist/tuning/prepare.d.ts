import { type Collected } from "./facts.js";
import type { GcodeScan, ScanValue } from "./gcode-scan.js";
import { type MeshFacts } from "./mesh-facts.js";
import { type PartContext } from "./part-context.js";
import { type Retargeter, type SettingChange, type WriteResult } from "./project-writer.js";
import type { SliceArtifacts } from "./slice-facts.js";
import type { ApplyResult, NoAction, RoundResult, Settings, StudioKeys, TuningAction, TuningItem } from "./types.js";
export type StopReason = "done" | "stalled" | "exhausted" | "cycle" | "budget_slices" | "budget_minutes" | "cancelled" | "error" | "dry_run";
export declare const STRONG_CONFIDENCES: string[];
export interface PrepareInput {
    path: string;
    /** 0-based. */
    plateIndex: number;
    /** A valid bambu_model, e.g. "x2d". */
    model: string;
    partContext?: unknown;
    /** CLI slices allowed in all, the baseline and an STL's retarget slice included. */
    maxSlices: number;
    maxMinutes: number;
    outputDir: string;
    outputName?: string;
    openInStudio: boolean;
    apply: "recommended" | "strong_only";
    dryRun: boolean;
    signal?: AbortSignal;
    /** `step` only grows, so a client can show it as progress. */
    onProgress?: (p: {
        step: number;
        slices: number;
        max: number;
        message: string;
    }) => void;
}
/** What one slice produced, already scanned. */
export interface SliceOutcome {
    gcode: GcodeScan;
    slice: Omit<SliceArtifacts, "plateIndex" | "gcode">;
    /** CONFIG_BLOCK of the G-code: proves which values the slicer really used. */
    block?: Record<string, string>;
    ms?: number;
}
export interface PrepareDeps {
    tuning: {
        actions: TuningAction[];
        noAction: NoAction[];
        version?: string;
        integrity?: string;
    };
    /** "Bambu Lab X2D 0.4 nozzle" */
    printerPreset: string;
    /** Scratch parent (the server's TEMP_DIR). */
    tempDir: string;
    /** Needed for an STL, a 3MF without settings, or a project made for another printer. */
    retarget?: Retargeter;
    slice(project: string, signal?: AbortSignal): Promise<SliceOutcome>;
    installedStudio(): Promise<string | null>;
    /** preflight_check on a file; read-only. */
    preflight(args: Record<string, unknown>): Promise<Record<string, unknown>>;
    openInStudio(file: string): Promise<unknown>;
    now?(): number;
    studioKeys?: StudioKeys;
}
/** The measurements of one slice. */
export interface Measure {
    /** Every gcode.*, plate.* and slicer.* fact of the slice. */
    facts: Record<string, ScanValue>;
    ms: number;
    /** Per changed key: did the slice's CONFIG_BLOCK show the tuned value? null = could not be compared. */
    reach: Record<string, boolean | null>;
    reused_from?: "baseline";
}
export interface BlockerHit {
    rule: string;
    title: string;
    confidence: string;
    evidence: Record<string, unknown>;
}
export interface BlockerUnknown {
    rule: string;
    title: string;
    missing: string[];
}
/** What the engine said after reading this candidate's measurements. */
export interface Judged {
    triggers_true: string[];
    triggers_false: string[];
    triggers_unknown: string[];
    exhausted: RoundResult["exhausted"];
    blind_facts: string[];
    missing_facts: string[];
    done: boolean;
    stalled: boolean;
    /** Changes the engine asked for next. */
    next_changes: number;
    blockers: BlockerHit[];
    blockers_unknown: BlockerUnknown[];
    /** Blocker rules the G-code decided and found false. */
    blockers_clear: string[];
}
export interface RoundRecord {
    round: number;
    hash: string;
    delta: Delta;
    /** The engine's changes that produced this candidate (against the previous round). */
    changes: TuningItem[];
    advanced: string[];
    relaxed: string[];
    write?: WriteResult;
    measure?: Measure;
    judged?: Judged;
    /** The engine result that read this candidate's measurements; the pre-slice plan in a dry run. */
    engine?: ApplyResult | RoundResult;
    collected?: Collected;
    error?: string;
}
export interface Delta {
    changes: SettingChange[];
    overrides: Record<string, string>;
}
export interface RunData {
    input: PrepareInput;
    tuning: PrepareDeps["tuning"];
    printerPreset: string;
    declared: PartContext;
    source: {
        path: string;
        sha256_before: string;
        sha256_after: string;
    };
    p0: WriteResult;
    base: Settings;
    baseline?: {
        measure: Measure;
        blockers: BlockerHit[];
    };
    baselineError?: string;
    rounds: RoundRecord[];
    /** Every item the engine wrote, in order, per "s\0key" (settings) or "o\0key" (per-object setting). */
    items: Map<string, TuningItem[]>;
    stop: {
        reason: StopReason;
        detail: string;
    };
    slices: {
        loop: number;
        retarget: number;
        max: number;
    };
    minutes: number;
    best?: RoundRecord;
    bestWhy?: string;
    /** What the engine asked for next and was not run (budget, cycle). */
    pending: TuningItem[];
    delivered?: {
        path: string;
        write: WriteResult;
        opened: Record<string, unknown> | null;
        open_error?: string;
    };
    preflight: {
        checked: string;
        blockers: Array<Record<string, unknown>>;
        unchecked?: unknown;
        error?: string;
    };
    mesh: MeshFacts;
    installed: string | null;
    warnings: string[];
}
export declare function prepareProject(input: PrepareInput, deps: PrepareDeps): Promise<Record<string, unknown>>;
