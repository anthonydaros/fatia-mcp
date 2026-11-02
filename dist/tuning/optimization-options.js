import { parseProcessSettings, PROCESS_SETTING_PROPERTIES } from '../workflows/settings-registry.js';
const limits = { min_wall_loops: [1, 100, true], min_infill_density: [0, 100], min_top_shell_layers: [0, 100, true], min_bottom_shell_layers: [0, 100, true], max_layer_height: [.05, .6], max_outer_wall_speed: [0, 1000], max_outer_wall_acceleration: [0, 100000] };
export const OPTIMIZATION_SCHEMA = { type: 'object', additionalProperties: false, description: 'Opt-in bounded whole-project optimization. Preserves original quality/strength settings unless explicit limits are provided; no physical guarantee.', properties: {
        objective: { type: 'string', enum: ['balanced', 'time', 'material'], default: 'balanced', description: 'Balanced uses equal baseline-normalized time/material weights; others prioritize the selected estimate.' },
        constraints: { type: 'object', additionalProperties: false, description: 'Explicit permitted floors/ceilings. Otherwise preserve each original setting.', properties: Object.fromEntries(Object.entries(limits).map(([k, [minimum, maximum, integer]]) => [k, { type: integer ? 'integer' : 'number', minimum, maximum, description: 'Permitted configuration bound; not a mechanical strength measurement.' }])) },
        candidates: { type: 'array', minItems: 1, maxItems: 6, description: 'Optional named process candidates. Without these, compare authored, adaptivecubic and gyroid at preserved density, or an explicitly allowed lower floor.', items: { type: 'object', additionalProperties: false, required: ['name', 'settings'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, settings: { type: 'object', additionalProperties: false, properties: PROCESS_SETTING_PROPERTIES } } } },
        allow_reorientation: { type: 'boolean', default: false, description: 'Explicit permission to compare rotations of the selected instances.' },
        targets: { type: 'array', maxItems: 20, description: 'Explicit instances allowed for reorientation; other items remain fixed.', items: { type: 'object', additionalProperties: false, required: ['plate_index', 'item_index'], properties: { plate_index: { type: 'integer', minimum: 0, maximum: 999 }, item_index: { type: 'integer', minimum: 0, maximum: 9999 } } } },
    } };
export function parseOptimizationOptions(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('optimization must be an object');
    const a = value;
    for (const k of Object.keys(a))
        if (!Object.keys(OPTIMIZATION_SCHEMA.properties).includes(k))
            throw Error(`Unknown optimization option ${k}`);
    const objective = a.objective ?? 'balanced';
    if (!['balanced', 'time', 'material'].includes(objective))
        throw Error('Invalid optimization objective');
    const c = a.constraints ?? {};
    if (!c || typeof c !== 'object' || Array.isArray(c))
        throw Error('optimization constraints must be an object');
    for (const [k, v] of Object.entries(c)) {
        const range = limits[k];
        if (!range || typeof v !== 'number' || !Number.isFinite(v) || v < range[0] || v > range[1] || (range[2] && !Number.isInteger(v)))
            throw Error(`Invalid optimization constraint ${k}`);
    }
    let candidates;
    if (a.candidates !== undefined) {
        if (!Array.isArray(a.candidates) || !a.candidates.length || a.candidates.length > 6)
            throw Error('optimization candidates must contain 1..6 rows');
        const names = new Set();
        candidates = a.candidates.map(row => {
            if (!row || typeof row !== 'object' || Object.keys(row).some(k => !['name', 'settings'].includes(k)) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 80 || names.has(row.name))
                throw Error('Invalid or duplicated optimization candidate name');
            names.add(row.name);
            parseProcessSettings(row.settings);
            return { name: row.name, settings: row.settings };
        });
    }
    const allow = a.allow_reorientation ?? false;
    if (typeof allow !== 'boolean')
        throw Error('allow_reorientation must be boolean');
    const targets = a.targets ?? [];
    if (!Array.isArray(targets) || targets.length > 20)
        throw Error('optimization targets must contain at most20 instances');
    const selected = new Set();
    for (const t of targets) {
        if (!t || typeof t !== 'object' || Object.keys(t).some(k => !['plate_index', 'item_index'].includes(k)) || !Number.isInteger(t.plate_index) || t.plate_index < 0 || t.plate_index > 999 || !Number.isInteger(t.item_index) || t.item_index < 0 || t.item_index > 9999 || selected.has(`${t.plate_index}:${t.item_index}`))
            throw Error('Invalid optimization target');
        selected.add(`${t.plate_index}:${t.item_index}`);
    }
    if (targets.length && !allow)
        throw Error('Reorientation targets require allow_reorientation:true');
    return { objective: objective, constraints: c, ...(candidates ? { candidates } : {}), allow_reorientation: allow, targets };
}
