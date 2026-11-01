import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { readBoundedPrintFile } from '../safety/archive.js';
import { openProject } from '../knowledge/facts/settings.js';
import { writeTunedProject } from '../tuning/project-writer.js';
export const CALIBRATION_TOOLS = [{
        name: 'create_calibration_project',
        description: 'Create separate unsliced Bambu Studio calibration projects and a manifest for explicit flow ratios, fixed nozzle temperatures, or retraction lengths. Uses a compatible single-filament project as the settings baseline; replaces its geometry with closed test coupons. Temperature values require the baseline filament temperature range. Does not slice, run a heater, evaluate a physical result or change a preset.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'kind', 'values'], properties: {
                path: { type: 'string', minLength: 1, description: 'Existing single-filament 3MF whose settings already match the selected machine.' },
                bambu_model: { type: 'string', description: 'Printer model; falls back to BAMBU_MODEL or asks.' },
                kind: { type: 'string', enum: ['flow_ratio', 'temperature', 'retraction'], description: 'Flow ratio uses a flat top-surface coupon; temperature uses a bridge coupon; retraction uses two posts on a shared base.' },
                values: { type: 'array', minItems: 1, maxItems: 12, uniqueItems: true, items: { type: 'number' }, description: 'Explicit candidate values: flow ratio 0.8–1.2; temperature integer Celsius within the baseline filament range and known machine limit; retraction 0–2 mm. No values are guessed.' },
            } },
    }];
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const valuesOf = (config, key) => {
    const raw = config[key];
    const values = typeof raw === 'string' ? [raw] : raw;
    if (!Array.isArray(values) || !values.length || !values.every(v => typeof v === 'string' && v.trim()))
        throw Error(`Baseline setting ${key} is absent or unsupported; save a full Bambu Studio project first`);
    return values;
};
function numericSetting(config, key) {
    const values = valuesOf(config, key).map(Number);
    if (!values.every(Number.isFinite))
        throw Error(`Baseline setting ${key} must contain finite numbers`);
    return values;
}
/** Boundary faces of a small voxel union: posts, base and bridge share vertices instead of intersecting closed boxes. */
function coupon(kind) {
    const xs = kind === 'flow_ratio' ? [0, 20] : [0, 5, 25, 30];
    const ys = kind === 'flow_ratio' ? [0, 20] : [0, 2.5, 7.5, 10];
    const zs = kind === 'flow_ratio' ? [0, 2] : kind === 'temperature' ? [0, 1, 20, 22] : [0, 1, 21];
    const solid = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < xs.length - 1 && j < ys.length - 1 && k < zs.length - 1 &&
        (kind === 'flow_ratio' || k === 0 || (j === 1 && (i === 0 || i === 2 || (kind === 'temperature' && k === 2))));
    const vertices = [], triangles = [], lookup = new Map();
    const vertex = (v) => { const key = v.join(','); let n = lookup.get(key); if (n === undefined) {
        n = vertices.length;
        lookup.set(key, n);
        vertices.push(v);
    } return n; };
    const quad = (points) => { const [a, b, c, d] = points.map(vertex); triangles.push([a, b, c], [a, c, d]); };
    for (let i = 0; i < xs.length - 1; i++)
        for (let j = 0; j < ys.length - 1; j++)
            for (let k = 0; k < zs.length - 1; k++) {
                if (!solid(i, j, k))
                    continue;
                const x = xs[i], X = xs[i + 1], y = ys[j], Y = ys[j + 1], z = zs[k], Z = zs[k + 1];
                if (!solid(i - 1, j, k))
                    quad([[x, y, z], [x, y, Z], [x, Y, Z], [x, Y, z]]);
                if (!solid(i + 1, j, k))
                    quad([[X, y, z], [X, Y, z], [X, Y, Z], [X, y, Z]]);
                if (!solid(i, j - 1, k))
                    quad([[x, y, z], [X, y, z], [X, y, Z], [x, y, Z]]);
                if (!solid(i, j + 1, k))
                    quad([[x, Y, z], [x, Y, Z], [X, Y, Z], [X, Y, z]]);
                if (!solid(i, j, k - 1))
                    quad([[x, y, z], [x, Y, z], [X, Y, z], [X, y, z]]);
                if (!solid(i, j, k + 1))
                    quad([[x, y, Z], [X, y, Z], [X, Y, Z], [x, Y, Z]]);
            }
    return { xml: `<mesh><vertices>${vertices.map(v => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join('')}</vertices><triangles>${triangles.map(t => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('')}</triangles></mesh>`, size: [xs.at(-1), ys.at(-1), zs.at(-1)] };
}
function placement(config, size) {
    const raw = valuesOf(config, 'printable_area');
    const points = raw.map(s => /^(-?\d+(?:\.\d+)?)x(-?\d+(?:\.\d+)?)$/.exec(s));
    if (points.some(p => !p) || points.length !== 4)
        throw Error('Calibration requires an explicit rectangular printable_area');
    const xs = points.map(p => Number(p[1])), ys = points.map(p => Number(p[2]));
    const x = [...new Set(xs)].sort((a, b) => a - b), y = [...new Set(ys)].sort((a, b) => a - b);
    if (x.length !== 2 || y.length !== 2 || new Set(points.map(p => `${p[1]},${p[2]}`)).size !== 4 || x[1] - x[0] < size[0] + 10 || y[1] - y[0] < size[1] + 10)
        throw Error('Calibration coupon does not fit the declared rectangular bed with 5 mm margins');
    const height = numericSetting(config, 'printable_height');
    if (Math.min(...height) < size[2])
        throw Error('Calibration coupon exceeds printable height');
    return [(x[0] + x[1] - size[0]) / 2, (y[0] + y[1] - size[1]) / 2];
}
export async function createCalibrationProject(args, deps) {
    deps.signal?.throwIfAborted();
    if (typeof args.path !== 'string' || !args.path.trim() || !args.path.toLowerCase().endsWith('.3mf'))
        throw Error('path must name a compatible single-filament 3MF');
    if (!['flow_ratio', 'temperature', 'retraction'].includes(args.kind))
        throw Error('Unknown calibration kind');
    const kind = args.kind;
    if (!Array.isArray(args.values) || args.values.length < 1 || args.values.length > 12 || new Set(args.values).size !== args.values.length || !args.values.every(v => typeof v === 'number' && Number.isFinite(v)))
        throw Error('values must contain 1–12 unique finite numbers');
    const values = args.values;
    const before = sha(await readBoundedPrintFile(args.path));
    const source = await openProject(args.path);
    const config = source.config;
    if (!config || config.printer_settings_id !== deps.printerPreset)
        throw Error('Baseline must already match the selected printer; prepare it first');
    if (!Array.isArray(config.filament_settings_id) || config.filament_settings_id.length !== 1 || typeof config.filament_settings_id[0] !== 'string' || !config.filament_settings_id[0].trim())
        throw Error('Calibration requires exactly one declared filament preset');
    const key = kind === 'flow_ratio' ? 'filament_flow_ratio' : kind === 'temperature' ? 'nozzle_temperature' : 'filament_retraction_length';
    valuesOf(config, key);
    if (kind === 'flow_ratio' && values.some(v => v < .8 || v > 1.2))
        throw Error('flow_ratio values must be 0.8–1.2');
    if (kind === 'retraction' && values.some(v => v < 0 || v > 2))
        throw Error('retraction values must be 0–2 mm');
    const warnings = [];
    if (kind === 'temperature') {
        const low = Math.max(...numericSetting(config, 'nozzle_temperature_range_low')), high = Math.min(...numericSetting(config, 'nozzle_temperature_range_high'));
        const machine = deps.maxNozzleTemperature;
        if (machine !== undefined && (!Number.isFinite(machine) || machine <= 0))
            throw Error('Invalid machine nozzle temperature limit');
        const ceiling = Math.min(high, machine ?? Infinity);
        if (low < 0 || high > 500 || low > ceiling || values.some(v => !Number.isInteger(v) || v < low || v > ceiling))
            throw Error(`Temperature candidates must be integer Celsius within declared filament/machine range ${low}–${ceiling}`);
        if (numericSetting(config, 'nozzle_temperature_initial_layer').some(v => v < low || v > ceiling))
            throw Error('Baseline first-layer nozzle temperature is outside the declared filament/machine range');
        if (machine === undefined)
            warnings.push('Installed machine maximum nozzle temperature is unknown; the filament range is declared project data, not hardware verification. Check machine compatibility in Bambu Studio.');
    }
    const shape = coupon(kind), [x, y] = placement(config, shape.size);
    const changes = [
        { key: 'wall_loops', value: '2', scope: 'process' }, { key: 'spiral_mode', value: '0', scope: 'process' },
        { key: 'top_shell_layers', value: '5', scope: 'process' }, { key: 'bottom_shell_layers', value: '3', scope: 'process' },
        { key: 'sparse_infill_density', value: '15%', scope: 'process' }, { key: 'enable_support', value: '0', scope: 'process' }, { key: 'ironing_type', value: 'no ironing', scope: 'process' },
    ];
    const instructions = kind === 'flow_ratio' ? 'Slice and print each flat top-surface coupon separately with the same filament. Compare the top surfaces under the same light; select a measured candidate only after physical review. Values are absolute flow ratios, not percentage modifiers.' : kind === 'temperature' ? 'Each bridge coupon is a separate fixed-temperature candidate after the first layer, whose baseline temperature is retained. This is not a temperature tower and makes no per-layer temperature changes. Slice and print separately; compare bridging, surface and stringing physically.' : 'Print each pair of posts on its shared base separately. Inspect the sliced preview for alternating travels between the posts, then compare stringing physically. Values are filament retraction lengths in mm; no pressure-advance calibration is performed.';
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="application/octet-stream"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
    zip.file('3D/3dmodel.model', `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio</metadata><resources><object id="1" type="model">${shape.xml}</object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${x} ${y} 0"/></build></model>`);
    zip.file('Metadata/project_settings.config', JSON.stringify(config));
    zip.file('Metadata/model_settings.config', '<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="Calibration coupon"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="Calibration coupon"/><metadata key="extruder" value="1"/></part></object><plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Calibration"/><metadata key="locked" value="false"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="1"/></model_instance></plate></config>');
    deps.signal?.throwIfAborted();
    await fs.mkdir(deps.tempDir, { recursive: true });
    await fs.mkdir(deps.outputDir, { recursive: true });
    const work = await fs.mkdtemp(path.join(path.resolve(deps.tempDir), 'calibration-'));
    let delivered;
    try {
        const baseline = path.join(work, 'baseline.3mf');
        await fs.writeFile(baseline, await zip.generateAsync({ type: 'nodebuffer' }), { flag: 'wx' });
        deps.signal?.throwIfAborted();
        delivered = await fs.mkdtemp(path.join(path.resolve(deps.outputDir), 'calibration-'));
        const projects = [];
        for (const [i, value] of values.entries()) {
            deps.signal?.throwIfAborted();
            const label = `${kind}-${i + 1}-${value}`;
            const written = await writeTunedProject({ source: baseline, output: path.join(delivered, `${label}.3mf`), target: { printerPreset: deps.printerPreset }, changes: [...changes, { key, value: String(value), scope: 'filament' }] });
            const check = await openProject(written.path);
            if (!valuesOf(check.config, key).every(v => Number(v) === value))
                throw Error(`Calibration setting ${key} could not be verified in saved project`);
            projects.push({ label, value, setting: key, output_path: written.path, geometry_size_mm: shape.size, settings_verified_in_project: true, sliced: false });
        }
        const after = sha(await readBoundedPrintFile(args.path));
        if (before !== after)
            throw Error('Source changed during calibration generation');
        deps.signal?.throwIfAborted();
        const result = { kind, source_path: path.resolve(args.path), source_sha256: { before, after }, output_dir: delivered, projects, sliced: false, instructions, warnings: [...warnings, 'Review every candidate in Bambu Studio before slicing. Labels are filenames/manifest, not embossed on the coupon. Saved settings are verified; effective sliced settings and physical calibration are not. Baseline custom machine G-code is retained as settings and has not been executed.'] };
        const manifest = path.join(delivered, 'manifest.json');
        await fs.writeFile(manifest, JSON.stringify(result, null, 2), { flag: 'wx' });
        deps.signal?.throwIfAborted();
        return { ...result, manifest_path: manifest };
    }
    catch (error) {
        if (delivered)
            await fs.rm(delivered, { recursive: true, force: true });
        throw error;
    }
    finally {
        await fs.rm(work, { recursive: true, force: true });
    }
}
