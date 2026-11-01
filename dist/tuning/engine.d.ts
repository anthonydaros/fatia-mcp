import type { Facts } from "../knowledge/types.js";
import type { ApplyResult, RoundResult, Settings, Simulation, TuningAction, TuningKind, TuningOptions, TuningState } from "./types.js";
export declare const CONF: readonly ["preset", "oficial", "bug conhecido", "teste de revisor", "relato", "hipotese", "nao verificado"];
export declare const APPLY_DEFAULT: readonly string[];
export declare const RISK: readonly ["low", "medium", "high"];
export declare const KINDS: readonly TuningKind[];
export declare const LADDER_COST: readonly ["tempo", "material", "qualidade", "resistencia", "nenhum"];
/** Two numeric strings compare numerically ("0.20" == "0.2"), two percents too ("15%" == "15.0%"), a number never equals a percent, the rest as strings. */
export declare const same: (a: unknown, b: unknown) => boolean;
/** A fresh state for nextRound/simulate. */
export declare function initialState(base?: Settings): TuningState;
/** Round 0. actions: the shipped tuning actions; facts: flat {name: value}; base: the project's settings {key: string | string[]}. */
export declare function applyTuning(tuning: TuningAction[], facts?: Facts, base?: Settings, options?: TuningOptions): ApplyResult;
/** One escalation round after a slice: state from applyTuning(...).state, a previous nextRound or initialState(base). */
export declare function nextRound(tuning: TuningAction[], state: TuningState, facts?: Facts, options?: TuningOptions): RoundResult;
/** Rounds 0..n over scripted facts (round 0 = applyTuning, then nextRound). Never stops early: done_at says when it first became true. */
export declare function simulate(tuning: TuningAction[], baseSettings?: Settings, factsPerRound?: Facts[], options?: TuningOptions): Simulation;
