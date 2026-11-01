import type { Condition, Confidence, Scalar } from "../knowledge/types.js";
export type TuningKind = "definite" | "choice" | "ladder";
export type Mode = "set" | "at_least" | "at_most";
export type ActionPhase = "pre-slice" | "post-slice";
/** Which actions a call looks at; "all" = both phases. */
export type Phase = ActionPhase | "all";
export type TuningScope = "process" | "filament" | "printer" | "object";
export type Risk = "low" | "medium" | "high";
export type LadderCost = "tempo" | "material" | "qualidade" | "resistencia" | "nenhum";
/** A project setting as Studio stores it: a string, or one string per filament/extruder. */
export type SettingValue = string | string[];
export type Settings = Record<string, SettingValue>;
/** A value to write: a string exactly as Studio stores it, or base*mul+add of another numeric setting. */
export type Spec = string | {
    ref: string;
    mul?: number;
    add?: number;
    round?: number;
};
/** List-valued key: only the elements whose label in the aligned base list `index_by` starts with `starts_with` are written. */
export interface Elements {
    index_by: string;
    starts_with: string;
}
interface ActionBase {
    id: string;
    title: string;
    rules: string[];
    topic: string;
    phase: ActionPhase;
    scope: TuningScope;
    when: Condition;
    when_text: string;
    confidence: Confidence;
    risk: Risk;
    priority: number;
    printers: string[];
    applies_to: Record<string, string> | null;
    rationale: string;
    src: string[];
    unverified_value?: boolean;
}
export interface DefiniteAction extends ActionBase {
    kind?: "definite";
    mode: Mode;
    set: Record<string, Spec>;
    elements?: Elements;
}
export interface ChoiceAction extends ActionBase {
    kind: "choice";
    key: string;
    candidates: Spec[];
    start: number;
    start_why?: string;
    range?: {
        min: string;
        max: string;
    };
    guide_default?: string;
    evaluated_by?: string[];
    evaluated_note?: string;
}
export interface LadderStep {
    set: Record<string, Spec>;
    why: string;
    cost: LadderCost;
    expect: string;
    confidence: Confidence;
    src: string[];
    only_if?: Condition;
}
export interface LadderAction extends ActionBase {
    kind: "ladder";
    trigger: Condition;
    trigger_text?: string;
    relax?: boolean;
    steps: LadderStep[];
    exhausted: string;
}
export type TuningAction = DefiniteAction | ChoiceAction | LadderAction;
export interface NoAction {
    rule: string;
    reason: string;
    note: string;
}
/** studio-keys.json shape the engine needs: how many elements an absent list-valued key has. */
export type StudioKeys = Record<string, {
    is_list?: boolean;
    project_array_len?: number | null;
}>;
export interface TuningOptions {
    /** Printer model; wins over the printer.model fact. "Bambu Lab X2D" and "x2d" are the same printer. */
    printer?: Scalar | Scalar[];
    /** Installed Bambu Studio; wins over the studio.version fact. */
    studioVersion?: string;
    /** Default: "pre-slice" for applyTuning, "all" for nextRound. */
    phase?: Phase;
    /** Facts that can never be collected (exact name, or "prefix." for a whole family): they come back as blind, never as missing. */
    unavailable?: string[];
    /** Confidences whose values are written; the others are only suggested. Default: preset to relato. */
    applyConfidences?: string[];
    studioKeys?: StudioKeys;
}
/** One value the engine wrote (or only suggested) for one key. */
export interface TuningItem {
    action: string;
    key: string;
    scope: TuningScope | "process";
    kind: TuningKind | "revert";
    mode: Mode;
    from: SettingValue | null;
    to: SettingValue | null;
    confidence: Confidence | null;
    risk: Risk | null;
    rationale: string | null;
    src: string[];
    rules: string[];
    round: number;
    level?: number;
    step?: number;
    why?: string;
    cost?: LadderCost;
    expect?: string;
    weak?: boolean;
    candidate?: number;
    relax?: boolean;
    reverted?: boolean;
}
export interface TuningConflict {
    scope: TuningScope;
    key: string;
    winner: string;
    loser: string;
    reason: "priority" | "confidence" | "risk" | "id-order";
    same_value: boolean;
    winner_value: Spec;
    loser_value: Spec;
    combined?: true;
}
export interface SkippedUnknown {
    action: string;
    key?: string;
    missing: string[];
    rules: string[];
    reason: string;
}
export interface Advanced {
    action: string;
    from: number;
    to: number;
    steps: number;
    why: string;
    skipped_noop?: number;
}
export interface Exhausted {
    action: string;
    level: number;
    steps: number;
    title: string;
    text: string;
    rules: string[];
}
export interface UnknownLadder {
    action: string;
    where: "when" | "trigger";
    missing: string[];
    blind: string[];
    rules: string[];
}
export interface LadderStatus {
    action: string;
    level: number;
    steps: number;
    relevant: boolean | null;
    trigger?: boolean | null;
}
export interface ChoiceStatus {
    action: string;
    key: string;
    start: number;
    value: Spec;
    verified: boolean;
    evaluated_by: string[];
    missing: string[];
}
export interface HistoryEntry {
    round: number;
    changes: Array<{
        action: string;
        key: string;
        from: SettingValue | null;
        to: SettingValue | null;
    }>;
    advanced: string[];
    relaxed: string[];
    exhausted: string[];
    done: boolean;
}
/** Everything a later round needs. Plain JSON; the engine never mutates the one it is given. */
export interface TuningState {
    base: Settings;
    settings: Settings;
    object_overrides: Settings;
    levels: Record<string, number>;
    quiet: Record<string, number>;
    skipped: Record<string, number[]>;
    applied: Record<string, true>;
    owners: Record<string, {
        action: string;
        step?: number;
    }>;
    history: HistoryEntry[];
    round: number;
}
export interface RoundResult {
    round: number;
    changes: TuningItem[];
    suggested: TuningItem[];
    unchanged_already: TuningItem[];
    skipped_unknown: SkippedUnknown[];
    conflicts: TuningConflict[];
    object_overrides: Settings;
    settings_after: Settings;
    advanced: Advanced[];
    relaxed: Array<{
        action: string;
        from: number;
        to: number;
    }>;
    exhausted: Exhausted[];
    unknown: UnknownLadder[];
    ladders: LadderStatus[];
    choices: ChoiceStatus[];
    done: boolean;
    stalled: boolean;
    missing_facts: string[];
    blind_facts: string[];
    state: TuningState;
}
/** Round 0: the same record with `changes` called `applied`. */
export type ApplyResult = Omit<RoundResult, "changes"> & {
    applied: TuningItem[];
};
export interface Simulation {
    rounds: Array<Omit<RoundResult, "state" | "settings_after"> & {
        settings_delta: Settings;
    }>;
    final: {
        settings_after: Settings;
        object_overrides: Settings;
        levels: Record<string, number>;
        done: boolean;
        done_at: number | null;
        exhausted: string[];
        unknown: UnknownLadder[];
        history: HistoryEntry[];
    };
}
export {};
