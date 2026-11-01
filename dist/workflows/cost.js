import { openProject, asArray, meta } from '../knowledge/facts/settings.js';
export const COST_TOOLS = [{ name: 'estimate_print_cost', description: 'Estimate material and optional energy costs from a sliced 3MF. Prices are supplied by the user; missing consumption remains unknown. Copies multiply the whole project, not an inferred part count.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
                path: { description: 'Path to a sliced 3MF containing consumption estimates.', type: 'string', minLength: 1 }, material_price_per_kg: { description: 'Default filament price per kilogram in the chosen currency.', type: 'number', minimum: 0, maximum: 1e9 },
                filament_prices: { description: 'Per-slot prices; missing slots use the default price if supplied.', type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['slot', 'price_per_kg'], properties: { slot: { type: 'integer', minimum: 1, maximum: 64 }, price_per_kg: { type: 'number', minimum: 0, maximum: 1e9 } } } },
                copies: { description: 'Number of copies of the entire project.', type: 'integer', minimum: 1, maximum: 100000 }, parts_per_project: { description: 'Declared number of parts in one project; enables allocated per-part costs.', type: 'integer', minimum: 1, maximum: 100000 },
                currency: { description: 'Three-letter currency code for all supplied prices.', type: 'string', pattern: '^[A-Z]{3}$', default: 'BRL' }, power_w: { description: 'Assumed average printer power in watts; requires the electricity rate.', type: 'number', minimum: 0, maximum: 100000 }, electricity_price_per_kwh: { description: 'Electricity price per kWh; requires average power in watts.', type: 'number', minimum: 0, maximum: 1e9 },
            } } }];
