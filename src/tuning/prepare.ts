// prepare_print_project: the plan-slice-measure-adjust loop. A part goes in (3MF project or STL); a NEW unsliced project 3MF with tuned parameters comes out,
// together with a report that says what was changed, what was measured and what was only predicted. The original is never written, nothing is printed,
// no printer is contacted. Slicing goes through the Bambu Studio CLI only (injected as deps.slice), one candidate per round.
//
//   baseline  P0 (the retargeted, untuned project) is sliced once and scanned: the "before" of the report. It is NOT engine state.
//   round 0   pre-slice facts -> applyTuning -> write candidate -> slice -> scan -> facts
//   round k   nextRound(facts of the last slice) -> write candidate -> slice -> scan -> facts ... until done, stalled, exhausted, cycle, budget,
//             cancellation or an error. Every round is kept; the best measured one is delivered (see rank).
//   deliver   the best round is written again to output_dir (never over an existing file), the source's SHA-256 is checked, preflight_check judges
//             the structure/volume blockers of the deliverable, and the file is opened (unsliced) in Bambu Studio unless told not to.
// Design, budget and how to read the report: docs/TUNING.md.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { evalCondition } from "../knowledge/condition.js";
import { openProject } from "../knowledge/facts/settings.js";
import { getKb } from "../knowledge/loader.js";
import { printerId } from "../knowledge/tools.js";
import type { Facts } from "../knowledge/types.js";
import { loadSafe3mfArchive, readBoundedPrintFile } from "../safety/archive.js";
import { removeQuietly } from "../stl/stl-manipulator.js";
import { checkBlockValue } from "./config-block.js";
import { applyTuning, eqv, nextRound } from "./engine.js";
import { collectFacts, type Collected } from "./facts.js";
import type { GcodeScan, ScanValue } from "./gcode-scan.js";
import { meshFactsFromProject, meshFactsFromStl, type MeshFacts } from "./mesh-facts.js";
import { parsePartContext, type PartContext } from "./part-context.js";
import { buildReport } from "./prepare-report.js";
import { writeTunedProject, type ChangeScope, type Retargeter, type SettingChange, type WriteResult } from "./project-writer.js";
import type { SliceArtifacts } from "./slice-facts.js";
import type { ApplyResult, NoAction, RoundResult, Settings, StudioKeys, TuningAction, TuningItem, TuningOptions } from "./types.js";

export type StopReason = "done" | "stalled" | "exhausted" | "cycle" | "budget_slices" | "budget_minutes" | "cancelled" | "error" | "dry_run";
export const STRONG_CONFIDENCES = ["preset", "oficial", "bug conhecido"];

export interface PrepareInput {
  path: string;
  /** 0-based. */
  plateIndex: number;
  /** A valid bambu_model, e.g. "x2d". */
  model: string;
  partContext?: unknown;
  /** CLI slices allowed in all, the baseline and an STL's retarget slice included. */
  maxSlices: number;
  maxMinutes: number;
  outputDir: string;
  outputName?: string;
  openInStudio: boolean;
  apply: "recommended" | "strong_only";
  dryRun: boolean;
  signal?: AbortSignal;
  /** `step` only grows, so a client can show it as progress. */
  onProgress?: (p: { step: number; slices: number; max: number; message: string }) => void;
}

/** What one slice produced, already scanned. */
export interface SliceOutcome {
  gcode: GcodeScan;
  slice: Omit<SliceArtifacts, "plateIndex" | "gcode">;
  /** CONFIG_BLOCK of the G-code: proves which values the slicer really used. */
  block?: Record<string, string>;
  ms?: number;
}

