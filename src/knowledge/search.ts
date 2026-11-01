// Dependency-free BM25 over topics. Query side only: stopwords, light stemming, synonym expansion, printer down-weighting.
import type { Rule, Topic } from "./types.js";

// K1 1.5, not the textbook 1.2: one more eval question lands first, and the other measures did not move.
const K1 = 1.5;
const B = 0.75;
/** Field weights: what a user types is closest to symptoms and titles; the body only backs up new wording. */
const W = { symptoms: 4, title: 3, tags: 3, rules: 2, body: 1 };
/** Synonym-only query terms count half. */
const SYNONYM_WEIGHT = 0.5;
/** A topic of another printer keeps its place but loses half its score, unless the query names a printer the topic is for. */
const OTHER_PRINTER = 0.5;
/** Below this the best hit shares only some of the user's words: consult_knowledge flags it so the agent says the base barely touches the subject. */
export const LOW_RELEVANCE = 0.45;
/**
 * Below this share of the best score a query could reach (every one of its words matching), there is no answer.
 * Calibrated on the 159 eval questions and 28 free ones (all but two, which the base barely covers, score 0.24 or more)
 * against the 30 out-of-scope questions of tests/fixtures/knowledge/questions.json (0.222 at most). The gap is narrow:
 * lexical overlap cannot tell an unrelated question that reuses a few domain words from a real one, so a second gate
 * (the best hit must cover two of the user's words; numbers are not words) catches the single-coincidence cases.
 */
export const MIN_RELEVANCE = 0.22;

const STOPWORDS = new Set(("a o as os um uma uns umas de do da dos das em no na nos nas num numa por para pra com sem sob sobre e ou mas que se ao aos como mais menos muito muita muitos muitas pouco " +
  "quando onde qual quais quem meu minha meus minhas seu sua seus suas esse essa esses essas este esta estes estas isso isto aquele aquela eu voce ele ela eles elas ser sao estao foi tem ter ja nao sim vai " +
  "estou posso pode podem preciso devo deve fazer faz faco quero queria gostaria tenho me fica ficar entre ate tambem so apenas the an of to in on at for with without by from and or but is are was were be been it its this that these those " +
  "how what when where why which who do does did can could should would my your i you we they he she not no if then than as also just about into onto over under").split(" "));

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/(\d),(?=\d)/g, "$1.");

/** Plural, -coes/-cao, -mente, -ing/-ed. Identifiers and numbers (z_hop_types, 2.8.4.57, a1) are left alone. */
function stem(t: string): string {
  if (t.length < 4 || /[\d._]/.test(t)) return t;
  if (/(?:oes|aes)$/.test(t)) return `${t.slice(0, -3)}ao`;
  if (t.length > 7 && t.endsWith("mente")) return t.slice(0, -5);
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.endsWith("ais") || t.endsWith("eis")) return `${t.slice(0, -2)}l`;
  if (/[rzx]es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/** Folded, stopword-free, stemmed. "z_hop_types" and "2.8.4.57" stay whole and, unless purely numeric, also split into parts. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const tok of fold(text).match(/[a-z0-9]+(?:[._][a-z0-9]+)*/g) ?? []) {
    const parts = tok.split(/[._]/);
    if (parts.length > 1) out.push(tok);
    // A loop, not push(...parts): a hostile 100k-part token would overflow the argument stack.
    if (parts.length === 1 || parts.some(p => /[a-z]/.test(p))) for (const p of parts) out.push(p);
  }
  return out.filter(t => !STOPWORDS.has(t)).map(stem);
}

interface Doc { topic: Topic; tf: Map<string, number>; len: number }
export interface SearchIndex {
  docs: Doc[];
  df: Map<string, number>;
  avgLen: number;
  /** Per synonym group, per term, its tokens. */
  groups: string[][][];
  /** Every printer id a topic is for ("x2d", "a1-mini"). */
  printers: string[];
}

export function buildIndex(topics: Topic[], rulesByTopic: Map<string, Rule[]>, synonyms: string[][]): SearchIndex {
  const df = new Map<string, number>();
  const docs = topics.map(topic => {
    const rules = rulesByTopic.get(topic.id) ?? [];
    const fields: Array<[number, string]> = [
      [W.symptoms, topic.symptoms.join(" ")],
      [W.title, topic.title],
      [W.tags, `${topic.tags.join(" ")} ${topic.id.split(".").slice(1).join(" ").replace(/-/g, " ")}`],
      // Fact names lose their namespace so "z_hop_types" matches settings.z_hop_types.
      [W.rules, rules.map(r => `${r.title} ${r.problem} ${r.detect.facts.map(f => f.replace(/^[a-z]+\./, "")).join(" ")} ${Object.keys(r.solution.settings ?? {}).join(" ")}`).join(" ")],
      [W.body, topic.body],
    ];
    const tf = new Map<string, number>();
    let len = 0;
    for (const [weight, text] of fields) {
      for (const term of tokenize(text)) {
        tf.set(term, (tf.get(term) ?? 0) + weight);
        len += weight;
      }
    }
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    return { topic, tf, len };
  });
  return {
    docs, df,
    avgLen: docs.reduce((n, d) => n + d.len, 0) / (docs.length || 1),
    groups: synonyms.map(g => g.map(tokenize)),
    printers: [...new Set(topics.flatMap(t => t.printers))],
  };
}

