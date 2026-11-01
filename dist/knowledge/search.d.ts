import type { Rule, Topic } from "./types.js";
/** Below this the best hit shares only some of the user's words: consult_knowledge flags it so the agent says the base barely touches the subject. */
export declare const LOW_RELEVANCE = 0.45;
/**
 * Below this share of the best score a query could reach (every one of its words matching), there is no answer.
 * Calibrated on the 159 eval questions and 28 free ones (all but two, which the base barely covers, score 0.24 or more)
 * against the 30 out-of-scope questions of tests/fixtures/knowledge/questions.json (0.222 at most). The gap is narrow:
 * lexical overlap cannot tell an unrelated question that reuses a few domain words from a real one, so a second gate
 * (the best hit must cover two of the user's words; numbers are not words) catches the single-coincidence cases.
 */
export declare const MIN_RELEVANCE = 0.22;
/** Folded, stopword-free, stemmed. "z_hop_types" and "2.8.4.57" stay whole and, unless purely numeric, also split into parts. */
export declare function tokenize(text: string): string[];
interface Doc {
    topic: Topic;
    tf: Map<string, number>;
    len: number;
}
export interface SearchIndex {
    docs: Doc[];
    df: Map<string, number>;
    avgLen: number;
    /** Per synonym group, per term, its tokens. */
    groups: string[][][];
    /** Every printer id a topic is for ("x2d", "a1-mini"). */
    printers: string[];
}
export declare function buildIndex(topics: Topic[], rulesByTopic: Map<string, Rule[]>, synonyms: string[][]): SearchIndex;
export interface SearchOptions {
    domain?: "bambu" | "blender" | "both";
    /** Normalised printer id ("x2d", "a1-mini"). */
    printer?: string;
    limit?: number;
}
export interface Hit {
    topic: Topic;
    score: number;
}
export interface SearchResult {
    hits: Hit[];
    noMatch: boolean;
    relevance: number;
}
export declare function search(index: SearchIndex, query: string, options?: SearchOptions): SearchResult;
/** One index per loaded KB. */
export declare function indexFor(kb: {
    topics: Topic[];
    rulesByTopic: Map<string, Rule[]>;
    synonyms: string[][];
}): SearchIndex;
export {};
