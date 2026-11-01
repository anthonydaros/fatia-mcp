import { type Kb } from "../knowledge/loader.js";
import type { Fact } from "../knowledge/types.js";
import type { NoAction, TuningAction } from "./types.js";
export declare const TUNING_FILES: readonly ["tuning.json", "no_action.json", "tuning-facts.json"];
export interface Tuning {
    dir: string;
    /** Knowledge-base version from knowledge/manifest.json ("unknown" when unreadable). */
    version: string;
    /** "mismatch" = a file differs from knowledge/manifest.json: a warning, not an error. */
    integrity: "ok" | "mismatch";
    actions: TuningAction[];
    noAction: NoAction[];
    /** Facts declared by the actions (tuning-facts.json). */
    facts: Fact[];
    actionById: Map<string, TuningAction>;
}
/** knowledge/tuning/ next to knowledge/ (BAMBU_KB_DIR moves both). */
export declare const tuningDir: () => string;
export declare function loadTuningFrom(dir: string, kb: Kb): Tuning;
/** Late and cached; a failure is not cached, so fixing the folder works without restarting the server. */
export declare function getTuning(): Tuning;
