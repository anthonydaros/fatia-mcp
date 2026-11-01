// Declared part facts: the object.* facts that nobody can compute (spec section 7: kind, load class, mold kind, large / tall-narrow / tiny, fit pins and
// holes, tight-fit male part; plus the cut flags the 3MF analyzer cannot read yet). The user or the agent states them; an absent one is unknown and the
// actions that need it are skipped and reported. Nothing here infers a value from a number: the guide gives no threshold for "large", "tall and narrow"
// or "tiny", so geometry can only be offered as a SUGGESTED declaration with its numbers shown, never as a value.
import { leaves } from "../knowledge/loader.js";
import type { Condition, Facts } from "../knowledge/types.js";
import type { ScanEvidence, ScanValue } from "./gcode-scan.js";
import type { RoundResult, TuningAction } from "./types.js";

/**
 * The data's own vocabulary (tuning.json conditions and spec section 7). `mold_kind: "none"` is the one addition: the data only names the two molds, and
 * without a way to say "not a mold" the five mold actions would stay unknown instead of false.
 */
export const PART_ENUMS = {
  kind: ["keychain", "pix_plate", "face_down_plate", "other"],
  load_class: ["none", "functional", "high_load"],
  mold_kind: ["rigid", "silicone", "none"],
} as const;
export const PART_BOOLEANS = ["is_large_part", "is_tall_narrow", "is_tiny_part", "has_fit_pins_and_holes", "has_tight_fit_male_part", "is_cut_part", "is_cut_pin"] as const;

export type PartContext = {
  [K in keyof typeof PART_ENUMS]?: (typeof PART_ENUMS)[K][number];
} & { [K in (typeof PART_BOOLEANS)[number]]?: boolean };

const KEYS: readonly string[] = [...Object.keys(PART_ENUMS), ...PART_BOOLEANS];
/** The fact names a declaration can set. */
export const DECLARED_FACTS: readonly string[] = KEYS.map(k => `object.${k}`);

/** Validates a declaration (a plain object of the keys above); throws an Error that names the key and the allowed values. Absent or null = no declaration. */
export function parsePartContext(input: unknown): PartContext {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("part context must be an object.");
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!KEYS.includes(key)) throw new Error(`part context: unknown key "${key}". Allowed: ${KEYS.join(", ")}.`);
    const allowed = (PART_ENUMS as Record<string, readonly string[]>)[key];
    if (allowed) {
      if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`part context: ${key} must be one of ${allowed.join(", ")}.`);
    } else if (typeof value !== "boolean") throw new Error(`part context: ${key} must be true or false.`);
    out[key] = value;
  }
  return out as PartContext;
}

export interface DeclaredFacts {
  facts: Facts;
  /** Every fact here came from a declaration, not from a measurement. */
  provenance: Record<string, "declared">;
  evidence: Record<string, ScanEvidence>;
}
/** object.* facts of a (validated) declaration. */
export function partContextFacts(context: PartContext): DeclaredFacts {
  const out: DeclaredFacts = { facts: {}, provenance: {}, evidence: {} };
  for (const [key, value] of Object.entries(parsePartContext(context))) {
    const name = `object.${key}`;
    out.facts[name] = value as boolean | string;
    out.provenance[name] = "declared";
    out.evidence[name] = { source: "declared by the user or the agent", method: "declared input", approx: false, notes: "not measured: nothing in the 3MF or the mesh can say it" };
  }
  return out;
}

/** Every fact an action reads in `when`, in a ladder's trigger and step guards, and in a choice's evaluated_by. */
export function factsRead(action: TuningAction): Set<string> {
  const names = new Set<string>();
  const add = (c: Condition | undefined) => { if (c) for (const l of leaves(c)) names.add(l.fact); };
  add(action.when);
  if (action.kind === "ladder") { add(action.trigger); for (const s of action.steps) add(s.only_if); }
  if (action.kind === "choice") for (const f of action.evaluated_by ?? []) names.add(f);
  return names;
}

