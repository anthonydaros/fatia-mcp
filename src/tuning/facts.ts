// The fact collector the loop calls every round: everything one round knows, as the flat map the engine takes, plus the names the engine can never get
// on this input (they go to TuningOptions.unavailable, so they come back blind and do not hold `done` back) and the evidence behind each fact.
//
// Rules (the engine's own): facts are NOT carried between rounds. A round's gcode.*, plate.* and slicer.* come only from the scan and the slice result
// passed in THIS call; without them (round 0, pre-slice) there are none, even if the opened project is itself a sliced 3MF. settings.* are left to the
// engine, which builds them from its base (a second copy from another source would override it). The rest describe the base project and may be
// recomputed each round: printer.*, filament.*, project.*, studio.* from the existing providers (src/knowledge/facts), mesh.* from the mesh analysis, object.* declared.
import { settingsProvider } from "../knowledge/facts/settings.js";
import { structureProvider } from "../knowledge/facts/structure.js";
import { getTuning } from "./loader.js";
import { normalizeModel } from "../safety/limits.js";
import type { FactContext, FactProvider, Facts, ProjectFiles } from "../knowledge/types.js";
import type { GcodeScan, ScanEvidence, ScanValue } from "./gcode-scan.js";
import type { MeshEvidence, MeshFacts } from "./mesh-facts.js";
import { DECLARED_FACTS, factsRead, parsePartContext, partContextFacts, type PartContext } from "./part-context.js";
import { sliceFacts, type SliceArtifacts } from "./slice-facts.js";
import type { Settings, TuningAction } from "./types.js";

export type Provenance = "project" | "mesh" | "slice" | "gcode" | "declared" | "extra" | "unavailable";
export interface FactEvidence extends ScanEvidence {
  provenance: Provenance;
  /** A prediction from geometry or a guide rule, not a measurement of the part or of a slice. */
  predictive?: boolean;
}
/** Facts from an analyzer the caller ran itself (e.g. the 3MF structure facts): the collector merges them and stops calling them unavailable. */
export interface ExtraFacts { facts: Record<string, ScanValue>; evidence?: Record<string, ScanEvidence>; blind?: string[] }

export interface CollectInput {
  /** The opened base project (openProject); absent for an STL. */
  project?: ProjectFiles;
  /** 0-based. */
  plateIndex?: number;
  /** The bambu_model, e.g. "x2d". */
  targetModel: string;
  /** The engine's base settings (after the retarget); the project's own are used when absent. printer.*, filament.* and project.filament_types read it. */
  settingsBase?: Settings;
  /** This round's G-code scan; absent before the first slice. */
  gcode?: GcodeScan;
  /** This round's slice artifacts (the plate index is the call's). */
  slice?: Omit<SliceArtifacts, "plateIndex" | "gcode">;
  /** The mesh analysis of the base project (computed once). */
  mesh?: MeshFacts;
  /** Declared part facts (validated again here). */
  declared?: PartContext;
  extra?: ExtraFacts;
  /** The facts to collect; default: every fact the shipped tuning actions read. */
  wanted?: Iterable<string>;
  /** Used for the default `wanted`; default: the shipped tuning actions. */
  actions?: readonly TuningAction[];
  installedStudio?: () => Promise<string | null>;
  /** Label of the project for the evidence map. */
  source?: string;
}
export interface Collected {
  facts: Facts;
  /** Exact names the engine can never get on this input; pass as TuningOptions.unavailable. */
  unavailable: string[];
  evidence: Record<string, FactEvidence>;
}

const ALWAYS = ["printer.model", "studio.version"]; // the engine reads both outside the actions' conditions
const POST_SLICE = /^(gcode|plate|slicer)\./;
/** project.* facts that describe the ORIGINAL project, even after the retarget changed its printer. */
const FROM_ORIGINAL = new Set(["project.source_printer", "project.printer_changed"]);
const FROM_SETTINGS_ONLY = /^(printer|filament)\./; // the facts the settings base alone can give, with no project files
const PROVIDERS: readonly FactProvider[] = [settingsProvider, structureProvider];
const refuseMeshInfo = async () => { throw new Error("mesh facts come from the mesh analysis, not from the box provider"); };

