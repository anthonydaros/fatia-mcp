import type { Facts } from "../knowledge/types.js";
import type { ScanEvidence, ScanValue } from "./gcode-scan.js";
import type { RoundResult, TuningAction } from "./types.js";
/**
 * The data's own vocabulary (tuning.json conditions and spec section 7). `mold_kind: "none"` is the one addition: the data only names the two molds, and
 * without a way to say "not a mold" the five mold actions would stay unknown instead of false.
 */
export declare const PART_ENUMS: {
    readonly kind: readonly ["keychain", "pix_plate", "face_down_plate", "other"];
    readonly load_class: readonly ["none", "functional", "high_load"];
    readonly mold_kind: readonly ["rigid", "silicone", "none"];
};
export declare const PART_BOOLEANS: readonly ["is_large_part", "is_tall_narrow", "is_tiny_part", "has_fit_pins_and_holes", "has_tight_fit_male_part", "is_cut_part", "is_cut_pin"];
export type PartContext = {
    [K in keyof typeof PART_ENUMS]?: (typeof PART_ENUMS)[K][number];
} & {
    [K in (typeof PART_BOOLEANS)[number]]?: boolean;
};
/** The fact names a declaration can set. */
export declare const DECLARED_FACTS: readonly string[];
/** Validates a declaration (a plain object of the keys above); throws an Error that names the key and the allowed values. Absent or null = no declaration. */
export declare function parsePartContext(input: unknown): PartContext;
export interface DeclaredFacts {
    facts: Facts;
    /** Every fact here came from a declaration, not from a measurement. */
    provenance: Record<string, "declared">;
    evidence: Record<string, ScanEvidence>;
}
/** object.* facts of a (validated) declaration. */
export declare function partContextFacts(context: PartContext): DeclaredFacts;
/** Every fact an action reads in `when`, in a ladder's trigger and step guards, and in a choice's evaluated_by. */
export declare function factsRead(action: TuningAction): Set<string>;
export interface DeclarationImpact {
    fact: string;
    declared: boolean;
    /** `also_needs`: other non-settings facts the action reads and nobody provided yet; declaring this fact alone may not be enough. */
    actions: Array<{
        id: string;
        title: string;
        also_needs: string[];
    }>;
}
/** For each declarable fact, the actions that read it. `provided` = fact names already known (declared or measured). */
export declare function declarationImpact(actions: readonly TuningAction[], provided?: Iterable<string>): DeclarationImpact[];
export interface UndeclaredSkips {
    /** Distinct actions that could not be evaluated because a declarable fact was missing. */
    count: number;
    actions: string[];
    by_fact: Record<string, string[]>;
    /** The sentence for the report. */
    text: string;
}
/** From an engine result: which skipped actions were skipped because the part was not described. */
export declare function skippedByUndeclared(round: Pick<RoundResult, "skipped_unknown" | "unknown">): UndeclaredSkips;
export interface SuggestedDeclaration {
    fact: string;
    /** The measurements behind the question, in the units of their fact names. */
    numbers: Record<string, number>;
    note: string;
}
/**
 * Questions for the user, with the numbers that bear on them. There is deliberately no value and no threshold: the guide gives none for "large",
 * "tall and narrow" or "tiny", so the answer is the user's. A fact the geometry says nothing about is not offered.
 */
export declare function suggestDeclarations(meshFacts: Record<string, ScanValue>): SuggestedDeclaration[];
