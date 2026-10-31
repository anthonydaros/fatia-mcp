/**
 * Keep or drop the settings a 3MF's creator saved in Metadata/project_settings.config.
 *
 * `--load-settings`/`--load-filaments` replace everything the project carries,
 * so slicing with the target printer's defaults silently discards the creator's
 * changes. A plan maps the project onto the target printer: the keys listed in
 * `different_settings_to_system` (layout: [process, filament 1..N, printer]) are
 * overlaid on the matching process preset, and each filament slot is mapped to
 * the target-compatible preset with the same base name.
 */
import fs from 'node:fs/promises';
import JSZip from 'jszip';

type Config = Record<string, unknown>;

export interface ProjectSettingsPlan {
  from: { printer: string; process: string };
  /** Target process preset a "keep" slice starts from. */
  process: string;
  /** Changed process keys, merged onto the target preset (vectors at the target's length). */
  overlay: Config;
  /** Target filament per project slot; unmapped slots hold the printer's default filament. */
  filaments: { slot: number; from: string; to: string }[];
  defaults: { process: string; filament: string };
  /** "key: project value -> printer default", one per difference "keep" would preserve. */
  kept: string[];
  notKept: string[];
}

export type ProjectSettingsMode = 'keep' | 'printer_default';

export interface SettingsReport {
  mode: ProjectSettingsMode;
  kept: string[];
  not_kept: string[];
  filament_map: { slot: number; from: string; to: string }[];
}

export interface ProjectSettingsTarget {
  config: Config;
  /** Machine preset name, e.g. "Bambu Lab X2D 0.4 nozzle". */
  printerPreset: string;
  /** Profile-name code of the target model, e.g. "X2D". */
  modelCode: string;
  /** The flattened machine preset: it names the default process and filament. */
  machine: Config;
  /** Leaf preset by name, or undefined when the tree has none. */
  leaf(kind: 'process' | 'filament', name: string): Config | undefined;
  /** Flattened (inherits/include resolved) process preset. */
  flatProcess(name: string): Promise<Config>;
  /** The caller supplies its own filaments, so slots are neither mapped nor reported. */
  skipFilaments?: boolean;
}