export async function collectFacts(input: CollectInput): Promise<Collected> {
  const plateIndex = input.plateIndex ?? 0;
  const src = input.source ?? "project";
  const wanted = new Set(input.wanted ?? [...(input.actions ?? getTuning().actions)].flatMap(a => [...factsRead(a)]));
  for (const a of ALWAYS) wanted.add(a);
  const facts: Facts = {};
  const evidence: Record<string, FactEvidence> = {};
  const why: Record<string, string> = {}; // reasons for names that stay unavailable
  const put = (name: string, value: Facts[string], e: FactEvidence) => { facts[name] = value; evidence[name] = e; };
  const ev = (provenance: Provenance, method: string, notes = "", approx = false): FactEvidence => ({ provenance, source: src, method, approx, notes });

  // 1. printer.*, filament.*, project.*, studio.* from the existing providers. settings.* stay with the engine; box facts come from the mesh analysis.
  const model = normalizeModel(input.targetModel);
  if (!model) throw new Error(`collectFacts: unknown target model "${input.targetModel}".`);
  const project = input.project;
  // An STL has no project files, but the settings base still tells printer.* and filament.* (the nozzles): the provider gets a project that holds only that.
  const based: ProjectFiles | undefined = project ? { ...project, config: input.settingsBase ?? project.config } : input.settingsBase && { names: [], config: input.settingsBase };
  for (const provider of PROVIDERS) {
    if (provider.needs.includes("3mf") && !based) continue;
    for (const view of ["original", "base"] as const) {
      const names = [...wanted].filter(n => provider.provides(n) && !/^(settings|mesh|object)\./.test(n) && (project || FROM_SETTINGS_ONLY.test(n)) && FROM_ORIGINAL.has(n) === (view === "original"));
      if (!names.length) continue;
      const ctx: FactContext = {
        filePath: "", kind: project ? "3mf" : "mesh", meshInfo: refuseMeshInfo, project: view === "original" ? project : based, plateIndex,
        targetPrinter: model, installedStudio: input.installedStudio ?? (async () => null),
      };
      const got = await provider.collect(ctx, names);
      for (const [name, value] of Object.entries(got)) {
        if (value !== undefined) put(name, value, ev("project", name.startsWith("project.") ? "read from the 3MF files" : "read from the base project settings", view === "base" && input.settingsBase ? "from the engine's base settings" : ""));
      }
    }
  }

  // filament.profile_name is free (spec appendix A) but no provider derives it: filament_settings_id of the base settings, one name per filament.
  const profile = (input.settingsBase ?? project?.config)?.filament_settings_id;
  if (wanted.has("filament.profile_name") && (typeof profile === "string" || (Array.isArray(profile) && profile.every(n => typeof n === "string"))))
    put("filament.profile_name", profile as string | string[], ev("project", "filament_settings_id of the base settings"));

  // 2. mesh.* of the base project.
  if (input.mesh) {
    for (const [name, value] of Object.entries(input.mesh.facts)) {
      const e = input.mesh.evidence[name] as MeshEvidence | undefined;
      put(name, value, { provenance: "mesh", source: e?.source ?? src, method: e?.method ?? "mesh analysis", approx: e?.approx ?? false, notes: e?.notes ?? "", ...(e?.predictive ? { predictive: true } : {}) });
    }
    for (const name of input.mesh.blind) why[name] = input.mesh.evidence[name]?.notes ?? "not measured by the mesh analysis";
  } else for (const n of wanted) if (n.startsWith("mesh.")) why[n] = "no mesh analysis was given";

  // 3. This round's measurements only: slice artifacts and the G-code scan.
  const postSlice = !!(input.gcode || input.slice);
  if (postSlice) {
    const s = sliceFacts({ plateIndex, ...input.slice, gcode: input.gcode, source: input.source });
    for (const [name, value] of Object.entries(s.facts)) {
      const e = s.evidence[name];
      put(name, value, { provenance: name === "plate.tool_changes" && input.gcode?.facts[name] === value ? "gcode" : "slice", ...e });
    }
    for (const name of s.blind) why[name] = s.evidence[name]?.notes ?? "not measured by the slice result";
  }
  if (input.gcode) {
    for (const [name, value] of Object.entries(input.gcode.facts)) {
      if (name.startsWith("plate.")) continue; // sliceFacts decided plate.* (it prefers the G-code count where it can)
      put(name, value, { provenance: "gcode", ...input.gcode.evidence[name] });
    }
    for (const name of input.gcode.blind) why[name] = input.gcode.evidence[name]?.notes ?? "not measured by the G-code scan";
  } else if (input.slice) for (const n of wanted) if (n.startsWith("gcode.")) why[n] = "the slice produced no G-code scan for this round";

  // 4. Other analyzers, then the declarations (a declaration is the user's word and wins over an analyzer's value for the same fact).
  if (input.extra) {
    for (const [name, value] of Object.entries(input.extra.facts)) put(name, value, { provenance: "extra", source: src, method: "analyzer supplied by the caller", approx: false, notes: "", ...input.extra.evidence?.[name] });
    for (const name of input.extra.blind ?? []) why[name] = input.extra.evidence?.[name]?.notes ?? "not measured by the caller's analyzer";
  }
  const declared = partContextFacts(parsePartContext(input.declared));
  for (const [name, value] of Object.entries(declared.facts)) {
    const was = facts[name];
    put(name, value as ScanValue, { provenance: "declared", ...declared.evidence[name], ...(was !== undefined && was !== value ? { notes: `${declared.evidence[name].notes}; overrides the analyzer's value ${JSON.stringify(was)}` } : {}) });
  }

  // 5. What the engine can never get. A declarable fact that was not declared is MISSING, not unavailable: the user can still describe the part.
  // A post-slice fact before the first slice is not unavailable either: it will be measured.
  const unavailable: string[] = [];
  for (const name of wanted) {
    if (name.startsWith("settings.") || facts[name] !== undefined || DECLARED_FACTS.includes(name) || (!postSlice && POST_SLICE.test(name))) continue;
    unavailable.push(name);
    if (!why[name]) why[name] = name.startsWith("project.") || name.startsWith("filament.") || name.startsWith("printer.") ? (project || (input.settingsBase && FROM_SETTINGS_ONLY.test(name)) ? "not derivable from this project's files" : "needs a 3MF project and none was given")
      : name.startsWith("studio.") ? "the Studio version could not be read" : "no source for this fact on this input: its analyzer is not run here";
    evidence[name] ??= { provenance: "unavailable", source: `${src} (not measured)`, method: "not measured", approx: false, notes: why[name] };
  }
  return { facts, unavailable: unavailable.sort(), evidence };
}
