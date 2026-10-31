import type { Condition, Facts, Rule } from "./types.js";
export declare const OPS: ReadonlySet<string>;
export declare function evalCondition(c: Condition, facts: Facts): boolean | undefined;
/** "Bambu Lab A1 mini" -> "a1-mini": the form rule.printers uses. */
export declare const modelId: (m: unknown) => string;
/** Verdict for a rule that has a machine condition: its printer scope AND its detect.when. */
export declare const ruleStatus: (rule: Pick<Rule, "printers" | "detect">, facts: Facts) => boolean | undefined;