export interface PrepareDeps {
  tuning: { actions: TuningAction[]; noAction: NoAction[]; version?: string; integrity?: string };
  /** "Bambu Lab X2D 0.4 nozzle" */
  printerPreset: string;
  /** Scratch parent (the server's TEMP_DIR). */
  tempDir: string;
  /** Needed for an STL, a 3MF without settings, or a project made for another printer. */
  retarget?: Retargeter;
  slice(project: string, signal?: AbortSignal): Promise<SliceOutcome>;
  installedStudio(): Promise<string | null>;
  /** preflight_check on a file; read-only. */
  preflight(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  openInStudio(file: string): Promise<unknown>;
  now?(): number;
  studioKeys?: StudioKeys;
}

/** The measurements of one slice. */
export interface Measure {
  /** Every gcode.*, plate.* and slicer.* fact of the slice. */
  facts: Record<string, ScanValue>;
  ms: number;
  /** Per changed key: did the slice's CONFIG_BLOCK show the tuned value? null = could not be compared. */
  reach: Record<string, boolean | null>;
  reused_from?: "baseline";
}
export interface BlockerHit { rule: string; title: string; confidence: string; evidence: Record<string, unknown> }
export interface BlockerUnknown { rule: string; title: string; missing: string[] }
/** What the engine said after reading this candidate's measurements. */
export interface Judged {
  triggers_true: string[];
  triggers_false: string[];
  triggers_unknown: string[];
  exhausted: RoundResult["exhausted"];
  blind_facts: string[];
  missing_facts: string[];
  done: boolean;
  stalled: boolean;
  /** Changes the engine asked for next. */
  next_changes: number;
  blockers: BlockerHit[];
  blockers_unknown: BlockerUnknown[];
  /** Blocker rules the G-code decided and found false. */
  blockers_clear: string[];
}
export interface RoundRecord {
  round: number;
  hash: string;
  delta: Delta;
  /** The engine's changes that produced this candidate (against the previous round). */
  changes: TuningItem[];
  advanced: string[];
  relaxed: string[];
  write?: WriteResult;
  measure?: Measure;
  judged?: Judged;
  /** The engine result that read this candidate's measurements; the pre-slice plan in a dry run. */
  engine?: ApplyResult | RoundResult;
  collected?: Collected;
  error?: string;
}
export interface Delta { changes: SettingChange[]; overrides: Record<string, string> }

export interface RunData {
  input: PrepareInput;
  tuning: PrepareDeps["tuning"];
  printerPreset: string;
  declared: PartContext;
  source: { path: string; sha256_before: string; sha256_after: string };
  p0: WriteResult;
  base: Settings;
  baseline?: { measure: Measure; blockers: BlockerHit[] };
  baselineError?: string;
  rounds: RoundRecord[];
  /** Every item the engine wrote, in order, per "s\0key" (settings) or "o\0key" (per-object setting). */
  items: Map<string, TuningItem[]>;
  stop: { reason: StopReason; detail: string };
  slices: { loop: number; retarget: number; max: number };
  minutes: number;
  best?: RoundRecord;
  bestWhy?: string;
  /** What the engine asked for next and was not run (budget, cycle). */
  pending: TuningItem[];
  delivered?: { path: string; write: WriteResult; opened: Record<string, unknown> | null; open_error?: string };
  preflight: { checked: string; blockers: Array<Record<string, unknown>>; unchecked?: unknown; error?: string };
  mesh: MeshFacts;
  installed: string | null;
  warnings: string[];
}

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
type Config = Record<string, unknown>;

/** Strings and lists of strings, the only values the engine and the writer handle. */
function toSettings(config: Config): Settings {
  const out: Settings = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "__proto__") continue;
    if (typeof value === "string" || (Array.isArray(value) && value.every(e => typeof e === "string"))) out[key] = value as string | string[];
  }
  return out;
}

async function readConfig(file: string): Promise<Config> {
  const zip = await loadSafe3mfArchive(await readBoundedPrintFile(file));
  const text = await zip.file("Metadata/project_settings.config")?.async("string");
  if (text === undefined) throw new Error(`${path.basename(file)} has no Metadata/project_settings.config.`);
  return JSON.parse(text.replace(/^﻿/, ""));
}

/** The values to write against P0: every key whose engine value differs from the base, with its scope. */
function deltaOf(base: Settings, plan: Pick<RoundResult, "settings_after" | "object_overrides">, scopes: Map<string, ChangeScope>, warnings: string[]): Delta {
  const changes: SettingChange[] = Object.keys(plan.settings_after).sort()
    .filter(key => !eqv(base[key], plan.settings_after[key]))
    .map(key => ({ key, value: plan.settings_after[key], scope: scopes.get(key) ?? "process" }));
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(plan.object_overrides).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const one = Array.isArray(value) ? (value.every(v => v === value[0]) ? value[0] : undefined) : value;
    if (typeof one === "string") overrides[key] = one;
    else warnings.push(`O ajuste por objeto ${key} tem valores diferentes por elemento; não foi escrito.`);
  }
  return { changes, overrides };
}
const hashOf = (d: Delta) => sha256(Buffer.from(JSON.stringify([d.changes.map(c => [c.key, c.value]), Object.entries(d.overrides)]))).slice(0, 16);