export interface DeclarationImpact {
  fact: string;
  declared: boolean;
  /** `also_needs`: other non-settings facts the action reads and nobody provided yet; declaring this fact alone may not be enough. */
  actions: Array<{ id: string; title: string; also_needs: string[] }>;
}
const SETTLED = /^(settings|printer|filament|studio)\./;
/** For each declarable fact, the actions that read it. `provided` = fact names already known (declared or measured). */
export function declarationImpact(actions: readonly TuningAction[], provided: Iterable<string> = []): DeclarationImpact[] {
  const known = new Set(provided);
  const out = DECLARED_FACTS.map((fact): DeclarationImpact => ({ fact, declared: known.has(fact), actions: [] }));
  for (const a of actions) {
    const read = factsRead(a);
    for (const impact of out) {
      if (!read.has(impact.fact)) continue;
      impact.actions.push({ id: a.id, title: a.title, also_needs: [...read].filter(f => f !== impact.fact && !SETTLED.test(f) && !known.has(f)).sort() });
    }
  }
  return out.filter(i => i.actions.length).sort((x, y) => y.actions.length - x.actions.length || (x.fact < y.fact ? -1 : 1));
}

export interface UndeclaredSkips {
  /** Distinct actions that could not be evaluated because a declarable fact was missing. */
  count: number;
  actions: string[];
  by_fact: Record<string, string[]>;
  /** The sentence for the report. */
  text: string;
}
/** From an engine result: which skipped actions were skipped because the part was not described. */
export function skippedByUndeclared(round: Pick<RoundResult, "skipped_unknown" | "unknown">): UndeclaredSkips {
  const byFact: Record<string, Set<string>> = {};
  const rows = [...round.skipped_unknown.map(s => ({ action: s.action, missing: s.missing })), ...round.unknown.map(u => ({ action: u.action, missing: u.missing }))];
  for (const row of rows) for (const f of row.missing) if (DECLARED_FACTS.includes(f)) (byFact[f] ??= new Set()).add(row.action);
  const by_fact = Object.fromEntries(Object.entries(byFact).sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, set]) => [f, [...set].sort()]));
  const actions = [...new Set(Object.values(by_fact).flat())].sort();
  const parts = Object.entries(by_fact).sort((a, b) => b[1].length - a[1].length).map(([f, ids]) => `${f} (${ids.length})`);
  return {
    count: actions.length, actions, by_fact,
    text: actions.length ? `${actions.length} actions were skipped because the part was not described: ${parts.join(", ")}.` : "No action was skipped for a missing part description.",
  };
}

export interface SuggestedDeclaration {
  fact: string;
  /** The measurements behind the question, in the units of their fact names. */
  numbers: Record<string, number>;
  note: string;
}
const GIVEN = (facts: Record<string, ScanValue>, names: string[]): Record<string, number> =>
  Object.fromEntries(names.filter(n => typeof facts[n] === "number").map(n => [n, facts[n] as number]));
/**
 * Questions for the user, with the numbers that bear on them. There is deliberately no value and no threshold: the guide gives none for "large",
 * "tall and narrow" or "tiny", so the answer is the user's. A fact the geometry says nothing about is not offered.
 */
export function suggestDeclarations(meshFacts: Record<string, ScanValue>): SuggestedDeclaration[] {
  const ask = (fact: string, names: string[], what: string): SuggestedDeclaration[] => {
    const numbers = GIVEN(meshFacts, names);
    return Object.keys(numbers).length === names.length ? [{ fact, numbers, note: `${what} The guide gives no threshold, so this is not inferred: declare it if it applies.` }] : [];
  };
  return [
    ...ask("object.is_tall_narrow", ["mesh.height_mm", "mesh.footprint_area_mm2", "mesh.height_to_footprint"], "Is the part tall and narrow (guide 10.2)?"),
    ...ask("object.is_tiny_part", ["mesh.size_x_mm", "mesh.size_y_mm", "mesh.footprint_area_mm2"], "Is the part tiny (guide 10.4)?"),
    ...ask("object.is_large_part", ["mesh.size_x_mm", "mesh.size_y_mm", "mesh.height_mm"], "Is the part a large box or plate?"),
  ];
}
