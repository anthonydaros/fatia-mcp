// Three-valued evaluation of rules[].detect.when, as kb/CONTRACT.md defines it and
// kb/evaluate-rules.mjs implements it. true = holds, false = does not, undefined = unknown (unchecked).
import type { Condition, Facts, Op, Rule, Scalar } from "./types.js";

export const OPS: ReadonlySet<string> = new Set<Op>(["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "exists", "matches", "any_eq"]);

// (\d+(\.\d*)?) not \d+\.?\d*: overlapping digit runs backtrack quadratically on a long hostile 3MF value.
const NUM = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const num = (v: Scalar): number | null =>
  typeof v === "number" ? (Number.isFinite(v) ? v : null) : typeof v === "string" && NUM.test(v.trim()) ? Number(v) : null;

/**
 * Both sides plain decimals compare as numbers, else as UTF-16 strings ("2.8.4.57" and "PLA" are strings).
 * Percentages: when BOTH sides end in "%" the sign is stripped and they compare as numbers ("5%" < "30%"),
 * so "25.0%" equals "25%"; when only one side has it ("25%" vs "25") they stay strings and differ.
 */
function cmp(a: Scalar, b: Scalar): number {
  const pct = typeof a === "string" && typeof b === "string" && a.trim().endsWith("%") && b.trim().endsWith("%");
  const x = num(pct ? (a as string).trim().slice(0, -1) : a);
  const y = num(pct ? (b as string).trim().slice(0, -1) : b);
  if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0;
  const s = String(a), t = String(b);
  return s < t ? -1 : s > t ? 1 : 0;
}

/**
 * `matches` subjects come from an untrusted 3MF and some shipped patterns are quadratic ("inner.*outer.*inner"),
 * so a subject longer than this is unknown instead of being run (1 MB would block the event loop for ~90 s).
 * Real setting values are a few dozen characters.
 */
const MATCH_MAX = 4096;

const regexCache = new Map<string, RegExp | null>();
/** Compiled once; an invalid pattern is cached as null and makes the leaf unknown. */
function regex(pattern: string): RegExp | null {
  if (!regexCache.has(pattern)) {
    try { regexCache.set(pattern, new RegExp(pattern)); } catch { regexCache.set(pattern, null); }
  }
  return regexCache.get(pattern)!;
}

const isScalar = (x: unknown): x is Scalar => ["string", "number", "boolean"].includes(typeof x);

type Test = (a: Scalar, b: unknown) => boolean | undefined;
const TEST: Partial<Record<Op, Test>> = {
  eq: (a, b) => cmp(a, b as Scalar) === 0,
  neq: (a, b) => cmp(a, b as Scalar) !== 0,
  gt: (a, b) => cmp(a, b as Scalar) > 0,
  gte: (a, b) => cmp(a, b as Scalar) >= 0,
  lt: (a, b) => cmp(a, b as Scalar) < 0,
  lte: (a, b) => cmp(a, b as Scalar) <= 0,
  in: (a, b) => {
    if (!Array.isArray(b)) throw new TypeError("op in needs an array value");
    return b.some(x => cmp(a, x as Scalar) === 0);
  },
  matches: (a, b) => { const s = String(a); return s.length > MATCH_MAX ? undefined : regex(String(b))?.test(s); },
};

function leaf(c: { fact: string; op: Op; value?: unknown }, facts: Facts): boolean | undefined {
  if (!OPS.has(c.op)) throw new TypeError(`bad op ${c.op}`);
  const v = facts[c.fact];
  if (v === undefined) return undefined;
  if (v === null) return c.op === "exists" ? false : undefined;
  if (c.op === "exists") return true;
  const want = c.value as Scalar;
  if (Array.isArray(v)) {
    if (!v.every(isScalar)) return undefined;
    // Per-filament / per-extruder lists: any_eq and contains need one element, every other op needs all of them.
    if (c.op === "any_eq" || c.op === "contains") return v.some(x => cmp(x, want) === 0);
    let unknown = false;
    for (const x of v) {
      const r = TEST[c.op]!(x, c.value);
      if (r === false) return false;
      if (r === undefined) unknown = true;
    }
    return unknown ? undefined : true;
  }
  if (!isScalar(v)) return undefined; // an object where a scalar belongs cannot be judged
  if (c.op === "any_eq") return cmp(v, want) === 0;
  if (c.op === "contains") return String(v).includes(String(want));
  return TEST[c.op]!(v, c.value);
}

export function evalCondition(c: Condition, facts: Facts): boolean | undefined {
  if (!c || typeof c !== "object") throw new TypeError("condition must be an object");
  if ("all" in c || "any" in c) {
    const list = "all" in c ? c.all : c.any;
    if (!Array.isArray(list) || !list.length) throw new TypeError("all/any need a non-empty array");
    const rs = list.map(x => evalCondition(x, facts));
    if ("all" in c) return rs.includes(false) ? false : rs.includes(undefined) ? undefined : true;
    return rs.includes(true) ? true : rs.includes(undefined) ? undefined : false;
  }
  if ("not" in c) {
    const r = evalCondition(c.not, facts);
    return r === undefined ? undefined : !r;
  }
  return leaf(c, facts);
}

/** "Bambu Lab A1 mini" -> "a1-mini": the form rule.printers uses. */
export const modelId = (m: unknown): string => String(m).trim().toLowerCase().replace(/^bambu\s*lab\s+/, "").replace(/\s+/g, "-");

const and3 = (a: boolean | undefined, b: boolean | undefined) => (a === false || b === false ? false : a === undefined || b === undefined ? undefined : true);

/** A rule with a non-empty `printers` list also needs printer.model to be one of them (unknown model = unknown). */
function inScope(rule: Pick<Rule, "printers">, facts: Facts): boolean | undefined {
  if (!rule.printers?.length) return true;
  const m = facts["printer.model"];
  if (m === undefined || m === null) return undefined;
  return ([] as Scalar[]).concat(m).every(x => rule.printers.includes(modelId(x)));
}

/** Verdict for a rule that has a machine condition: its printer scope AND its detect.when. */
export const ruleStatus = (rule: Pick<Rule, "printers" | "detect">, facts: Facts): boolean | undefined =>
  and3(inScope(rule, facts), evalCondition(rule.detect.when as Condition, facts));
