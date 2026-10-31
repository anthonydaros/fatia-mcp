// Tier-1 facts: what a rule can read from a 3MF without slicing it or looking at geometry.
// project_settings.config is read RAW (strings and lists of strings, as Studio wrote them): parse3MF().slicerConfig
// converts numbers, and the rules compare the original text ("15%", "0.2").
import { parseStringPromise } from "xml2js";
import { readSafe3mfArchive } from "../../safety/archive.js";
import { normalizeModel } from "../../safety/limits.js";
import type { FactContext, FactProvider, FactValue, Facts, ProjectFiles, Scalar } from "../types.js";
import { matchVersion } from "../version.js";

const X2D_MINIMUM = ">=2.5.3.60";
const MAX_XML_CHARS = 32 * 2 ** 20; // far above any real metadata file; a bigger one is treated as absent
const STICKY_TYPES = new Set(["PETG", "PA", "TPU", "PCTG", "PPA"]);
export const asArray = (x: unknown): any[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
/** Value of the <metadata key="..." value="..."/> child of an XML node parsed with mergeAttrs. */
export const meta = (node: any, key: string): unknown => asArray(node?.metadata).find(m => m?.key === key)?.value;
/** The printer being targeted, spelled as the project settings spell it ("Bambu Lab X2D"). */
export const targetName = (model: string) => `Bambu Lab ${model.toUpperCase()}`;
const isScalar = (x: unknown): x is Scalar => ["string", "number", "boolean"].includes(typeof x);
const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
const asFact = (v: unknown): FactValue | undefined =>
  Array.isArray(v) ? (v.every(isScalar) ? v : undefined) : isScalar(v) ? v : undefined; // objects and nested lists are not facts
const list = (v: unknown): Scalar[] | undefined => { const f = asFact(v); return f === undefined || f === null ? undefined : Array.isArray(f) ? f : [f]; };
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Opens a 3MF through the safe archive reader and parses the three metadata files tier 1 needs. Never throws on their content. */
export async function openProject(filePath: string): Promise<ProjectFiles> {
  // shortcut: the safe loader inflates every entry, plate G-code included, to read three small files; fine under its 256 MiB cap, replace when the G-code tier streams it.
  const { zip } = await readSafe3mfArchive(filePath);
  const read = (name: string) => zip.file(name)?.async("string");
  const xml = async (name: string) => {
    try {
      const raw = await read(name);
      return raw === undefined || raw.length > MAX_XML_CHARS ? undefined : (await parseStringPromise(raw, { explicitArray: false, mergeAttrs: true }))?.config;
    } catch {
      return undefined; // malformed XML counts as absent
    }
  };
  const project: ProjectFiles = {
    sliceInfo: await xml("Metadata/slice_info.config"),
    modelSettings: await xml("Metadata/model_settings.config"),
    names: Object.keys(zip.files),
    read: async (name, maxBytes = Infinity) => (await zip.file(name)?.async("nodebuffer"))?.subarray(0, maxBytes),
  };
  const raw = await read("Metadata/project_settings.config");
  if (raw === undefined) {
    project.configProblem = "3MF sem Metadata/project_settings.config (so geometria): fatie no Studio ou envie o 3MF do projeto";
    return project;
  }
  try {
    const config: unknown = JSON.parse(raw.replace(/^﻿/, ""));
    if (config && typeof config === "object" && !Array.isArray(config)) project.config = config as Record<string, unknown>;
    else project.configProblem = "Metadata/project_settings.config nao e um objeto JSON";
  } catch {
    project.configProblem = "Metadata/project_settings.config ilegivel (JSON invalido)";
  }
  return project;
}

/** "object:instance" of each model_instance on one plate (plater_id is 1-based); undefined when model_settings.config has no such plate. */
export function plateInstances(modelSettings: any, plateIndex: number): string[] | undefined {
  const plate = asArray(modelSettings?.plate).find(p => Number(meta(p, "plater_id")) === plateIndex + 1);
  return plate && asArray(plate.model_instance).map(i => `${meta(i, "object_id")}:${meta(i, "instance_id") ?? 0}`);
}

/** Objects on the plate and the distinct filaments their objects and parts are assigned to. */
function plateUsage(modelSettings: any, plateIndex: number): { objects: number; filaments: number } | undefined {
  const instances = plateInstances(modelSettings, plateIndex);
  if (!instances) return undefined;
  const onPlate = new Set(instances.map(i => i.slice(0, i.lastIndexOf(":"))));
  const filaments = new Set<string>();
  // shortcut: only the filaments assigned to objects and parts; painted colours and support filaments are not seen, so this can undercount.
  for (const object of asArray(modelSettings.object)) {
    if (!onPlate.has(String(object.id))) continue;
    filaments.add(String(meta(object, "extruder") ?? "1"));
    for (const part of asArray(object.part)) {
      const extruder = meta(part, "extruder");
      if (extruder !== undefined && (part.subtype ?? "normal_part") === "normal_part") filaments.add(String(extruder));
    }
  }
  return { objects: instances.length, filaments: filaments.size };
}

/** The Studio that saved the 3MF; anything but a plain dotted version is treated as unknown (the value is third-party text). */
export function savedVersion(project: ProjectFiles): string | undefined {
  const value = asArray(project.sliceInfo?.header?.header_item).find(i => i?.key === "X-BBL-Client-Version")?.value;
  return typeof value === "string" && /^\d{1,5}(\.\d{1,5}){0,3}$/.test(value.trim()) ? value.trim() : undefined;
}

const verdict = (v: ReturnType<typeof matchVersion>): boolean | undefined => (v === "unknown" ? undefined : v === "applies");

type Derive = (ctx: FactContext, project: ProjectFiles, config: Record<string, unknown>) => FactValue | undefined | Promise<FactValue | undefined>;
const DERIVED: Record<string, Derive> = {
  "printer.nozzle_diameter": (_c, _p, config) => list(config.nozzle_diameter),
  "printer.nozzle_count": (_c, _p, config) => list(config.nozzle_diameter)?.length,
  "printer.nozzle_diameters_differ": (_c, _p, config) => { const l = list(config.nozzle_diameter); return l && new Set(l.map(Number)).size > 1; },
  "project.filament_types": (_c, _p, config) => list(config.filament_type),
  // Type and stickiness are compared at the same filament index, as the fact is declared.
  "filament.low_stickiness_on_sticky_type_count": (_c, _p, config) => {
    const [types, stickiness] = [list(config.filament_type), list(config.filament_metal_stickiness)];
    return types && stickiness ? types.filter((t, i) => STICKY_TYPES.has(String(t)) && ["None", "Low"].includes(String(stickiness[i]))).length : undefined;
  },
  "project.source_printer": (_c, _p, config) => text(config.printer_model),
  "project.target_printer": ctx => targetName(ctx.targetPrinter),
  "project.printer_changed": (ctx, _p, config) => {
    const source = normalizeModel(config.printer_model);
    return source === undefined ? undefined : source !== ctx.targetPrinter;
  },
  "project.object_count": (ctx, project) => plateUsage(project.modelSettings, ctx.plateIndex)?.objects,
  "project.filament_count": (ctx, project) => plateUsage(project.modelSettings, ctx.plateIndex)?.filaments,
  "studio.version": (_c, project) => savedVersion(project),
  "studio.installed_version": async ctx => (await ctx.installedStudio()) ?? undefined,
  // The Studio that will slice decides; the one that saved the file is the fallback (rule text: "se a ferramenta souber, a instalada").
  "studio.meets_x2d_minimum": async (ctx, project) => {
    const version = (await ctx.installedStudio()) ?? savedVersion(project);
    return version ? verdict(matchVersion(X2D_MINIMUM, version)) : undefined;
  },
};

export const settingsProvider: FactProvider = {
  tier: 1,
  needs: ["3mf"],
  provides: name => name.startsWith("settings.") || has(DERIVED, name),
  async collect(ctx, wanted) {
    const facts: Facts = {};
    const project = ctx.project;
    if (!project) return facts;
    const config = project.config ?? {};
    for (const name of wanted) {
      // has(): a key like "__proto__" or "constructor" in a hostile 3MF must not resolve to an inherited property.
      const key = name.slice("settings.".length);
      const value = name.startsWith("settings.")
        ? has(config, key) ? asFact(config[key]) : undefined
        : has(DERIVED, name) ? await DERIVED[name](ctx, project, config) : undefined;
      if (value !== undefined) facts[name] = value;
    }
    return facts;
  },
};
