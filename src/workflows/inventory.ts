import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { estimatePrintCost } from './cost.js';

export const INVENTORY_TOOLS: Tool[] = [{
  name: 'check_filament_availability',
  description: 'Compare sliced-project per-slot consumption against caller-supplied remaining filament grams. Read-only, no printer or stock service connection. Copies multiply the entire project. Sufficiency is an estimate; metadata may omit purge and tower waste. Missing slots or plate consumption remain unknown.',
  inputSchema: {type:'object', additionalProperties:false, required:['path','filaments'], properties:{
    path:{type:'string', minLength:1, description:'Sliced 3MF with per-filament consumption metadata.'},
    filaments:{type:'array', minItems:1, maxItems:64, description:'User-declared stock assignment; each slot must refer to a separate supply, not the same spool counted twice.', items:{type:'object', additionalProperties:false, required:['slot','available_g'], properties:{slot:{type:'integer',minimum:1,maximum:64}, available_g:{type:'number',minimum:0,maximum:1e9}}}},
    copies:{type:'integer',minimum:1,maximum:100000,default:1,description:'Number of copies of the entire project.'},
    safety_margin_percent:{type:'number',minimum:0,maximum:100,default:10,description:'Reserve added to recorded consumption; it cannot guarantee coverage of unrecorded waste.'},
  }},
}];

export async function checkFilamentAvailability(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
  signal?.throwIfAborted();
  const copies = args.copies ?? 1, margin = args.safety_margin_percent ?? 10;
  if (typeof copies !== 'number' || !Number.isInteger(copies) || copies < 1 || copies > 100000) throw Error('copies must be 1..100000');
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0 || margin > 100) throw Error('safety_margin_percent must be finite, 0..100');
  if (!Array.isArray(args.filaments) || !args.filaments.length || args.filaments.length > 64) throw Error('filaments must contain 1..64 slot weights');
  const stock = new Map<number, number>();
  for (const row of args.filaments) {
    if (!row || typeof row !== 'object' || !Number.isInteger(row.slot) || row.slot < 1 || row.slot > 64 || stock.has(row.slot)) throw Error('Each filament requires a unique slot in 1..64');
    if (typeof row.available_g !== 'number' || !Number.isFinite(row.available_g) || row.available_g < 0 || row.available_g > 1e9) throw Error('Filament available_g must be finite, 0..1e9');
    stock.set(row.slot, row.available_g);
  }
  // Reuse the cost reader's safe archive and whole-project plate coverage checks; prices are irrelevant to stock.
  const measured = await estimatePrintCost({path:args.path, material_price_per_kg:0});
  signal?.throwIfAborted();
  const used = new Map<number, number>();
  const unknown: string[] = [];
  let valid = measured.coverage.status === 'complete' && measured.plates.length > 0;
  for (const plate of measured.plates) {
    const seen = new Set<number>();
    let assignedWeight = 0;
    if (!plate.filaments.length) { valid = false; unknown.push(`Plate ${plate.plate_index}: per-slot consumption is missing`); }
    for (const f of plate.filaments) {
      if (!Number.isInteger(f.slot) || f.slot < 1 || f.slot > 64 || f.used_g === null || seen.has(f.slot)) {
        valid = false; unknown.push(`Plate ${plate.plate_index}: invalid slot consumption`); continue;
      }
      seen.add(f.slot);
      assignedWeight += f.used_g;
      used.set(f.slot, (used.get(f.slot) ?? 0) + f.used_g);
    }
    // Studio rounds gram fields independently to hundredths; larger gaps mean consumption is unallocated.
    if (plate.weight_g !== null && Math.abs(assignedWeight - plate.weight_g) > .01 * (plate.filaments.length + 1)) {
      valid = false; unknown.push(`Plate ${plate.plate_index}: total weight disagrees with per-slot consumption`);
    }
  }
  if (measured.coverage.status !== 'complete') unknown.push('Whole-project slice coverage is incomplete or unknown');
  const filaments = [...new Set([...used.keys(), ...stock.keys()])].sort((a,b) => a-b).map(slot => {
    const subset = used.has(slot) ? used.get(slot)! * copies * (1 + margin / 100) : null;
    const available = stock.get(slot) ?? null;
    const required = valid ? subset ?? 0 : null;
    if (available === null) unknown.push(`Slot ${slot}: remaining stock was not supplied`);
    const shortage = required === null || available === null ? null : Math.max(0, required - available);
    return {slot, available_g:available, required_g:required, known_subset_required_g:subset,
      remaining_after_g:required === null || available === null ? null : available-required,
      shortage_g:shortage, status:shortage === null ? 'unknown' : shortage > 0 ? 'insufficient' : 'sufficient_estimate'};
  });
  const status = filaments.some(f => f.status === 'insufficient') ? 'insufficient' : valid && used.size > 0 && filaments.every(f => f.status === 'sufficient_estimate') ? 'sufficient_estimate' : 'unknown';
  return {status, estimated:true, copies, safety_margin_percent:margin, coverage:measured.coverage, filaments, unknown,
    notes:['Inventory and slot assignment are supplied by the caller; material/color compatibility is not verified.', 'Each slot is assumed to have its own supply; do not assign the same physical spool twice.', 'Recorded consumption can omit purge and tower waste. The reserve is a planning assumption, not a guarantee.', 'No stock is reserved or deducted; no printer or external service is contacted.']};
}
