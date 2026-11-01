import type { Facts, ProjectFiles } from "../knowledge/types.js";
import type { GcodeScan, ScanEvidence, ScanValue } from "./gcode-scan.js";
import type { MeshFacts } from "./mesh-facts.js";
import { type PartContext } from "./part-context.js";
import { type SliceArtifacts } from "./slice-facts.js";
import type { Settings, TuningAction } from "./types.js";
export type Provenance = "project" | "mesh" | "slice" | "gcode" | "declared" | "extra" | "unavailable";
export interface FactEvidence extends ScanEvidence {
    provenance: Provenance;
    /** A prediction from geometry or a guide rule, not a measurement of the part or of a slice. */
    predictive?: boolean;
}
/** Facts from an analyzer the caller ran itself (e.g. the 3MF structure facts): the collector merges them and stops calling them unavailable. */
export interface ExtraFacts {
    facts: Record<string, ScanValue>;
    evidence?: Record<string, ScanEvidence>;
    blind?: string[];
}
export interface CollectInput {
    /** The opened base project (openProject); absent for an STL. */
    project?: ProjectFiles;
    /** 0-based. */
    plateIndex?: number;
    /** The bambu_model, e.g. "x2d". */
    targetModel: string;
    /** The engine's base settings (after the retarget); the project's own are used when absent. printer.*, filament.* and project.filament_types read it. */
    settingsBase?: Settings;
    /** This round's G-code scan; absent before the first slice. */
    gcode?: GcodeScan;
    /** This round's slice artifacts (the plate index is the call's). */
    slice?: Omit<SliceArtifacts, "plateIndex" | "gcode">;
    /** The mesh analysis of the base project (computed once). */
    mesh?: MeshFacts;
    /** Declared part facts (validated again here). */
    declared?: PartContext;
    extra?: ExtraFacts;
    /** The facts to collect; default: every fact the shipped tuning actions read. */
    wanted?: Iterable<string>;
    /** Used for the default `wanted`; default: the shipped tuning actions. */
    actions?: readonly TuningAction[];
    installedStudio?: () => Promise<string | null>;
    /** Label of the project for the evidence map. */
    source?: string;
}
export interface Collected {
    facts: Facts;
    /** Exact names the engine can never get on this input; pass as TuningOptions.unavailable. */
    unavailable: string[];
    evidence: Record<string, FactEvidence>;
}
export declare function collectFacts(input: CollectInput): Promise<Collected>;