/**
 * Weighted query terms: the user's own at 1, synonyms of any group they trigger at 0.5. A group fires when every word of
 * one of its terms is in the query, in any order ("faces viradas" fires on "as faces ficaram viradas"). `via` maps a
 * synonym word back to the user's words that brought it in.
 */
function queryTerms(index: SearchIndex, query: string): { terms: Map<string, number>; own: Set<string>; via: Map<string, Set<string>> } {
  const own = new Set(tokenize(query));
  const terms = new Map<string, number>([...own].map(t => [t, 1]));
  const via = new Map<string, Set<string>>();
  for (const group of index.groups) {
    const triggers = group.filter(term => term.length > 0 && term.every(t => own.has(t))).flat();
    if (!triggers.length) continue;
    for (const synonym of group.flat()) {
      if (own.has(synonym)) continue;
      terms.set(synonym, SYNONYM_WEIGHT);
      via.set(synonym, new Set([...(via.get(synonym) ?? []), ...triggers]));
    }
  }
  return { terms, own, via };
}

export interface SearchOptions {
  domain?: "bambu" | "blender" | "both";
  /** Normalised printer id ("x2d", "a1-mini"). */
  printer?: string;
  limit?: number;
}
export interface Hit { topic: Topic; score: number }
export interface SearchResult { hits: Hit[]; noMatch: boolean; relevance: number }

export function search(index: SearchIndex, query: string, options: SearchOptions = {}): SearchResult {
  const { terms, own, via } = queryTerms(index, query);
  const n = index.docs.length;
  const idf = (t: string) => { const d = index.df.get(t) ?? 0; return Math.log(1 + (n - d + 0.5) / (d + 0.5)); };
  // Best score the user's own words could reach: every term at saturation. A word the base has never seen still counts.
  let ceiling = 0;
  for (const t of own) ceiling += idf(t) * (K1 + 1);
  // "a1 mini" and "a1mini" name a1-mini; a printer the user typed is never "another printer".
  const named = new Set(index.printers.filter(p => own.has(p.replace("-", "")) || p.split("-").every(w => own.has(w))));
  const scored: Hit[] = [];
  let best = 0;
  for (const { topic, tf, len } of index.docs) {
    if (options.domain && options.domain !== "both" && topic.domain !== "both" && topic.domain !== options.domain) continue;
    let score = 0;
    for (const [t, w] of terms) {
      const f = tf.get(t);
      if (f) score += w * idf(t) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * len / index.avgLen));
    }
    if (score <= 0) continue;
    best = Math.max(best, score);
    const elsewhere = options.printer && topic.printers.length > 0 && !topic.printers.includes(options.printer) && !topic.printers.some(p => named.has(p));
    scored.push({ topic, score: elsewhere ? score * OTHER_PRINTER : score });
  }
  scored.sort((a, b) => b.score - a.score || a.topic.id.localeCompare(b.topic.id));
  const relevance = ceiling > 0 ? Math.min(1, best / ceiling) : 0;
  // One coincidental word ("faço" in a baking question, "world") is not an answer: from three words up, the best hit
  // must cover two of the user's words, directly or through a synonym of theirs.
  const doc = scored.length ? index.docs.find(d => d.topic === scored[0].topic)! : undefined;
  const covered = (word: string) => doc!.tf.has(word) || [...via].some(([synonym, from]) => from.has(word) && doc!.tf.has(synonym));
  // Numbers ("2014", "0.4", "11") match by chance in any spec table, so they neither count as covered nor as words to cover.
  const words = [...own].filter(w => /[a-z]/.test(w));
  const shared = doc ? words.filter(covered).length : 0;
  const needed = Math.min(2, Math.max(1, words.length - 1));
  return { hits: scored.slice(0, options.limit ?? 4), noMatch: relevance < MIN_RELEVANCE || shared < needed, relevance };
}

const indexes = new WeakMap<object, SearchIndex>();
/** One index per loaded KB. */
export function indexFor(kb: { topics: Topic[]; rulesByTopic: Map<string, Rule[]>; synonyms: string[][] }): SearchIndex {
  let index = indexes.get(kb);
  if (!index) indexes.set(kb, index = buildIndex(kb.topics, kb.rulesByTopic, kb.synonyms));
  return index;
}