/**
 * Blocker rules the run's own facts decide: the G-code ones, plus the 3MF-structure and mesh ones (volume, prime tower). preflight_check cannot judge those
 * on a 3MF (it cannot read mesh.size_* from one), so they are evaluated here on the facts the collector already holds; a rule whose facts are missing is
 * listed as undecidable, never silently passed.
 */
function factBlockers(facts: Facts, model: string): { hits: BlockerHit[]; unknown: BlockerUnknown[]; clear: string[] } {
  const hits: BlockerHit[] = [];
  const unknown: BlockerUnknown[] = [];
  const clear: string[] = [];
  const scope = printerId(model);
  for (const r of getKb().rules) {
    if (r.severity !== "blocker" || r.domain !== "bambu" || !["gcode", "3mf-structure", "mesh"].includes(r.detect.method) || !r.detect.when) continue;
    if (r.printers.length && (!scope || !r.printers.includes(scope))) continue;
    const verdict = evalCondition(r.detect.when, facts);
    if (verdict === true) hits.push({ rule: r.id, title: r.title, confidence: r.confidence, evidence: Object.fromEntries(r.detect.facts.filter(f => facts[f] !== undefined && facts[f] !== null).map(f => [f, facts[f]])) });
    else if (verdict === false) clear.push(r.id);
    else if (verdict === undefined) unknown.push({ rule: r.id, title: r.title, missing: r.detect.facts.filter(f => facts[f] === undefined || facts[f] === null) });
  }
  return { hits, unknown, clear };
}

const planItems = (plan: ApplyResult | RoundResult): TuningItem[] => ("applied" in plan ? plan.applied : plan.changes);