export async function readProjectConfig(filePath: string): Promise<Config | undefined> {
  if (!filePath.toLowerCase().endsWith('.3mf')) return undefined;
  const file = (await JSZip.loadAsync(await fs.readFile(filePath))).file('Metadata/project_settings.config');
  // Geometry-only 3MFs carry no settings.
  if (!file) return undefined;
  const config: unknown = JSON.parse(await file.async('string'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Invalid Metadata/project_settings.config in ${filePath}.`);
  }
  return config as Config;
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
// Bambu Studio rewrites numbers when it saves ("1.0" -> "1", "100" -> "100%"); that is not an edit.
const canon = (value: unknown): unknown => Array.isArray(value) ? value.map(canon)
  : typeof value === 'string' && /^-?\d+(\.\d+)?%?$/.test(value) ? parseFloat(value) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
/** Preset identity rather than print settings: never carried over from a project. */
const PRESET_META = new Set([
  'name', 'type', 'from', 'inherits', 'include', 'instantiation', 'setting_id', 'version', 'description',
  'print_settings_id', 'compatible_printers', 'compatible_printers_condition',
]);
const show = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'unset';
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};
/** "Generic PLA @BBL H2D 0.4 nozzle" -> "Generic PLA": the part shared by every printer's variant. */
const baseName = (name: string) => name.replace(/ @BBL \S+(?: \d+(?:\.\d+)? nozzle)?$/, '');

/** Carry a variant vector (one entry per print_extruder_variant) onto the target printer's variants. */
function mapVariants(project: Config, target: Config, value: unknown[], base: unknown[]) {
  const [pVariant, pId] = [strings(project.print_extruder_variant), strings(project.print_extruder_id)];
  const [tVariant, tId] = [strings(target.print_extruder_variant), strings(target.print_extruder_id)];
  // Not a per-variant vector (or no variants to map): it carries over only at the same length.
  if (pVariant.length === 0 || tVariant.length === 0 || value.length !== pVariant.length || base.length !== tVariant.length) {
    return value.length === base.length ? { values: value, dropped: [] } : undefined;
  }
  const values = [...base];
  const dropped: string[] = [];
  value.forEach((entry, i) => {
    const j = tVariant.findIndex((variant, k) => variant === pVariant[i] && tId[k] === pId[i]);
    if (j < 0) dropped.push(`extruder ${pId[i]} ${pVariant[i]}`); else values[j] = entry;
  });
  return { values, dropped };
}

export async function buildProjectSettingsPlan(t: ProjectSettingsTarget): Promise<ProjectSettingsPlan> {
  const { config, printerPreset, modelCode } = t;
  const nozzle = /(\d+(?:\.\d+)?) nozzle$/.exec(printerPreset)?.[1];
  const compatible = (preset: Config) => !Array.isArray(preset.compatible_printers) ||
    preset.compatible_printers.length === 0 || preset.compatible_printers.includes(printerPreset);
  // The project's own name first: P1S and X1E use the X1C presets. The nozzle-specific name wins
  // where a model has both (X2D: bare = 0.6/0.8, "0.4 nozzle" = 0.4).
  const equivalent = (kind: 'process' | 'filament', name: string) => [
    name, `${baseName(name)} @BBL ${modelCode}`, ...(nozzle ? [`${baseName(name)} @BBL ${modelCode} ${nozzle} nozzle`] : []),
  ].find(candidate => { const preset = t.leaf(kind, candidate); return preset && compatible(preset); });

  const defaults = {
    process: String(t.machine.default_print_profile ?? ''),
    filament: strings(t.machine.default_filament_profile)[0] ?? '',
  };
  const projectProcess = String(config.print_settings_id ?? '');
  const mappedProcess = projectProcess ? equivalent('process', projectProcess) : undefined;
  const process = mappedProcess ?? defaults.process;
  if (!process) throw new Error(`${printerPreset} names no default process preset.`);
  const flat = await t.flatProcess(process);

  // Made for this very printer: the project's process values are trusted whole, not only the keys it lists
  // as changed (Bambu Studio rewrites that list on save, and hand edits never update it).
  const samePrinter = config.printer_settings_id === printerPreset;
  const kept: string[] = [];
  const notKept: string[] = [];
  if (projectProcess && !mappedProcess && !samePrinter) {
    notKept.push(`process preset ${projectProcess}: no ${modelCode} equivalent; using ${process}`);
  } else if (process !== defaults.process) {
    kept.push(`process preset: ${process} -> ${defaults.process}`);
  }

  // [process, filament 1..N, printer]; a project saved without the list cannot say what changed.
  const changed = strings(config.different_settings_to_system);
  const ids = strings(config.filament_settings_id);
  if (changed.length === 0 && !samePrinter) notKept.push('different_settings_to_system is missing; process settings come from the printer preset');
  const overlay: Config = {};
  const keys = samePrinter ? Object.keys(flat).filter(key => !PRESET_META.has(key)) : (changed[0] ?? '').split(';').filter(Boolean);
  for (const key of keys) {
    const value = config[key];
    const base = flat[key];
    let next = value;
    if (value === undefined) {
      if (!samePrinter) notKept.push(`${key}: listed as changed but absent from the project`);
      continue;
    }
    if (Array.isArray(value) && Array.isArray(base)) {
      const mapped = mapVariants(config, flat, value, base);
      if (!mapped) {
        notKept.push(`${key}: ${value.length} values do not fit the ${modelCode} preset's ${base.length}`);
        continue;
      }
      next = mapped.values;
      if (mapped.dropped.length > 0) notKept.push(`${key}: no ${modelCode} equivalent for ${mapped.dropped.join(', ')}`);
    } else if (Array.isArray(value) !== Array.isArray(base) && base !== undefined) {
      notKept.push(`${key}: the ${modelCode} preset stores it differently`);
      continue;
    }
    if (same(next, base)) continue;
    overlay[key] = next;
    kept.push(`${key}: ${show(next)} -> ${show(base)}`);
  }

  const filaments: ProjectSettingsPlan['filaments'] = [];
  if (!t.skipFilaments) {
    ids.forEach((from, i) => {
      const to = equivalent('filament', from);
      filaments.push({ slot: i + 1, from, to: to ?? defaults.filament });
      if (!to && !defaults.filament) throw new Error(`No ${modelCode} equivalent for filament "${from}" and ${printerPreset} names no default filament.`);
      if (!to) notKept.push(`filament ${i + 1} ${from}: no ${modelCode} equivalent compatible with ${printerPreset}; using ${defaults.filament}`);
      else if (to !== defaults.filament) kept.push(`filament ${i + 1}: ${from} -> ${to} (printer default: ${defaults.filament})`);
      if (changed.length === ids.length + 2 && changed[i + 1]) {
        notKept.push(`filament ${i + 1} ${from}: edited ${changed[i + 1].split(';').join(', ')} (filament edits are not carried over)`);
      }
    });
  }
  if (changed.length === ids.length + 2 && changed[changed.length - 1]) {
    notKept.push(`printer: ${changed[changed.length - 1].split(';').join(', ')} (machine settings come from ${printerPreset})`);
  }

  return {
    from: { printer: String(config.printer_settings_id ?? config.printer_model ?? 'unknown printer'), process: projectProcess },
    process, overlay, filaments, defaults, kept, notKept,
  };
}

/** What a slice in the chosen mode kept and dropped, for the tool result. */
export function settingsReport(plan: ProjectSettingsPlan, mode: ProjectSettingsMode): SettingsReport {
  const keep = mode === 'keep';
  return {
    mode,
    kept: keep ? plan.kept : [],
    // Under printer defaults, everything the project would have kept is what was dropped.
    not_kept: keep ? plan.notKept : [...plan.kept, ...plan.notKept],
    filament_map: plan.filaments.map(({ slot, from, to }) => ({ slot, from, to: keep ? to : plan.defaults.filament })),
  };
}
