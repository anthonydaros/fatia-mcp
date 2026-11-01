import fs from 'node:fs/promises';
import path from 'node:path';
import { parseString } from 'xml2js';
import { asArray, meta, plateInstances, openProject } from '../knowledge/facts/settings.js';
import { readProjectMesh } from '../tuning/mesh-read.js';
const gapProperty = { type: 'number', minimum: 0, maximum: 2 };
export const GEOMETRY_TOOLS = [
    {
        name: 'extract_3mf_objects',
        description: 'Extract printable build items from one 3MF plate as new STL files in millimetres. Preserves applied world transforms. Indices are zero-based among all build items, including excluded items. STL loses paint, materials, modifiers and slicing settings.',
        inputSchema: { type: 'object', properties: {
                file_path: { type: 'string', description: 'Source 3MF path; never overwritten.' },
                plate_index: { description: 'Zero-based source plate; default is the first plate.', type: 'integer', minimum: 0, maximum: 9999, default: 0 },
                item_indices: { type: 'array', minItems: 1, maxItems: 10000, uniqueItems: true, items: { type: 'integer', minimum: 0 }, description: 'Printable build-item indices on the selected plate. Omit for all printable items.' },
            }, required: ['file_path'], additionalProperties: false },
    },
    {
        name: 'create_fit_test',
        description: 'Generate labelled pin/socket STL coupon pairs and a manifest for physical clearance testing. Gaps are RADIAL mm: socket hole diameter = peg diameter + 2 × gap. Socket is a through-hole; pin is 4 mm taller for handling. Nominal polygonal geometry does not predict printed fit.',
        inputSchema: { type: 'object', properties: {
                gaps_mm: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: gapProperty, description: 'Explicit radial gaps; mutually exclusive with range fields. Default: [0.1, 0.2, 0.3].' },
                gap_start_mm: { ...gapProperty, description: 'First radial gap in millimeters, inclusive.' }, gap_end_mm: { ...gapProperty, description: 'Last radial gap in millimeters, inclusive.' },
                gap_step_mm: { description: 'Positive radial gap increment in millimeters for range generation.', type: 'number', exclusiveMinimum: 0, maximum: 2 },
                peg_diameter_mm: { description: 'Nominal pin diameter in millimeters.', type: 'number', minimum: 2, maximum: 50, default: 6 },
                depth_mm: { description: 'Socket depth in millimeters; the pin is four millimeters taller.', type: 'number', minimum: 2, maximum: 50, default: 10 },
            }, additionalProperties: false },
    },
];
function number(value, fallback, min, max, name) {
    const n = value === undefined ? fallback : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)
        throw new Error(`${name} must be a finite number from ${min} to ${max}`);
    return n;
}
/** Own a fresh directory and only remove files we exclusively created if a delivery fails. */
async function deliver(outputDir, prefix, signal, build) {
    signal?.throwIfAborted();
    await fs.mkdir(outputDir, { recursive: true });
    const dir = await fs.mkdtemp(path.join(path.resolve(outputDir), prefix));
    const owned = [];
    try {
        const write = async (name, data) => {
            signal?.throwIfAborted();
            const file = path.join(dir, name), handle = await fs.open(file, 'wx', 0o600);
            owned.push(file);
            try {
                await handle.writeFile(data);
            }
            finally {
                await handle.close();
            }
            signal?.throwIfAborted();
            return file;
        };
        const result = await build(dir, write);
        signal?.throwIfAborted();
        return result;
    }
    catch (error) {
        await Promise.all(owned.map(file => fs.unlink(file).catch(() => { })));
        await fs.rmdir(dir).catch(() => { }); // do not recursively remove another writer's files
        throw error;
    }
}
function stl(soup) {
    if (!soup.idx.length || soup.idx.length % 3 || soup.pos.some(v => !Number.isFinite(v) || !Number.isFinite(Math.fround(v))))
        throw new Error('Mesh cannot be represented as finite STL coordinates');
    const triangles = soup.idx.length / 3, bytes = Buffer.alloc(84 + triangles * 50);
    bytes.write('Fatia millimetres');
    bytes.writeUInt32LE(triangles, 80);
    for (let i = 0; i < triangles; i++) {
        const offset = 84 + i * 50;
        const ids = Array.from(soup.idx.subarray(i * 3, i * 3 + 3));
        const a = ids[0] * 3, b = ids[1] * 3, c = ids[2] * 3;
        const u = [0, 1, 2].map(j => soup.pos[b + j] - soup.pos[a + j]);
        const v = [0, 1, 2].map(j => soup.pos[c + j] - soup.pos[a + j]);
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const length = Math.hypot(...n);
        n.forEach((value, j) => bytes.writeFloatLE(length ? value / length : 0, offset + j * 4));
        ids.forEach((id, j) => { for (let k = 0; k < 3; k++)
            bytes.writeFloatLE(soup.pos[id * 3 + k], offset + 12 + j * 12 + k * 4); });
    }
    return bytes;
}
export function requireMillimeters(bytes) {
    for (let start = bytes.indexOf(60); start >= 0; start = bytes.indexOf(60, start + 1)) {
        const head = bytes.toString('utf8', start, start + 9);
        const terminator = head.startsWith('<!--') ? '-->' : head.startsWith('<?') ? '?>' : head.startsWith('<![CDATA[') ? ']]>' : undefined;
        if (terminator) {
            const end = bytes.indexOf(terminator, start + 2);
            if (end < 0)
                throw new Error('Malformed 3MF model XML');
            start = end + terminator.length - 1;
            continue;
        }
        let end = start + 1, quote = 0;
        for (; end < bytes.length && end - start <= 65536; end++) {
            const c = bytes[end];
            if (quote) {
                if (c === quote)
                    quote = 0;
            }
            else if (c === 34 || c === 39)
                quote = c;
            else if (c === 62)
                break;
        }
        if (end >= bytes.length || end - start > 65536 || quote)
            throw new Error('Malformed 3MF model root');
        const tag = bytes.toString('utf8', start, end + 1);
        const root = /^<((?:\w+:)?model)(?=\s|\/?>)/.exec(tag)?.[1];
        if (!root)
            throw new Error('Unsupported 3MF model root');
        let attributes, invalid = false;
        parseString(tag + (tag.endsWith('/>') ? '' : `</${root}>`), { async: false, explicitArray: false }, (error, parsed) => {
            invalid = !!error;
            attributes = parsed?.[root]?.$;
        });
        if (invalid)
            throw new Error('Malformed 3MF model root');
        const unit = attributes?.unit;
        if (unit !== undefined && unit !== 'millimeter')
            throw new Error('Only millimeter 3MF units are supported');
        return;
    }
    throw new Error('Missing 3MF model root');
}
export async function extractObjects(args, outputDir, signal) {
    if (typeof args.file_path !== 'string' || !args.file_path.trim() || path.extname(args.file_path).toLowerCase() !== '.3mf')
        throw new Error('file_path must name a 3MF file');
    const plate = number(args.plate_index, 0, 0, 9999, 'plate_index');
    if (!Number.isInteger(plate))
        throw new Error('plate_index must be an integer');
    const selectors = args.item_indices;
    if (selectors !== undefined && (!Array.isArray(selectors) || !selectors.length || selectors.length > 10000 || selectors.some(i => !Number.isSafeInteger(i) || i < 0) || new Set(selectors).size !== selectors.length))
        throw new Error('item_indices must be unique nonnegative integer indices (1–10000 items)');
    signal?.throwIfAborted();
    const project = await openProject(path.resolve(args.file_path));
    // The shared mesh reader uses Studio's millimetres; refuse foreign units rather than silently scaling parts incorrectly.
    for (const name of (project.names ?? []).filter(n => n.toLowerCase().endsWith('.model'))) {
        const bytes = await project.read(name);
        if (bytes)
            requireMillimeters(bytes);
    }
    const plates = asArray(project.modelSettings?.plate);
    const matching = plates.filter(p => Number(meta(p, 'plater_id')) === plate + 1);
    const membership = plateInstances(project.modelSettings, plate);
    const verifiedPlate = matching.length === 1 && membership !== undefined && membership.every(value => /^\d+:\d+$/.test(value) && value.split(':').every(id => Number.isSafeInteger(Number(id))));
    if (plates.length && !verifiedPlate)
        throw new Error(`Plate ${plate} has missing, malformed or ambiguous membership metadata`);
    if (!plates.length && plate !== 0)
        throw new Error(`Cannot select plate ${plate} without plate membership metadata`);
    const mesh = await readProjectMesh(project, plate);
    const selected = selectors === undefined ? mesh.objects : selectors.map(index => {
        const item = mesh.objects.find(o => o.itemIndex === index);
        if (!item)
            throw new Error(`Unknown or non-printable item index ${index} on plate ${plate}`);
        return item;
    });
    signal?.throwIfAborted();
    return deliver(outputDir, 'extract-', signal, async (dir, write) => {
        const objects = [];
        for (const item of selected) {
            const file = await write(`item-${item.itemIndex}.stl`, stl(item.soup));
            objects.push({ item_index: item.itemIndex, object_id: item.objectId, instance: item.instance, name: item.name, file_path: file, triangle_count: item.soup.idx.length / 3 });
        }
        const result = { output_dir: dir, source_path: path.resolve(args.file_path), plate_index: plate, plate_membership: verifiedPlate ? 'verified' : 'unknown', units: 'mm', objects,
            warnings: [...(!verifiedPlate ? ['Plate membership is unknown: no reliable plate metadata; plate 0 denotes all printable build items.'] : []), 'STL preserves geometry and world placement only; paint, materials, modifiers, negative volumes and slicing settings are omitted. Geometry is not repaired.'] };
        const manifest = await write('manifest.json', JSON.stringify(result, null, 2));
        return { ...result, manifest_path: manifest };
    });
}
/** Closed 96-sided cylinder, or annular cylinder with an actual open through-hole. */
function cylinder(radius, height, inner = 0) {
    const segments = 96, pos = [], idx = [];
    for (const z of [0, height])
        for (const r of [radius, inner]) {
            for (let i = 0; i < segments; i++) {
                const angle = i * Math.PI * 2 / segments;
                pos.push(r * Math.cos(angle), r * Math.sin(angle), z);
            }
        }
    const quad = (a, b, c, d) => idx.push(a, b, c, a, c, d);
    for (let i = 0; i < segments; i++) {
        const j = (i + 1) % segments;
        quad(i, j, 2 * segments + j, 2 * segments + i);
        if (inner) {
            quad(segments + j, segments + i, 3 * segments + i, 3 * segments + j);
            quad(i, segments + i, segments + j, j);
            quad(2 * segments + j, 3 * segments + j, 3 * segments + i, 2 * segments + i);
        }
        else {
            idx.push(segments, j, i, 3 * segments, 2 * segments + i, 2 * segments + j);
        }
    }
    return { pos: Float64Array.from(pos), idx: Uint32Array.from(idx) };
}
export async function createFitTest(args, outputDir, signal) {
    const diameter = number(args.peg_diameter_mm, 6, 2, 50, 'peg_diameter_mm');
    const depth = number(args.depth_mm, 10, 2, 50, 'depth_mm');
    const hasRange = ['gap_start_mm', 'gap_end_mm', 'gap_step_mm'].some(k => args[k] !== undefined);
    if (hasRange && args.gaps_mm !== undefined)
        throw new Error('Supply gaps_mm or a complete gap range, not both');
    let gaps;
    if (hasRange) {
        if (['gap_start_mm', 'gap_end_mm', 'gap_step_mm'].some(k => args[k] === undefined))
            throw new Error('A gap range requires gap_start_mm, gap_end_mm and gap_step_mm');
        const start = number(args.gap_start_mm, 0, 0, 2, 'gap_start_mm'), end = number(args.gap_end_mm, 0, start, 2, 'gap_end_mm');
        const step = number(args.gap_step_mm, 0, Number.MIN_VALUE, 2, 'gap_step_mm');
        const count = Math.floor((end - start) / step + 1e-9) + 1;
        if (!Number.isSafeInteger(count) || count > 20)
            throw new Error('A fit test supports at most 20 gaps');
        gaps = Array.from({ length: count }, (_, i) => Number((start + i * step).toFixed(9)));
        if (Math.abs(gaps[gaps.length - 1] - end) > 1e-8)
            throw new Error('Gap range must end on an exact step');
    }
    else {
        if (args.gaps_mm !== undefined && !Array.isArray(args.gaps_mm))
            throw new Error('gaps_mm must be an array');
        gaps = args.gaps_mm ?? [0.1, 0.2, 0.3];
    }
    if (!gaps.length || gaps.length > 20 || new Set(gaps).size !== gaps.length)
        throw new Error('Supply 1–20 unique gaps');
    for (const gap of gaps)
        number(gap, 0, 0, 2, 'gap');
    return deliver(outputDir, 'fit-test-', signal, async (dir, write) => {
        const coupons = [];
        for (const [index, gap] of gaps.entries()) {
            const hole = diameter + 2 * gap;
            const label = `case-${index + 1}-radial-${gap}mm`;
            const pin = await write(`${label}-pin.stl`, stl(cylinder(diameter / 2, depth + 4)));
            const socket = await write(`${label}-socket.stl`, stl(cylinder(hole / 2 + 2, depth, hole / 2)));
            coupons.push({ label, radial_gap_mm: gap, diametral_gap_mm: gap * 2, peg_diameter_mm: diameter, hole_diameter_mm: hole, depth_mm: depth, pin_height_mm: depth + 4, pin_path: pin, socket_path: socket });
        }
        const result = { output_dir: dir, units: 'mm', gap_convention: 'radial', segments: 96, socket_wall_mm: 2, coupons,
            instructions: 'Print matching labelled pin/socket pairs separately, using intended material, orientation and settings, then perform physical fit testing. Radial gap is half the diametral gap. The socket is a through-hole; the pin extends 4 mm for handling. Nominal 96-sided polygon dimensions and printed fit differ; no fit, strength or quality guarantee. Labels are filenames and this manifest, not embossed text.' };
        const manifest = await write('manifest.json', JSON.stringify(result, null, 2));
        return { ...result, manifest_path: manifest };
    });
}
