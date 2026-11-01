import path from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { scanGcodeFile, scanPlateGcode } from '../tuning/gcode-scan.js';

export const WASTE_TOOLS: Tool[] = [{ name: 'analyze_print_waste', description: 'Read-only per-plate role/material breakdown from sliced Bambu G-code or 3MF. Unknown or ambiguous purge remains unknown; approximate purge commands never produce precise total waste or percentages. Never slices or controls a printer.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
  path: { type: 'string', minLength: 1, description: 'A .gcode file or sliced .3mf containing Metadata/plate_N.gcode.' }, plate_index: { type: 'integer', minimum: 0, maximum: 999, description: 'Zero-based plate for 3MF; default 0. A standalone G-code only accepts 0.' },
} } }];
const PART_ROLES = new Set(['Outer wall', 'Inner wall', 'Overhang wall', 'Floating vertical shell', 'Top surface', 'Bridge', 'Bottom surface', 'Internal solid infill', 'Gap infill', 'Sparse infill', 'Ironing']);
const WASTE_ROLES = new Set(['Prime tower', 'Skirt', 'Brim', 'Flush']);

export async function analyzePrintWaste(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
  if (typeof args.path !== 'string' || !args.path.trim() || !['.gcode', '.3mf'].includes(path.extname(args.path).toLowerCase())) throw Error('path must name a .gcode or sliced .3mf file');
  const plate = args.plate_index ?? 0;
  if (typeof plate !== 'number' || !Number.isInteger(plate) || plate < 0 || plate > 999) throw Error('plate_index must be 0..999');
  const standalone = path.extname(args.path).toLowerCase() === '.gcode';
  if (standalone && plate !== 0) throw Error('A standalone G-code has no plate selection; use plate_index 0');
  signal?.throwIfAborted();
  const scan = await (standalone ? scanGcodeFile(args.path, { signal, allowPartial: true }) : scanPlateGcode(args.path, plate, { signal, allowPartial: true }));
  signal?.throwIfAborted();
  const unknown: string[] = [];
  const measured = (key: string): number | null => {
    const value = scan.facts[key];
    if (scan.complete && typeof value === 'number' && Number.isFinite(value) && !scan.evidence[key]?.approx) return value;
    unknown.push(`${key}: ${scan.evidence[key]?.notes || 'No complete verified measurement'}`); return null;
  };
  const totalExtruded = measured('gcode.extruded_weight_g'), support = measured('gcode.support_weight_g'), tower = measured('gcode.tower_g'), purge = measured('gcode.purge_g');
  const features = Object.entries(scan.details.features), unidentified = features.filter(([name]) => !PART_ROLES.has(name) && !WASTE_ROLES.has(name) && !name.startsWith('Support'));
  if (unidentified.length) unknown.push(`Unclassified extrusion roles: ${unidentified.map(([name]) => name || '(unlabelled)').join(', ')}`);
  if (!scan.complete) unknown.push('The G-code scan is incomplete: observed features cover only the inspected subset');
  const roleCoverage = scan.complete && totalExtruded !== null && unidentified.length === 0;
  const roleSum = (predicate: (name: string) => boolean) => roleCoverage ? features.filter(([name]) => predicate(name)).reduce((sum, [, value]) => sum + value.weight_g, 0) : null;
  const part = roleSum(name => PART_ROLES.has(name)), brimSkirt = roleSum(name => name === 'Brim' || name === 'Skirt'), flushExtrusion = roleSum(name => name === 'Flush');
  // Flush E and M620.10 L may describe the same material: never combine the two accounting paths.
  const totalWaste = roleCoverage && support !== null && tower !== null && purge === 0 && flushExtrusion === 0 && brimSkirt !== null ? support + tower + brimSkirt : null;
  if (totalWaste === null) unknown.push('Total waste is unknown: purge/flush accounting or role coverage is not fully verified');
  const rawPurge = scan.facts['gcode.purge_g'];
  return { path: path.resolve(args.path), plate_index: plate, complete: scan.complete, coverage: roleCoverage ? 'classified_extrusion_roles' : 'partial_or_unclassified', weights_g: { part, support, prime_tower: tower, brim_skirt: brimSkirt, purge, flush_extrusion: flushExtrusion }, extruded_weight_g: totalExtruded, purge_estimate_g: typeof rawPurge === 'number' ? rawPurge : null, total_waste_g: totalWaste, waste_percentage: totalWaste !== null && totalExtruded !== null && totalExtruded > 0 ? totalWaste / totalExtruded * 100 : null, observed_features: scan.details.features, tool_changes: scan.facts['plate.tool_changes'] ?? null, evidence: scan.evidence, unknown, notes: ['Values are slicer/G-code estimates, not weighed physical material. Roles are mutually exclusive extrusion labels; support includes its interface.', 'Extruded weight includes role-labelled E extrusion. Purge commands are a separate accounting path and are never added to it.', 'M620.10 A0/A1 purge pairing is unvalidated and may count one change twice; approximate purge is excluded from exact totals.', 'A role breakdown is for the selected plate only and does not establish whole-project coverage.'] };
}
