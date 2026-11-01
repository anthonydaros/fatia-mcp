import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { openProject, asArray, meta, plateInstances } from '../knowledge/facts/settings.js';
import { readProjectMesh, readStlMesh } from '../tuning/mesh-read.js';
import { requireMillimeters } from './geometry.js';
export const MESH_HEALTH_TOOLS = [{ name: 'analyze_mesh_health', description: 'Read-only bounded topology checks for printable STL/3MF geometry: open/non-manifold edges, winding, degenerates, duplicate faces and edge-connected components. Exact-coordinate welding; no repair, self-intersection test or physical printability guarantee.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
                path: { type: 'string', minLength: 1, description: 'STL or 3MF to inspect; STL coordinates are assumed millimeters.' }, plate_index: { type: 'integer', minimum: 0, maximum: 999, description: 'Zero-based 3MF plate; default 0.' }, max_triangles: { type: 'integer', minimum: 1, maximum: 250000, default: 100000, description: 'Work/memory cap; exceeding it errors rather than returning a partial healthy result.' },
            } } }];
async function topology(soup, signal) {
    const { pos, idx } = soup, count = idx.length / 3;
    const vertices = new Map(), ids = new Uint32Array(pos.length / 3);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
        if (i % 12288 === 0) {
            await setImmediate();
            signal?.throwIfAborted();
        }
        for (let axis = 0; axis < 3; axis++) {
            const value = pos[i + axis];
            if (!Number.isFinite(value))
                throw Error('Mesh has non-finite world coordinates');
            min[axis] = Math.min(min[axis], value);
            max[axis] = Math.max(max[axis], value);
        }
        const key = `${pos[i]},${pos[i + 1]},${pos[i + 2]}`;
        if (!vertices.has(key))
            vertices.set(key, vertices.size);
        ids[i / 3] = vertices.get(key);
    }
    const parent = Uint32Array.from({ length: count }, (_, i) => i), rank = new Uint8Array(count);
    const find = (i) => { while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
    } return i; };
    const union = (a, b) => { a = find(a); b = find(b); if (a === b)
        return; if (rank[a] < rank[b])
        parent[a] = b;
    else {
        parent[b] = a;
        if (rank[a] === rank[b])
            rank[a]++;
    } };
    const edges = new Map(), faces = new Set(), valid = [];
    let degenerate = 0, duplicates = 0, signedVolume = 0;
    const origin = [pos[idx[0] * 3], pos[idx[0] * 3 + 1], pos[idx[0] * 3 + 2]];
    for (let t = 0; t < count; t++) {
        if (t % 4096 === 0) {
            await setImmediate();
            signal?.throwIfAborted();
        }
        const corners = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]], v = corners.map(i => ids[i]);
        const a = corners[0] * 3, b = corners[1] * 3, c = corners[2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        if (!Number.isFinite(area2))
            throw Error('Mesh geometry exceeds finite analysis range');
        if (area2 === 0 || new Set(v).size < 3) {
            degenerate++;
            continue;
        }
        valid.push(t);
        const face = [...v].sort((a, b) => a - b).join(',');
        if (faces.has(face))
            duplicates++;
        else
            faces.add(face);
        for (let j = 0; j < 3; j++) {
            const x = v[j], y = v[(j + 1) % 3], key = x < y ? `${x}:${y}` : `${y}:${x}`;
            const edge = edges.get(key), direction = x < y ? 1 : -1;
            if (edge) {
                edge.count++;
                edge.direction += direction;
                union(t, edge.first);
            }
            else
                edges.set(key, { count: 1, direction, first: t });
        }
        const ax = pos[a] - origin[0], ay = pos[a + 1] - origin[1], az = pos[a + 2] - origin[2];
        const bx = pos[b] - origin[0], by = pos[b + 1] - origin[1], bz = pos[b + 2] - origin[2];
        const cx = pos[c] - origin[0], cy = pos[c + 1] - origin[1], cz = pos[c + 2] - origin[2];
        signedVolume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    }
    let boundary = 0, nonmanifold = 0, winding = 0;
    for (const edge of edges.values()) {
        if (edge.count === 1)
            boundary++;
        if (edge.count > 2)
            nonmanifold++;
        if (edge.count === 2 && edge.direction !== 0)
            winding++;
    }
    const closed = valid.length > 0 && boundary === 0 && nonmanifold === 0 && degenerate === 0 && duplicates === 0;
    return { triangle_count: count, unique_vertices: vertices.size, unique_edges: edges.size, boundary_edges: boundary, non_manifold_edges: nonmanifold, inconsistent_winding_edges: winding, degenerate_faces: degenerate, duplicate_faces: duplicates, connected_components: new Set(valid.map(find)).size, edge_closed: closed, consistently_wound: winding === 0, bounds_mm: { min, max }, signed_volume_mm3: closed && winding === 0 && Number.isFinite(signedVolume) ? signedVolume : null };
}
export async function analyzeMeshHealth(args, signal) {
    if (typeof args.path !== 'string' || !args.path.trim() || !['.stl', '.3mf'].includes(path.extname(args.path).toLowerCase()))
        throw Error('path must name an STL or 3MF');
    const plate = args.plate_index ?? 0, cap = args.max_triangles ?? 100000;
    if (typeof plate !== 'number' || !Number.isInteger(plate) || plate < 0 || plate > 999)
        throw Error('plate_index must be 0..999');
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > 250000)
        throw Error('max_triangles must be 1..250000');
    signal?.throwIfAborted();
    let mesh, membership = 'not_applicable';
    if (path.extname(args.path).toLowerCase() === '.stl') {
        if (plate !== 0)
            throw Error('STL has no plate membership; only plate_index 0 is supported');
        mesh = await readStlMesh(args.path, cap);
    }
    else {
        const project = await openProject(args.path);
        for (const name of (project.names ?? []).filter(n => n.toLowerCase().endsWith('.model'))) {
            const bytes = await project.read(name);
            if (bytes)
                requireMillimeters(bytes);
        }
        const plates = asArray(project.modelSettings?.plate), matching = plates.filter(p => Number(meta(p, 'plater_id')) === plate + 1), members = plateInstances(project.modelSettings, plate);
        const verified = matching.length === 1 && members !== undefined && members.every(value => /^\d+:\d+$/.test(value) && value.split(':').every(id => Number.isSafeInteger(Number(id))));
        if (plates.length && !verified)
            throw Error('Plate membership is missing, malformed or ambiguous');
        if (!plates.length && plate !== 0)
            throw Error('Cannot select another plate without plate membership metadata');
        membership = verified ? 'verified' : 'unknown';
        mesh = await readProjectMesh(project, plate, cap);
    }
    const objects = [];
    for (const item of mesh.objects)
        objects.push({ name: item.name, item_index: item.itemIndex ?? 0, ...await topology(item.soup, signal) });
    signal?.throwIfAborted();
    return { path: path.resolve(args.path), plate_index: plate, plate_membership: membership, units: 'mm', max_triangles: cap, objects, self_intersections: 'not_checked', notes: ['Read-only: no geometry was repaired or changed.', 'Vertices are welded only when coordinates match exactly. Degenerate means zero geometric area, not an application-specific thin-feature threshold.', 'Components are joined by shared edges. Closed edges do not prove a manifold vertex neighborhood or absence of intersecting/overlapping shells.', 'Signed volume is a topological estimate for closed, consistently wound faces only; self-intersections and shell nesting are not validated.', 'The shared reader may reverse an entire mesh to make signed volume positive; this does not repair inconsistent adjacent faces.', ...(membership === 'unknown' ? ['Plate membership is unknown: plate 0 denotes all printable build items.'] : [])] };
}
