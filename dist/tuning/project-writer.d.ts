import type { SettingsReport } from "../slicer/project-settings.js";
import { type ObjectEdit } from "./project-text.js";
import type { Elements, SettingValue } from "./types.js";
export type ChangeScope = "process" | "filament" | "printer";
/** One tuned setting. A scalar `value` fills every element of a list-valued key, or only those `elements` selects; a list must keep its length. */
export interface SettingChange {
    key: string;
    value: SettingValue;
    scope: ChangeScope;
    elements?: Elements;
}
/** Per-object settings (the engine's object_overrides). `objects`: ids or exact names as in model_settings.config; default every object. */
export interface ObjectOverrides {
    settings: Record<string, string>;
    objects?: Array<string | number>;
}
/** The target printer's project as Studio builds it: the exported 3MF's bytes, and what the Phase-1 plan kept or could not keep. */
export interface RetargetOutcome {
    archive: Buffer;
    report: SettingsReport | null;
    /** The target process preset the plan chose, and the process keys the plan overlaid on it (these are the "modified" ones). */
    process?: string;
    edited?: string[];
}
export type Retargeter = (source: string) => Promise<RetargetOutcome>;
export interface WriteOptions {
    source: string;
    /** Wanted path; a numeric suffix is added when it exists (the source always exists, so it is never chosen). */
    output: string;
    target: {
        printerPreset: string;
    };
    changes?: SettingChange[];
    objectOverrides?: ObjectOverrides;
    /** Required for an STL, a 3MF without project settings, or a project made for another printer. See studioRetargeter. */
    retarget?: Retargeter;
}
export interface DiffEntry {
    key: string;
    from: SettingValue | null;
    to: SettingValue | null;
}
export interface ChangedKey {
    key: string;
    from: SettingValue | null;
    to: SettingValue;
    scope: ChangeScope;
}
interface PrinterIds {
    printer: string | null;
    process: string | null;
    filaments: string[];
}
export interface RetargetSummary {
    applied: boolean;
    reason: "same-printer" | "printer-differs" | "baseline";
    printer_ids: {
        before: PrinterIds | null;
        after: PrinterIds;
    };
    kept: string[];
    not_kept: string[];
    filament_map: SettingsReport["filament_map"];
    /** Original -> P0, values abbreviated. */
    changed_keys: DiffEntry[];
}
export interface WriteResult {
    path: string;
    sha256_of_source_before_and_after: {
        before: string;
        after: string;
    };
    /** Tuning only: P0 -> delivered. */
    changed_keys: ChangedKey[];
    /** Asked for, but already the project's value (still listed in different_settings_to_system, so a keep slice carries it). */
    unchanged_keys: string[];
    object_overrides: ObjectEdit[];
    retarget: RetargetSummary;
    /** Original -> delivered (retarget + tuning), values abbreviated. Empty diff base for an STL. */
    combined_diff: DiffEntry[];
    dropped_entries: string[];
    rewritten_entries: string[];
    warnings: string[];
}
export declare function writeTunedProject(o: WriteOptions): Promise<WriteResult>;
export {};
