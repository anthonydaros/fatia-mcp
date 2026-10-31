import type { Fact, Rule, Topic } from "./types.js";
export declare const KB_FILES: readonly ["rules.json", "facts.json", "bambu.topics.json", "blender.topics.json", "synonyms.json"];
/** Facts a rule may name although no provider can supply them yet. Empty: every fact in the shipped KB is declared. */
export declare const UNSUPPORTED_FACTS: ReadonlySet<string>;
export interface Kb {
    dir: string;
    version: string;
    /** "mismatch" = a file differs from knowledge/manifest.json (or the manifest is unreadable): a warning, not an error. */
    integrity: "ok" | "mismatch";
    topics: Topic[];
    rules: Rule[];
    facts: Fact[];
    synonyms: string[][];
    topicById: Map<string, Topic>;
    ruleById: Map<string, Rule>;
    rulesByTopic: Map<string, Rule[]>;
}
/** BAMBU_KB_DIR (development override) or knowledge/ next to dist/. fileURLToPath, never URL.pathname (breaks on C:\). */
export declare const kbDir: () => string;
export declare function loadKbFrom(dir: string): Kb;
/** Late and cached; a failure is not cached, so fixing the folder works without restarting the server. */
export declare function getKb(): Kb;
/** Applying a rule's fix without asking is allowed only for a definite setting value backed by a strong source. */
export declare const approvalFor: (r: Rule) => "auto_apply" | "needs_user_approval";
