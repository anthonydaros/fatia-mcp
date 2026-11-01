// Locates, reads and checks knowledge/tuning/ (copied by scripts/build-knowledge.mjs from kb/tuning/out). Loaded on first use, like the
// knowledge base it points into; a missing or broken folder is an Error the tool reports, never a crash, and is not cached.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OPS } from "../knowledge/condition.js";
import { getKb, kbDir, leaves, type Kb } from "../knowledge/loader.js";
import type { Condition, Fact, Manifest } from "../knowledge/types.js";
import { parseVersionPredicate } from "../knowledge/version.js";
import type { NoAction, TuningAction } from "./types.js";

export const TUNING_FILES = ["tuning.json", "no_action.json", "tuning-facts.json"] as const;
/** Namespaces whose facts need no declaration (the project and the installed Studio say them). */
const FREE_NAMESPACES = /^(settings|printer|project|studio|plate|slicer)\./;

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
export const tuningDir = (): string => path.join(kbDir(), "tuning");

const canonical = (text: string) => text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The conditions of an action in the places the engine evaluates them. */
function conditionsOf(a: TuningAction): Array<[string, Condition]> {
  const out: Array<[string, Condition]> = [["when", a.when]];
  if (a.kind === "ladder") {
    out.push(["trigger", a.trigger]);
    a.steps.forEach((s, i) => { if (s.only_if) out.push([`steps[${i}].only_if`, s.only_if]); });
  }
  return out;
}

/** Referential and shape checks the engine relies on. scripts/validate-knowledge.mjs is the full contract check at build time. */
function validate(actions: unknown, noAction: unknown, facts: unknown, kb: Kb): string[] {
  const errors: string[] = [];
  if (!Array.isArray(actions) || !Array.isArray(noAction) || !Array.isArray(facts)) return ["tuning.json, no_action.json and tuning-facts.json must each be an array"];
  const declared = new Set([...kb.facts.map(f => f.name), ...(facts as Fact[]).map(f => f?.name)]);
  for (const f of facts as Fact[]) if (String(f?.name).startsWith("blender.")) errors.push(`fact ${f.name}: tuning must not depend on Blender`);
  const seen = new Set<string>();
  for (const a of actions as TuningAction[]) {
    const id = String(a?.id);
    if (seen.has(id)) errors.push(`duplicate action id ${id}`);
    seen.add(id);
    try {
      if (a.kind === "ladder") { if (!a.trigger || !Array.isArray(a.steps) || !a.steps.length) errors.push(`${id}: a ladder needs a trigger and steps`); }
      else if (a.kind === "choice") { if (a.candidates?.[a.start] === undefined) errors.push(`${id}: choice start is not a candidate index`); }
      else if (a.kind === undefined || a.kind === "definite") { if (!a.set || typeof a.set !== "object") errors.push(`${id}: a definite action needs set`); }
      else errors.push(`${id}: bad kind ${String((a as { kind: unknown }).kind)}`);
      if (!Array.isArray(a.rules) || !a.rules.length) errors.push(`${id}: rules must list at least one rule`);
      for (const r of a.rules ?? []) if (kb.ruleById.get(r)?.domain !== "bambu") errors.push(`${id}: rule ${r} is not a bambu rule of the knowledge base`);
      if (!kb.topicById.has(a.topic)) errors.push(`${id}: topic ${a.topic} does not exist`);
      for (const [key, predicate] of Object.entries(a.applies_to ?? {})) if (!parseVersionPredicate(predicate)) errors.push(`${id}: applies_to.${key} "${predicate}" does not parse`);
      const names: string[] = a.kind === "choice" ? [...(a.evaluated_by ?? [])] : [];
      for (const [where, c] of conditionsOf(a)) {
        if (where === "when" && "all" in c && Array.isArray(c.all) && !c.all.length) continue; // {"all": []} = unconditional
        for (const leaf of leaves(c)) {
          if (!OPS.has(leaf.op)) errors.push(`${id}: ${where} has bad op ${leaf.op}`);
          else if (leaf.op === "in" && !Array.isArray(leaf.value)) errors.push(`${id}: ${where}: op in needs an array value`);
          names.push(leaf.fact);
        }
      }
      for (const f of names) {
        if (f.startsWith("blender.")) errors.push(`${id}: uses ${f}; tuning must not depend on Blender`);
        else if (!declared.has(f) && !FREE_NAMESPACES.test(f)) errors.push(`${id}: fact ${f} is not declared`);
      }
    } catch (error) {
      errors.push(`${id}: malformed action (${(error as Error).message})`);
    }
  }
  for (const n of noAction as NoAction[]) if (!kb.ruleById.has(n?.rule)) errors.push(`no_action: rule ${n?.rule} does not exist`);
  return errors;
}

export function loadTuningFrom(dir: string, kb: Kb): Tuning {
  const read = (file: string, folder = dir): string => {
    try {
      return canonical(fs.readFileSync(path.join(folder, file), "utf8"));
    } catch (error) {
      throw new Error(`Tuning data unavailable: cannot read ${file} in ${folder} (${(error as Error).message}). Reinstall the package, or set BAMBU_KB_DIR to a folder built by scripts/build-knowledge.mjs.`);
    }
  };
  const raw = Object.fromEntries(TUNING_FILES.map(name => [name, read(name)]));
  const parse = (name: string) => {
    try { return JSON.parse(raw[name]); } catch (error) { throw new Error(`Tuning data unreadable: ${name} in ${dir} is not valid JSON (${(error as Error).message}).`); }
  };
  const actions: TuningAction[] = parse("tuning.json");
  const noAction: NoAction[] = parse("no_action.json");
  const facts: Fact[] = parse("tuning-facts.json");
  let errors: string[];
  try { errors = validate(actions, noAction, facts, kb); } catch (error) { errors = [`malformed entry (${(error as Error).message})`]; }
  if (errors.length) throw new Error(`Tuning data in ${dir} is invalid (${errors.length} problems): ${errors.slice(0, 10).join("; ")}`);

  let integrity: Tuning["integrity"] = "mismatch";
  let version = "unknown";
  try {
    const manifest: Manifest = JSON.parse(read("manifest.json", path.dirname(dir)));
    version = String(manifest.kb_version);
    if (TUNING_FILES.every(name => manifest.files?.[`tuning/${name}`] === sha256(raw[name]))) integrity = "ok";
  } catch {
    // An unreadable manifest leaves integrity at "mismatch"; the content itself already validated.
  }
  return { dir, version, integrity, actions, noAction, facts, actionById: new Map(actions.map(a => [a.id, a])) };
}

let cached: { dir: string; kbDir: string; tuning: Tuning } | undefined;
/** Late and cached; a failure is not cached, so fixing the folder works without restarting the server. */
export function getTuning(): Tuning {
  const kb = getKb();
  const dir = tuningDir();
  if (cached?.dir !== dir || cached.kbDir !== kb.dir) cached = { dir, kbDir: kb.dir, tuning: loadTuningFrom(dir, kb) };
  return cached.tuning;
}