const measurement = (value) => {
    if (value === undefined || value === null || typeof value === 'boolean' || String(value).trim() === '')
        return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 1e12 ? n : null;
};
function number(a, key, max, integer = false) {
    const v = a[key];
    if (v === undefined)
        return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < (integer ? 1 : 0) || v > max || (integer && !Number.isInteger(v)))
        throw Error(`${key} must be a finite ${integer ? 'positive integer' : 'non-negative number'} <= ${max}`);
    return v;
}
const sum = (values) => values.length && values.every(v => v !== null) ? values.reduce((a, b) => a + b, 0) : null;
export async function estimatePrintCost(args) {
    if (typeof args.path !== 'string' || !args.path.toLowerCase().endsWith('.3mf'))
        throw Error('path must be a sliced .3mf file');
    const price = number(args, 'material_price_per_kg', 1e9), copies = number(args, 'copies', 100000, true) ?? 1, parts = number(args, 'parts_per_project', 100000, true);
    const watts = number(args, 'power_w', 100000), electricity = number(args, 'electricity_price_per_kwh', 1e9);
    if ((watts === undefined) !== (electricity === undefined))
        throw Error('power_w and electricity_price_per_kwh must be supplied together');
    const currency = args.currency ?? 'BRL';
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
        throw Error('currency must be three uppercase letters');
    const prices = new Map();
    if (args.filament_prices !== undefined) {
        if (!Array.isArray(args.filament_prices) || !args.filament_prices.length || args.filament_prices.length > 64)
            throw Error('filament_prices must contain 1..64 slot prices');
        for (const row of args.filament_prices) {
            if (!row || typeof row !== 'object')
                throw Error('invalid filament price');
            const slot = number(row, 'slot', 64, true), rate = number(row, 'price_per_kg', 1e9);
            if (slot === undefined || rate === undefined || prices.has(slot))
                throw Error('filament price requires a unique slot and price_per_kg');
            prices.set(slot, rate);
        }
    }
    if (price === undefined && !prices.size)
        throw Error('Supply material_price_per_kg or filament_prices');
    const opened = await openProject(args.path);
    const unknown = [];
    const seen = new Set();
    const plates = asArray(opened.sliceInfo?.plate).map((plate) => {
        const index = measurement(meta(plate, 'index'));
        if (index === null || !Number.isInteger(index) || index < 1 || seen.has(index))
            throw Error('Slice metadata has invalid or duplicate plate indices');
        seen.add(index);
        const time = measurement(meta(plate, 'prediction'));
        const filaments = asArray(plate.filament).map((f) => ({ slot: measurement(f.id), used_g: measurement(f.used_g) }));
        const weight = measurement(meta(plate, 'weight')) ?? sum(filaments.map(f => f.used_g));
        let material = null;
        if (prices.size) {
            const usedSlots = new Set();
            material = sum(filaments.map(f => {
                if (f.slot === null || !Number.isInteger(f.slot) || f.slot < 1 || usedSlots.has(f.slot) || f.used_g === null)
                    return null;
                usedSlots.add(f.slot);
                const rate = prices.get(f.slot) ?? price;
                return rate === undefined ? null : f.used_g * rate / 1000;
            }));
        }
        else if (price !== undefined && weight !== null)
            material = weight * price / 1000;
        const energy = watts === undefined ? 0 : time === null ? null : time / 3600 * watts / 1000 * electricity;
        if (material === null)
            unknown.push(`plate ${index}: missing material weight, slot identity or price`);
        if (time === null)
            unknown.push(`plate ${index}: missing slicer time estimate`);
        return { plate_index: index - 1, time_s: time, weight_g: weight, filaments, material_cost: material, energy_cost: energy, total_cost: material === null || energy === null ? null : material + energy };
    });
    const knownSubset = { time_s: sum(plates.map(p => p.time_s)), weight_g: sum(plates.map(p => p.weight_g)), material_cost: sum(plates.map(p => p.material_cost)), energy_cost: sum(plates.map(p => p.energy_cost)), total_cost: sum(plates.map(p => p.total_cost)) };
    const declared = opened.modelSettings === undefined ? null : asArray(opened.modelSettings.plate)
        .filter((plate) => asArray(plate.model_instance).length > 0)
        .map((plate) => measurement(meta(plate, 'plater_id')));
    const expected = declared !== null && declared.every((v) => v !== null && Number.isInteger(v) && v > 0) && new Set(declared).size === declared.length ? declared : null;
    const coverage = { status: expected === null ? 'unknown' : expected.every(v => seen.has(v)) && [...seen].every(v => expected.includes(v)) ? 'complete' : 'partial', expected_plate_indices: expected?.map(v => v - 1) ?? null, recorded_plate_indices: [...seen].map(v => v - 1) };
    if (expected === null)
        unknown.push('Project plate membership is unavailable; whole-project coverage is unknown');
    else {
        for (const index of expected)
            if (!seen.has(index)) {
                unknown.push(`plate ${index}: no slice consumption metadata`);
                plates.push({ plate_index: index - 1, time_s: null, weight_g: null, filaments: [], material_cost: null, energy_cost: watts === undefined ? 0 : null, total_cost: null });
            }
        if ([...seen].some(v => !expected.includes(v)))
            unknown.push('Slice metadata contains a plate not declared as populated in the saved project');
    }
    plates.sort((a, b) => a.plate_index - b.plate_index);
    if (!plates.length)
        unknown.push('No sliced plates found; slice the project before estimating costs');
    const total = { time_s: sum(plates.map(p => p.time_s)), weight_g: sum(plates.map(p => p.weight_g)), material_cost: sum(plates.map(p => p.material_cost)), energy_cost: sum(plates.map(p => p.energy_cost)), total_cost: sum(plates.map(p => p.total_cost)) };
    if (coverage.status !== 'complete')
        for (const key of Object.keys(total))
            total[key] = null;
    const multiply = (factor) => Object.fromEntries(Object.entries(total).map(([k, v]) => [k, v === null ? null : v * factor]));
    return { currency, estimated: true, copies, parts_per_project: parts ?? null, plates, coverage, known_sliced_subset: knownSubset, per_project: total, total_for_copies: multiply(copies), per_part: parts === undefined ? null : multiply(1 / parts), unknown,
        assumptions: { energy_included: watts !== undefined, power_w: watts ?? null, electricity_price_per_kwh: electricity ?? null, material_price_per_kg: price ?? null, filament_prices: [...prices].map(([slot, price_per_kg]) => ({ slot, price_per_kg })), excludes: ['labor', 'machine depreciation', 'failed prints', 'packaging'], notes: ['Time and consumption are slicer estimates, not observed printing.', 'Recorded weight may not include all purge or tower waste.', 'parts_per_project is declared by the caller; no part count is inferred.'] } };
}