/** Fewest true triggers, then fewest blockers, then the shortest print time, then the later round. */
const rank = (r: RoundRecord): number[] => {
  const time = r.measure!.facts["plate.time_s"];
  return [r.judged!.triggers_true.length, r.judged!.blockers.length, typeof time === "number" ? time : Infinity, -r.round];
};
function better(a: RoundRecord, b: RoundRecord): boolean {
  const [x, y] = [rank(a), rank(b)];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

function defaultName(source: string): string {
  return `${path.basename(source).replace(/(\.gcode)?\.(3mf|stl)$/i, "")}_tuned.3mf`;
}

export async function prepareProject(input: PrepareInput, deps: PrepareDeps): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const started = now();
  const source = path.resolve(input.path);
  if (!/\.(3mf|stl)$/i.test(source)) throw new Error("prepare_print_project accepts a .3mf project or an .stl file.");
  if (input.outputName !== undefined && (!input.outputName.trim() || /[\\/]/.test(input.outputName) || input.outputName.includes("\0"))) throw new Error("output_name must be a file name, not a path.");
  const outputName = input.outputName === undefined ? defaultName(source) : /\.3mf$/i.test(input.outputName) ? input.outputName : `${input.outputName}.3mf`;
  input.signal?.throwIfAborted();
  const sourceBytes = await readBoundedPrintFile(source);
  const before = sha256(sourceBytes);
  const isStl = /\.stl$/i.test(source);
  const declared = parsePartContext(input.partContext);
  const project = isStl ? undefined : await openProject(source);
  const plateNode = project?.modelSettings?.plate;
  const plates = plateNode === undefined ? 0 : Array.isArray(plateNode) ? plateNode.length : 1;
  if (plates > 0 && input.plateIndex >= plates) throw new Error(`plate_index ${input.plateIndex} is out of range: the 3MF has ${plates} plate(s), numbered from 0.`);

  const warnings: string[] = [];
  const addWarnings = (list: string[]) => { for (const w of list) if (!warnings.includes(w)) warnings.push(w); };
  await fs.mkdir(deps.tempDir, { recursive: true });
  const work = await fs.mkdtemp(path.join(deps.tempDir, "prepare-"));
  try {
    // The retarget runs once (an STL's costs a real slice); every write reuses its outcome.
    let retargetSlices = 0;
    let cached: ReturnType<Retargeter> | undefined;
    const retarget: Retargeter | undefined = deps.retarget && (src => cached ??= deps.retarget!(src).then(o => { retargetSlices += o.slices ?? 0; return o; }));
    const scopes = new Map<string, ChangeScope>();
    const write = (output: string, d: Delta) => writeTunedProject({
      source, output, target: { printerPreset: deps.printerPreset }, changes: d.changes,
      ...(Object.keys(d.overrides).length ? { objectOverrides: { settings: d.overrides } } : {}), retarget,
    });
    const aborted = () => input.signal?.aborted === true;
    let loopSlices = 0;
    let lastSliceMs = 0;
    const used = () => loopSlices + retargetSlices;
    let step = 0;
    const progress = (message: string) => input.onProgress?.({ step: ++step, slices: used(), max: input.maxSlices, message: `${message} (${used()} of ${input.maxSlices} slices used)` });
    const budgetStop = (): StopReason | undefined =>
      aborted() ? "cancelled" : used() >= input.maxSlices ? "budget_slices" : now() - started + lastSliceMs > input.maxMinutes * 60_000 ? "budget_minutes" : undefined;

    // 1. P0: the project for the target printer, nothing tuned. It gives the engine its base settings.
    progress("Building the target-printer project (retarget)");
    const p0 = await write(path.join(work, "p0.3mf"), { changes: [], overrides: {} });
    addWarnings(p0.warnings);
    const base = toSettings(await readConfig(p0.path));
    const installed = await deps.installedStudio().catch(() => null);
    const mesh = isStl
      ? await meshFactsFromStl(source, { settings: base, signal: input.signal })
      : await meshFactsFromProject(project!, input.plateIndex, { settings: base, signal: input.signal });
    const collect = (out?: SliceOutcome): Promise<Collected> => collectFacts({
      project, plateIndex: input.plateIndex, targetModel: input.model, settingsBase: base, mesh, declared, actions: deps.tuning.actions,
      installedStudio: async () => installed, source: path.basename(source), ...(out ? { gcode: out.gcode, slice: out.slice } : {}),
    });
    const engineOptions = (unavailable: string[]): TuningOptions => ({
      printer: input.model, ...(installed ? { studioVersion: installed } : {}), unavailable,
      ...(input.apply === "strong_only" ? { applyConfidences: STRONG_CONFIDENCES } : {}), studioKeys: deps.studioKeys,
    });
    const measureOf = (collected: Collected, ms: number, reach: Measure["reach"]): Measure => ({
      facts: Object.fromEntries(Object.entries(collected.facts).filter(([k, v]) => /^(gcode|plate|slicer)\./.test(k) && v !== null && v !== undefined)) as Record<string, ScanValue>, ms, reach,
    });

    // 2. The baseline: reporting only.
    const baselineHash = hashOf({ changes: [], overrides: {} });
    const measured = new Map<string, { measure: Measure; collected: Collected }>();
    let baseline: RunData["baseline"];
    let baselineError: string | undefined;
    let stop: RunData["stop"] | undefined = aborted() ? { reason: "cancelled", detail: "Cancelado antes do primeiro fatiamento." } : undefined;
    if (!input.dryRun && !stop) {
      const why = budgetStop();
      if (why) stop = { reason: why, detail: "O orçamento de fatiamentos não permite nem o fatiamento de referência." };
      else {
        progress("Slicing the retargeted, untuned project (baseline)");
        try {
          const t = now();
          loopSlices++; // an attempt counts, whether or not it succeeds
          const out = await deps.slice(p0.path, input.signal);
          lastSliceMs = now() - t;
          const collected = await collect(out);
          const measure = measureOf(collected, out.ms ?? lastSliceMs, {});
          baseline = { measure, blockers: factBlockers(collected.facts, input.model).hits };
          measured.set(baselineHash, { measure, collected });
        } catch (error) {
          if (aborted()) stop = { reason: "cancelled", detail: "Cancelado durante o fatiamento de referência." };
          else { baselineError = (error as Error).message; warnings.push(`O fatiamento de referência falhou (${baselineError}); o relatório fica sem os números de "antes".`); }
        }
      }
    }

    // 3. Round 0 and the loop.
    const rounds: RoundRecord[] = [];
    const items = new Map<string, TuningItem[]>();
    let pending: TuningItem[] = [];
    const seen = new Set<string>([baselineHash]);
    let pre: Collected | undefined;
    let plan: ApplyResult | RoundResult | undefined;
    if (!stop) {
      pre = await collect();
      plan = applyTuning(deps.tuning.actions, pre.facts, base, engineOptions(pre.unavailable));
    }
    for (let n = 0; plan && !stop; n++) {
      const requested = planItems(plan);
      for (const item of requested) {
        const slot = `${item.scope === "object" ? "o" : "s"}\0${item.key}`;
        (items.get(slot) ?? items.set(slot, []).get(slot)!).push(item);
        if (item.scope !== "object") scopes.set(item.key, item.scope as ChangeScope);
      }
      const delta = deltaOf(base, plan, scopes, warnings);
      const hash = hashOf(delta);
      const rec: RoundRecord = { round: n, hash, delta, changes: requested, advanced: plan.advanced.map(a => a.action), relaxed: plan.relaxed.map(r => r.action) };
      if (n > 0 && seen.has(hash)) { stop = { reason: "cycle", detail: `A rodada ${n} repetiria os ajustes de uma rodada anterior (${hash}); parou antes de fatiá-la.` }; pending = requested; break; }
      seen.add(hash);
      const file = path.join(work, `round-${n}.3mf`);
      try {
        if (input.dryRun) {
          rec.write = await write(file, delta);
          rec.engine = plan;
          rec.collected = pre;
          rounds.push(rec);
          stop = { reason: "dry_run", detail: "Dry run: o plano foi montado só com os dados do próprio projeto; nada foi fatiado nem medido." };
          break;
        }
        let collected: Collected;
        const reuse = n === 0 ? measured.get(hash) : undefined;
        if (reuse) {
          // Nothing to change in round 0: the candidate is the baseline project, whose measurements are already in hand.
          rec.measure = { ...reuse.measure, reused_from: "baseline" };
          collected = reuse.collected;
        } else {
          const why = budgetStop();
          if (why) {
            stop = { reason: why, detail: why === "cancelled" ? `Cancelado antes da rodada ${n}.` : why === "budget_slices" ? `O orçamento de ${input.maxSlices} fatiamentos acabou; a rodada ${n} foi planejada, mas não fatiada.` : `Outro fatiamento passaria do orçamento de ${input.maxMinutes} minutos; a rodada ${n} foi planejada, mas não fatiada.` };
            pending = requested;
            break;
          }
          rec.write = await write(file, delta);
          addWarnings(rec.write.warnings);
          progress(`Slicing round ${n}`);
          const t = now();
          loopSlices++;
          const out = await deps.slice(file, input.signal);
          lastSliceMs = now() - t;
          collected = await collect(out);
          const config = await readConfig(file);
          const reach = Object.fromEntries(rec.write.changed_keys.map(c => [c.key, out.block ? checkBlockValue(config, out.block, c.key, c.scope).ok : null]));
          rec.measure = measureOf(collected, out.ms ?? lastSliceMs, reach);
        }
        const next = nextRound(deps.tuning.actions, plan.state, collected.facts, engineOptions(collected.unavailable));
        const blockers = factBlockers(collected.facts, input.model);
        rec.engine = next;
        rec.collected = collected;
        rec.judged = {
          triggers_true: next.ladders.filter(l => l.trigger === true).map(l => l.action),
          triggers_false: next.ladders.filter(l => l.trigger === false).map(l => l.action),
          triggers_unknown: next.unknown.map(u => u.action),
          exhausted: next.exhausted, blind_facts: next.blind_facts, missing_facts: next.missing_facts, done: next.done, stalled: next.stalled,
          next_changes: next.changes.length, blockers: blockers.hits, blockers_unknown: blockers.unknown, blockers_clear: blockers.clear,
        };
        rounds.push(rec);
        if (next.done) stop = { reason: "done", detail: `O fatiamento da rodada ${n} não mostra nenhum gatilho e o motor não tem mais o que mudar.` };
        else if (next.stalled) {
          const allExhausted = next.exhausted.length > 0 && next.ladders.filter(l => l.trigger === true).every(l => next.exhausted.some(e => e.action === l.action));
          stop = allExhausted
            ? { reason: "exhausted", detail: `Toda escada que ainda dispara ficou sem degraus (${next.exhausted.map(e => e.action).join(", ")}).` }
            : { reason: "stalled", detail: `O motor não tem o que mudar e não está pronto${next.missing_facts.length ? `; ainda faltam os fatos ${next.missing_facts.join(", ")}` : ""}.` };
        } else plan = next;
      } catch (error) {
        rec.error = (error as Error).message;
        if (!rounds.includes(rec)) rounds.push(rec);
        stop = aborted() ? { reason: "cancelled", detail: `Cancelado durante a rodada ${n}.` } : { reason: "error", detail: `A rodada ${n} falhou: ${rec.error}` };
      }
    }
    stop ??= { reason: "stalled", detail: "O laço terminou sem motivo registrado." };

    // 4. The best measured round is the deliverable (never after a cancellation: the person asked to stop).
    const good = rounds.filter(r => r.measure && r.judged);
    let best: RoundRecord | undefined;
    for (const r of good) if (!best || better(r, best)) best = r;
    const last = good[good.length - 1];
    let bestWhy: string | undefined;
    if (best) {
      bestWhy = best === last
        ? `rodada ${best.round}, a última medida`
        : `rodada ${best.round}, não a última medida (${last.round}): ${best.judged!.triggers_true.length === last.judged!.triggers_true.length ? "mesmo número de gatilhos verdadeiros, mas melhor em bloqueadores ou tempo de impressão" : `menos gatilhos verdadeiros (${best.judged!.triggers_true.length}) que a rodada ${last.round} (${last.judged!.triggers_true.length})`}`;
    }
    const outputDir = path.resolve(input.outputDir);
    let delivered: RunData["delivered"];
    let preflightRun: RunData["preflight"] = { checked: source, blockers: [] };
    const target = stop.reason === "cancelled" ? undefined : best; // a dry run has no measured round, so nothing is delivered
    if (target) {
      try {
        const write2 = await write(path.join(outputDir, outputName), target.delta);
        addWarnings(write2.warnings);
        delivered = { path: write2.path, write: write2, opened: null };
      } catch (error) {
        // The measurements and history are the product of up to max_slices slices: a folder that cannot be written must not throw them away.
        const detail = `Não foi possível gravar o projeto entregue em ${outputDir}: ${(error as Error).message}`;
        stop = { reason: "error", detail };
        warnings.push(detail);
      }
    }

    // 5. The source is untouched; the deliverable has no structure/volume blocker; then it is opened for the person to review and slice.
    const after = sha256(await readBoundedPrintFile(source));
    if (after !== before) warnings.push(`${source} mudou enquanto o laço rodava (o SHA-256 difere); o projeto entregue não foi aberto.`);
    const check = delivered?.path ?? source;
    if (stop.reason !== "cancelled") try {
      const context = { ...(declared.kind ? { object_kind: declared.kind } : {}), ...(declared.mold_kind === "rigid" || declared.mold_kind === "silicone" ? { mold_kind: declared.mold_kind } : {}) };
      const result = await deps.preflight({ file_path: check, bambu_model: input.model, plate_index: input.plateIndex, min_severity: "blocker", max_findings: 50, context });
      const findings = (Array.isArray(result.findings) ? result.findings : []) as Array<Record<string, unknown>>;
      preflightRun = { checked: check, blockers: findings.filter(f => f.severity === "blocker"), unchecked: result.unchecked };
    } catch (error) {
      preflightRun = { checked: check, blockers: [], error: (error as Error).message };
      warnings.push(`O preflight_check não conseguiu julgar ${path.basename(check)} (${preflightRun.error}); os bloqueadores de estrutura e volume não foram conferidos.`);
    }
    if (delivered && input.openInStudio && after === before) {
      try { delivered.opened = (await deps.openInStudio(delivered.path)) as Record<string, unknown>; } catch (error) {
        delivered.open_error = (error as Error).message;
        warnings.push(`Não foi possível abrir o projeto no Bambu Studio (${delivered.open_error}); abra ${delivered.path} você mesmo.`);
      }
    }

    return buildReport({
      input, tuning: deps.tuning, printerPreset: deps.printerPreset, declared, source: { path: source, sha256_before: before, sha256_after: after }, p0, base,
      baseline, baselineError, rounds, items, stop, slices: { loop: loopSlices, retarget: retargetSlices, max: input.maxSlices },
      minutes: Math.round(((now() - started) / 60_000) * 100) / 100, best: input.dryRun ? undefined : best, bestWhy, pending, delivered, preflight: preflightRun, mesh, installed, warnings,
    });
  } finally {
    await removeQuietly(work);
  }
}
