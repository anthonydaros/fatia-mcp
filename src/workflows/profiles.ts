import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildNameIndex, flattenByName, detectProfilesRoot } from '../slicer/profile-flatten.js';
import { configuredBambuProfileDirs } from '../stl/stl-manipulator.js';

export const PROFILE_TOOLS: Tool[] = [{
  name: 'list_slicer_profiles',
  description: 'List installed Bambu Studio printer, process and filament presets with dependency and declared compatibility evidence. Does not slice or contact a printer.',
  inputSchema: { type: 'object', properties: {
    machine_preset: { type: 'string', description: 'Exact installed printer preset name to check declared compatibility against.' },
    kind: { description: 'Filter machine, process or filament presets.', type: 'string', enum: ['machine', 'process', 'filament'] },
    query: { type: 'string', description: 'Case-insensitive name substring.' },
    limit: { description: 'Maximum profiles returned in this page, from 1 to 200.', type: 'integer', minimum: 1, maximum: 200, default: 100 },
    offset: { description: 'Zero-based offset into sorted matching profiles.', type: 'integer', minimum: 0, default: 0 },
  }, additionalProperties: false },
}];

export async function listSlicerProfiles(args: Record<string, unknown>, deps: { slicerPath?: string; profilesRoot?: string; userProfileRoots?: string[] } = {}): Promise<Record<string, unknown>> {
  const limit = args.limit ?? 100, offset = args.offset ?? 0;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 200) throw new Error('limit must be an integer from 1 to 200');
  if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error('offset must be a nonnegative safe integer');
  if (args.kind !== undefined && !['machine', 'process', 'filament'].includes(String(args.kind))) throw new Error('Unknown profile kind');
  for (const key of ['query', 'machine_preset']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !String(args[key]).trim())) throw new Error(`${key} must be a nonempty string`);
  const root = deps.profilesRoot ?? detectProfilesRoot(deps.slicerPath);
  if (!(await fs.stat(path.join(root, 'BBL', 'machine')).catch(() => undefined))?.isDirectory()) throw new Error(`Bambu profile installation missing BBL/machine: ${root}`);
  const index = await buildNameIndex(root, 'BBL', deps.userProfileRoots ?? configuredBambuProfileDirs());
  const machine = args.machine_preset as string | undefined;
  let machineError: string | undefined;
  if (machine) {
    try {
      const entry = index.get(machine);
      if (!entry || path.relative(path.join(root, 'BBL', 'machine'), entry.filePath).startsWith('..')) throw new Error('Selected machine preset is not installed in this installation');
      flattenByName(machine, index);
    } catch (error) { machineError = (error as Error).message; }
  }
  const candidates = [...index].filter(([name, {data, filePath}]) => {
    const kind = ['machine', 'process', 'filament'].find(k => filePath.split(path.sep).includes(k));
    return data.instantiation !== 'false' && data.instantiation !== false && kind && (!args.kind || args.kind === kind) && (!args.query || name.toLowerCase().includes(String(args.query).toLowerCase()));
  }).sort(([a], [b]) => a.localeCompare(b));
  const profiles = candidates.slice(Number(offset), Number(offset) + Number(limit)).map(([name, entry]) => {
    const kind = ['machine', 'process', 'filament'].find(k => entry.filePath.split(path.sep).includes(k))!;
    let inheritance: Record<string, unknown>, compatibility: Record<string, unknown>;
    try {
      const flat = flattenByName(name, index);
      inheritance = { status: 'valid', inherits: entry.data.inherits ?? null, include: entry.data.include ?? null };
      const declared = flat.compatible_printers;
      const condition = flat.compatible_printers_condition;
      if (!machine || machineError) compatibility = { status: 'unknown', reason: machineError ?? 'No machine_preset selected' };
      else if (kind === 'machine') compatibility = { status: name === machine ? 'compatible' : 'incompatible', reason: 'Exact installed machine preset identity' };
      else if (condition !== undefined && condition !== '') compatibility = { status: 'unknown', reason: 'Compatibility condition requires Studio evaluation', condition, compatible_printers: declared ?? null };
      else if (Array.isArray(declared) && declared.length > 0 && declared.every(v => typeof v === 'string')) compatibility = { status: declared.includes(machine) ? 'compatible' : 'incompatible', reason: 'Resolved compatible_printers declaration', compatible_printers: declared };
      else compatibility = { status: 'unknown', reason: 'No explicit compatible_printers evidence' };
    } catch (error) {
      inheritance = { status: 'invalid', error: (error as Error).message };
      compatibility = { status: 'unknown', reason: 'Profile dependencies could not be resolved' };
    }
    return { name, kind, path: entry.filePath, inheritance, compatibility };
  });
  return { profiles_root: root, machine_preset: machine ?? null, machine_error: machineError ?? null, profiles, total: candidates.length, offset, limit, malformed_profiles: index.malformed ?? [], evidence: 'Installed profile declarations only; this is not CLI safety validation or a physical compatibility test.' };
}
