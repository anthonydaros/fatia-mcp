import { MeshReadError, readProjectMesh, readStlMesh } from "./mesh-read.js";
export const MESH_CONSTANTS = {
    horizontalDeg: 2, bridgeBandDeg: 2, levelGapMm: 0.05, levelMinAreaMm2: 1, bedToleranceMm: 0.05, flatBottomToleranceMm: 0.02, minRegionSpanMm: 3, minRiseMm: 5,
    defaultThresholdDeg: 30, defaultTopZMm: 0.2, defaultLayerMm: 0.2, gridCellMm: 3, rayEpsMm: 1e-3, maxRays: 200000, maxRayTriangles: 2000000, rayWork: 3e8,
};
/** Facts of this analyzer that the tuning data declares (kb/out/facts.json, kb/tuning/out/tuning-facts.json). */
export const MESH_FACTS = [
    "mesh.size_x_mm", "mesh.size_y_mm", "mesh.height_mm", "mesh.max_object_height_mm", "mesh.bbox_max_dim_mm", "mesh.footprint_area_mm2",
    "mesh.height_to_footprint", "mesh.triangle_count", "mesh.min_z_mm", "mesh.flat_bottom_area_mm2", "mesh.top_surface_levels", "mesh.unsupported_overhang_area_mm2",
];
/** Facts declared on the repo side (not in the shipped knowledge base): evidence only, no tuning action reads them. */
export const REPO_MESH_FACTS = [
    {
        name: "mesh.flat_ceiling_area_mm2",
        description: "Area (mm2) of downward faces within bridgeBandDeg (2 degrees) of horizontal that hang in the air: not on the bed and not resting on lower geometry within support_top_z_distance + one layer. Studio bridges these when they are anchored; a flat cantilever is in this number too.",
        source_of_truth: "Linear pass over the triangles of the plate's normal parts plus a vertical ray down from each face centroid (src/tuning/mesh-facts.ts). Evidence only: it is deliberately not part of mesh.unsupported_overhang_area_mm2.",
        cost: "cheap",
    },
    {
        name: "mesh.flat_bottom_share",
        description: "mesh.flat_bottom_area_mm2 divided by the sum of the XY bounding-box footprints of the objects (0 to 1): how much of the box the part touches the bed with. Not the convex hull.",
        source_of_truth: "Linear pass over the triangles (src/tuning/mesh-facts.ts). Evidence only.",
        cost: "cheap",
    },
];
/** Declared by the spec as mesh analysis but not implemented here (spec 9 step 5: expensive, never measured); they come back blind. */
export const MESH_NOT_IMPLEMENTED = [
    "mesh.min_feature_mm", "mesh.has_slender_protrusions", "mesh.fit_hole_count", "mesh.has_cylindrical_walls", "object.flat_cut_or_pin_base_on_bed",
];
const REPO_NAMES = REPO_MESH_FACTS.map(f => f.name);
const r3 = (v) => Math.round(v * 1000) / 1000;
const rad = (deg) => (deg * Math.PI) / 180;
class WorkExceeded extends Error {
}
const MAX_GRID_ENTRIES = 32000000; // 128 MB of Uint32: the memory the ray grid may take for one object
/** XY grid over the triangles of one object; answers "is there a surface at (x, y) with Z in [lo, hi]?" for vertical rays. */
class RayGrid {
    constructor(soup, cell, limit) {
        this.soup = soup;
        this.limit = limit;
        this.ox = 0;
        this.oy = 0;
        this.nx = 1;
        this.ny = 1;
        this.start = new Uint32Array(2);
        this.items = new Uint32Array(0);
        this.big = [];
        this.work = 0;
        const p = soup.pos;
        let [lx, ly, hx, hy] = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i += 3) {
            lx = Math.min(lx, p[i]);
            hx = Math.max(hx, p[i]);
            ly = Math.min(ly, p[i + 1]);
            hy = Math.max(hy, p[i + 1]);
        }
        this.cell = Math.max(cell, (hx - lx) / 2000, (hy - ly) / 2000); // at most 2001 x 2001 cells, whatever the shape or the coordinates of the box
        [this.ox, this.oy] = [lx, ly];
        this.nx = Math.floor((hx - lx) / this.cell) + 1;
        this.ny = Math.floor((hy - ly) / this.cell) + 1;
        const n = soup.idx.length / 3;
        const range = (t) => {
            const [a, b, c] = [soup.idx[3 * t] * 3, soup.idx[3 * t + 1] * 3, soup.idx[3 * t + 2] * 3];
            const [x0, x1] = [Math.min(p[a], p[b], p[c]), Math.max(p[a], p[b], p[c])];
            const [y0, y1] = [Math.min(p[a + 1], p[b + 1], p[c + 1]), Math.max(p[a + 1], p[b + 1], p[c + 1])];
            if (Math.abs((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])) < 1e-12)
                return undefined; // vertical: no XY area
            return [Math.floor((x0 - this.ox) / this.cell), Math.floor((x1 - this.ox) / this.cell), Math.floor((y0 - this.oy) / this.cell), Math.floor((y1 - this.oy) / this.cell)];
        };
        const counts = new Uint32Array(this.nx * this.ny + 1);
        let entries = 0;
        for (let t = 0; t < n; t++) {
            const r = range(t);
            if (!r)
                continue;
            const cells = (r[1] - r[0] + 1) * (r[3] - r[2] + 1);
            if (cells > 4096) {
                this.big.push(t);
                continue;
            } // a huge triangle is tested for every ray instead of filling thousands of cells
            if ((entries += cells) > MAX_GRID_ENTRIES)
                throw new WorkExceeded();
            for (let j = r[2]; j <= r[3]; j++)
                for (let i = r[0]; i <= r[1]; i++)
                    counts[j * this.nx + i + 1]++;
        }
        for (let i = 1; i < counts.length; i++)
            counts[i] += counts[i - 1];
        this.start = counts;
        this.items = new Uint32Array(counts[counts.length - 1]);
        const fill = counts.slice(0, -1);
        for (let t = 0; t < n; t++) {
            const r = range(t);
            if (!r || (r[1] - r[0] + 1) * (r[3] - r[2] + 1) > 4096)
                continue;
            for (let j = r[2]; j <= r[3]; j++)
                for (let i = r[0]; i <= r[1]; i++)
                    this.items[fill[j * this.nx + i]++] = t;
        }
    }
    hits(t, x, y, lo, hi) {
        const { pos: p, idx } = this.soup;
        const [a, b, c] = [idx[3 * t] * 3, idx[3 * t + 1] * 3, idx[3 * t + 2] * 3];
        const den = (p[b + 1] - p[c + 1]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 1] - p[c + 1]);
        if (Math.abs(den) < 1e-12)
            return false;
        const l1 = ((p[b + 1] - p[c + 1]) * (x - p[c]) + (p[c] - p[b]) * (y - p[c + 1])) / den;
        const l2 = ((p[c + 1] - p[a + 1]) * (x - p[c]) + (p[a] - p[c]) * (y - p[c + 1])) / den;
        const l3 = 1 - l1 - l2;
        const tol = 1e-9;
        if (l1 < -tol || l2 < -tol || l3 < -tol)
            return false;
        const z = l1 * p[a + 2] + l2 * p[b + 2] + l3 * p[c + 2];
        return z >= lo && z <= hi;
    }
    /** A surface of this object (other than triangle `skip`) at (x, y) whose Z lies in [lo, hi]. */
    any(x, y, lo, hi, skip) {
        const i = Math.floor((x - this.ox) / this.cell), j = Math.floor((y - this.oy) / this.cell);
        if (i >= 0 && j >= 0 && i < this.nx && j < this.ny) {
            const [s, e] = [this.start[j * this.nx + i], this.start[j * this.nx + i + 1]];
            this.work += e - s;
            if (this.work > this.limit)
                throw new WorkExceeded(); // before the loop: a ray that hits early must not skip the budget
            for (let k = s; k < e; k++)
                if (this.items[k] !== skip && this.hits(this.items[k], x, y, lo, hi))
                    return true;
        }
        this.work += this.big.length;
        if (this.work > this.limit)
            throw new WorkExceeded();
        for (const t of this.big)
            if (t !== skip && this.hits(t, x, y, lo, hi))
                return true;
        return false;
    }
}
function centroid(soup, t) {
    const { pos: p, idx } = soup;
    const [a, b, c] = [idx[3 * t] * 3, idx[3 * t + 1] * 3, idx[3 * t + 2] * 3];
    return [(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3];
}
function areaOf(soup, t) {
    const { pos: p, idx } = soup;
    const [a, b, c] = [idx[3 * t] * 3, idx[3 * t + 1] * 3, idx[3 * t + 2] * 3];
    const [ux, uy, uz, vx, vy, vz] = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2], p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}
/** Connected sets of faces (a shared welded vertex joins them). */
function components(soup, faces) {
    const weld = new Map();
    const parent = [];
    const find = (v) => { while (parent[v] !== v)
        v = parent[v] = parent[parent[v]]; return v; };
    const ids = (t) => [0, 1, 2].map(k => {
        const o = soup.idx[3 * t + k] * 3;
        const key = `${Math.round(soup.pos[o] * 1000)}_${Math.round(soup.pos[o + 1] * 1000)}_${Math.round(soup.pos[o + 2] * 1000)}`;
        let id = weld.get(key);
        if (id === undefined) {
            id = parent.length;
            parent.push(id);
            weld.set(key, id);
        }
        return id;
    });
    const first = faces.map(t => { const v = ids(t); parent[find(v[1])] = find(v[0]); parent[find(v[2])] = find(v[0]); return v[0]; });
    const groups = new Map();
    faces.forEach((t, k) => { const root = find(first[k]); (groups.get(root) ?? groups.set(root, []).get(root)).push(t); });
    return [...groups.values()];
}
const spanXY = (soup, faces) => {
    let [lx, ly, hx, hy] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const t of faces)
        for (let k = 0; k < 3; k++) {
            const o = soup.idx[3 * t + k] * 3;
            lx = Math.min(lx, soup.pos[o]);
            hx = Math.max(hx, soup.pos[o]);
            ly = Math.min(ly, soup.pos[o + 1]);
            hy = Math.max(hy, soup.pos[o + 1]);
        }
    return Math.max(hx - lx, hy - ly);
};
export function meshFactsFromRead(read, options = {}) {
    const started = Date.now();
    if (!read.objects.length)
        return blindResult("no printable geometry", options.source ?? "mesh", started);
    const c = { ...MESH_CONSTANTS, ...options.constants };
    const src = options.source ?? "mesh";
    const setting = (key) => {
        const v = options.settings?.[key];
        const n = Number(Array.isArray(v) ? v[0] : v);
        return v !== undefined && Number.isFinite(n) ? n : undefined;
    };
    const angle = setting("support_threshold_angle");
    const thresholdDeg = angle !== undefined && angle > 0 && angle <= 90 ? angle : c.defaultThresholdDeg;
    const restMm = (setting("support_top_z_distance") ?? c.defaultTopZMm) + (setting("layer_height") ?? c.defaultLayerMm);
    const settingNote = [
        angle !== undefined && angle > 0 && angle <= 90 ? undefined : `support_threshold_angle ${angle === undefined ? "not given" : `${angle} is not usable (0 is automatic in Studio)`}: ${c.defaultThresholdDeg} degrees assumed`,
        setting("support_top_z_distance") === undefined || setting("layer_height") === undefined ? `support_top_z_distance and layer_height not both given: ${c.defaultTopZMm} + ${c.defaultLayerMm} mm assumed for the rest distance` : undefined,
        options.settings?.support_on_build_plate_only !== undefined && String(options.settings.support_on_build_plate_only) === "1" ? "support_on_build_plate_only is on: faces resting on geometry would still get no support there, which this fact does not model" : undefined,
    ].filter(Boolean).join("; ");
    const cosH = Math.cos(rad(c.horizontalDeg)), cosBand = Math.cos(rad(c.bridgeBandDeg)), cosThr = Math.cos(rad(thresholdDeg));
    // Pass 1 (linear): box, flat bottom, and the face lists the ray stage needs.
    const prepared = read.objects.map(({ soup }) => {
        options.signal?.throwIfAborted();
        const { pos: p, idx } = soup;
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i += 3)
            for (let k = 0; k < 3; k++) {
                lo[k] = Math.min(lo[k], p[i + k]);
                hi[k] = Math.max(hi[k], p[i + k]);
            }
        const out = { soup, box: { lo, hi }, triangles: idx.length / 3, flatBottom: 0, classic: 0, ceiling: [], sloped: [], top: [] };
        for (let t = 0; t < out.triangles; t++) {
            const [a, b, d] = [idx[3 * t] * 3, idx[3 * t + 1] * 3, idx[3 * t + 2] * 3];
            const [ux, uy, uz, vx, vy, vz] = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2], p[d] - p[a], p[d + 1] - p[a + 1], p[d + 2] - p[a + 2]];
            const [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
            const len = Math.hypot(nx, ny, nz);
            if (len < 1e-12)
                continue; // degenerate
            const z = nz / len, area = len / 2, above = (p[a + 2] + p[b + 2] + p[d + 2]) / 3 - lo[2];
            if (z >= cosH)
                out.top.push(t);
            else if (z < 0) {
                if (z <= -cosH && above <= c.flatBottomToleranceMm)
                    out.flatBottom += area;
                if (z < -cosThr && above > c.bedToleranceMm)
                    out.classic += area;
                if (above > c.bedToleranceMm) {
                    if (z <= -cosBand)
                        out.ceiling.push(t);
                    else if (z < -cosThr)
                        out.sloped.push(t);
                }
            }
        }
        return out;
    });
    const facts = {};
    const evidence = {};
    const blind = [];
    const put = (name, value, method, approx = false, notes = "", predictive = false) => {
        facts[name] = value;
        evidence[name] = { source: src, method, approx, notes, ...(predictive ? { predictive } : {}) };
    };
    const skip = (name, reason) => { blind.push(name); evidence[name] = { source: `${src} (not measured)`, method: "not measured", approx: false, notes: reason }; };
    // Linear facts: the box of each object, the plate takes the largest (the smallest for the footprint, as the KB declares it).
    const sizes = prepared.map(o => o.box.hi.map((h, k) => h - o.box.lo[k]));
    const maxOf = (f) => Math.max(...sizes.map(f));
    const box = "bounding box of the vertices after the build item transform (row vectors, component transform first); normal parts of the printable items of the plate";
    put("mesh.size_x_mm", r3(maxOf(s => s[0])), box);
    put("mesh.size_y_mm", r3(maxOf(s => s[1])), box);
    put("mesh.height_mm", r3(maxOf(s => s[2])), box);
    put("mesh.max_object_height_mm", r3(maxOf(s => s[2])), box);
    put("mesh.bbox_max_dim_mm", r3(maxOf(s => Math.max(...s))), box);
    put("mesh.footprint_area_mm2", r3(Math.min(...sizes.map(s => s[0] * s[1]))), `${box}; the smallest XY box area among the objects`);
    const ratios = sizes.filter(s => s[0] * s[1] > 0).map(s => s[2] / Math.sqrt(s[0] * s[1]));
    if (ratios.length)
        put("mesh.height_to_footprint", r3(Math.max(...ratios)), `${box}; height over sqrt(box footprint), the largest among the objects`);
    else
        skip("mesh.height_to_footprint", "every object has a zero footprint");
    put("mesh.triangle_count", read.triangles, "triangles of the normal parts read");
    put("mesh.min_z_mm", r3(Math.min(...prepared.map(o => o.box.lo[2]))), box);
    const flatBottom = prepared.reduce((n, o) => n + o.flatBottom, 0);
    put("mesh.flat_bottom_area_mm2", r3(flatBottom), `downward faces within ${c.horizontalDeg} degrees of horizontal whose centroid is within ${c.flatBottomToleranceMm} mm of the object's lowest point`);
    const footprints = sizes.reduce((n, s) => n + s[0] * s[1], 0);
    if (footprints > 0)
        put("mesh.flat_bottom_share", r3(Math.min(1, flatBottom / footprints)), "flat bottom area over the XY bounding-box footprint (not the convex hull)");
    else
        skip("mesh.flat_bottom_share", "every object has a zero footprint");
    // Top surface levels (linear): faces within horizontalDeg of horizontal facing up, chained in Z, level area >= levelMinAreaMm2.
    // The spec also proposed dropping faces covered by geometry above; its own validated count (3 levels on the sample) keeps them, so they stay.
    const sum = (soup, faces) => faces.reduce((n, t) => n + areaOf(soup, t), 0);
    const levelList = [];
    let levelCount = 0;
    for (const o of prepared) {
        const order = o.top.map(t => [centroid(o.soup, t)[2], t]).sort((a, b) => a[0] - b[0]);
        const clusters = [];
        order.forEach(([z, t], k) => { if (k && z - order[k - 1][0] <= c.levelGapMm)
            clusters[clusters.length - 1].push(t);
        else
            clusters.push([t]); });
        const found = clusters.map(f => ({ z: r3(centroid(o.soup, f[0])[2]), areaMm2: r3(sum(o.soup, f)) })).filter(l => l.areaMm2 >= c.levelMinAreaMm2);
        levelCount = Math.max(levelCount, found.length);
        levelList.push(...found);
    }
    levelList.sort((x, y) => y.z - x.z);
    put("mesh.top_surface_levels", levelCount, `faces within ${c.horizontalDeg} deg of horizontal facing up, chained in Z at ${c.levelGapMm} mm, level area >= ${c.levelMinAreaMm2} mm2; the largest count among the objects`, false, `levels (Z mm: mm2): ${levelList.map(l => `${l.z}: ${l.areaMm2}`).join(" | ") || "none"}; faces covered by geometry above are kept (the spec's validated count keeps them), so the floor of a closed cavity would count`);
    // Ray stage: only the downward faces need a ray.
    const RAY_FACTS = ["mesh.unsupported_overhang_area_mm2", "mesh.flat_ceiling_area_mm2"];
    let details;
    const heavy = prepared.some(o => o.triangles > c.maxRayTriangles);
    if (heavy)
        for (const f of RAY_FACTS)
            skip(f, `malha grande: an object has more than ${c.maxRayTriangles} triangles, over the ray limit; a number would be a guess`);
    else {
        try {
            const zExtent = (soup, faces) => {
                let [lo, hi] = [Infinity, -Infinity];
                for (const t of faces)
                    for (let k = 0; k < 3; k++) {
                        const z = soup.pos[soup.idx[3 * t + k] * 3 + 2];
                        lo = Math.min(lo, z);
                        hi = Math.max(hi, z);
                    }
                return hi - lo;
            };
            // Overhang: connected sloped regions, then the vertical ray down from the centroid of their faces.
            const perObject = prepared.map(o => {
                options.signal?.throwIfAborted();
                const kept = [], narrow = [], short = [];
                for (const region of components(o.soup, o.sloped)) {
                    if (spanXY(o.soup, region) < c.minRegionSpanMm)
                        narrow.push(region);
                    else if (zExtent(o.soup, region) < c.minRiseMm)
                        short.push(region);
                    else
                        kept.push(region);
                }
                return {
                    o, kept, slopedArea: sum(o.soup, o.sloped),
                    droppedSpan: sum(o.soup, narrow.flat()),
                    droppedRise: sum(o.soup, short.flat()), maxShortRise: short.reduce((m, f) => Math.max(m, zExtent(o.soup, f)), 0),
                };
            });
            const demand = perObject.reduce((n, x) => n + x.kept.reduce((m, f) => m + f.length, 0) + x.o.ceiling.length, 0);
            const share = demand <= c.maxRays ? 1 : c.maxRays / demand;
            const tally = { rays: 0, sampled: false };
            let work = 0;
            /** Area of `faces` with no surface within `rest` below the centroid (free) and with one (blocked), stride-sampled when over the budget. */
            const probe = (grid, faces) => {
                const budget = share === 1 ? faces.length : Math.max(1, Math.floor(faces.length * share));
                const stride = Math.ceil(faces.length / budget);
                if (stride > 1)
                    tally.sampled = true;
                let free = 0, blocked = 0;
                for (let k = 0; k < faces.length; k += stride) {
                    const t = faces[k], [x, y, z] = centroid(grid.soup, t), w = Math.min(stride, faces.length - k) * areaOf(grid.soup, t);
                    tally.rays++;
                    if (grid.any(x, y, z - restMm, z + c.rayEpsMm, t))
                        blocked += w;
                    else
                        free += w;
                }
                return { free, blocked };
            };
            let unsupported = 0, ceilingFree = 0, restingArea = 0, droppedSpan = 0, droppedRise = 0, maxShortRise = 0, slopedCandidate = 0, classic = 0;
            for (const x of perObject) {
                droppedSpan += x.droppedSpan;
                droppedRise += x.droppedRise;
                maxShortRise = Math.max(maxShortRise, x.maxShortRise);
                slopedCandidate += x.slopedArea;
                classic += x.o.classic;
                if (!x.kept.length && !x.o.ceiling.length)
                    continue;
                const grid = new RayGrid(x.o.soup, c.gridCellMm, c.rayWork - work);
                try {
                    for (const region of x.kept) {
                        const r = probe(grid, region);
                        unsupported += r.free;
                        restingArea += r.blocked;
                    }
                    ceilingFree += probe(grid, x.o.ceiling).free;
                }
                finally {
                    work += grid.work;
                }
            }
            details = {
                thresholdDeg, restMm: r3(restMm), classicOverhangAreaMm2: r3(classic), flatCeilingAreaMm2: r3(ceilingFree), slopedCandidateAreaMm2: r3(slopedCandidate),
                droppedBySpanMm2: r3(droppedSpan), droppedByRiseMm2: r3(droppedRise), maxDroppedRiseMm: r3(maxShortRise), restingAreaMm2: r3(restingArea),
                levels: levelList, rays: tally.rays, sampled: tally.sampled,
            };
            const sampling = tally.sampled ? `stride-sampled (${tally.rays} rays for ${demand} faces): the area is an estimate` : `${tally.rays} rays`;
            const constants = `implementation constants, not guide values: bridge band ${c.bridgeBandDeg} deg, threshold ${thresholdDeg} deg${angle === thresholdDeg ? " (from the settings)" : ""}, minimum region span ${c.minRegionSpanMm} mm, minimum region rise ${c.minRiseMm} mm, rest distance ${r3(restMm)} mm`;
            put("mesh.flat_ceiling_area_mm2", r3(ceilingFree), `downward faces within ${c.bridgeBandDeg} deg of horizontal, not on the bed, not resting on lower geometry (vertical ray down); ${sampling}`, tally.sampled, `Informational. Studio bridges an anchored flat ceiling; the engine cannot tell a bridge from a flat cantilever (mushroom cap, T), so with no sloped overhang counted, ${r3(c.minRegionSpanMm ** 2)} mm2 or more of free flat ceiling makes mesh.unsupported_overhang_area_mm2 unknown (UNSEEN for support until sliced and read in the G-code).`);
            const notes = [`Not counted: flat ceilings (<= ${c.bridgeBandDeg} deg, ${r3(ceilingFree)} mm2 free: an anchored one is a bridge Studio bridges, a flat cantilever is not, the mesh cannot tell) and short sloped regions (${r3(droppedSpan)} mm2 under the span, ${r3(droppedRise)} mm2 under the rise, tallest ${r3(maxShortRise)} mm).`,
                `The spec's first definition (every downward face under the threshold angle) would give ${r3(classic)} mm2 here.`,
                `Sloped candidates ${r3(slopedCandidate)} mm2, resting on lower geometry ${r3(restingArea)} mm2.`, constants, settingNote].filter(Boolean).join(" ");
            // Three answers: a clear overhang (a number), none at all (a known zero), or something geometry cannot decide (blind, never a 0 and never a positive):
            // a free flat ceiling (a bridge or a cantilever: a mushroom cap would otherwise read 0 and let the `eq 0` actions act), or short sloped regions only
            // (Studio's own generator supports bevels and arch tops when asked, yet many print without).
            // shortcut: the flat-ceiling test is the total free area against minRegionSpanMm squared, not per connected region; many tiny free ceilings add up to blind (the safe side). Upgrade if real parts turn blind for it.
            const flatCeiling = ceilingFree >= c.minRegionSpanMm ** 2;
            if (unsupported > 0 || (!flatCeiling && droppedRise === 0)) {
                put("mesh.unsupported_overhang_area_mm2", r3(unsupported), `PREDICTION from geometry. Downward SLOPED faces between ${c.bridgeBandDeg} and ${thresholdDeg} deg from horizontal, not on the bed, joined into regions whose XY extent is >= ${c.minRegionSpanMm} mm and whose rise is >= ${c.minRiseMm} mm, minus the faces resting on lower geometry (vertical ray down); ${sampling}`, tally.sampled, notes, true);
            }
            else if (flatCeiling) {
                skip("mesh.unsupported_overhang_area_mm2", `ambiguous: no sloped overhang is counted, but ${r3(ceilingFree)} mm2 of flat ceiling hangs in the air (not on the bed, nothing within ${r3(restMm)} mm below): an anchored bridge, which Studio bridges, or a cantilever (mushroom cap, T, shelf), which needs support. Geometry cannot tell, and a 0 here would let the actions that act on 'no overhang' fire for a cantilever, so this is UNSEEN until the slice (Bridge and Overhang wall lines) or a person says. ${notes}`);
            }
            else {
                skip("mesh.unsupported_overhang_area_mm2", `ambiguous: ${r3(droppedRise)} mm2 of sloped faces between ${c.bridgeBandDeg} and ${thresholdDeg} deg from horizontal form only short regions (the tallest rises ${r3(maxShortRise)} mm, under ${c.minRiseMm} mm), and there is no clear overhang. Studio's support generator treats such faces as overhangs when supports are on, but bevels and arch tops often print without: geometry cannot decide, so this is UNSEEN until the slice (Bridge and Overhang wall lines) or a person says. ${notes}`);
            }
        }
        catch (error) {
            if (!(error instanceof WorkExceeded))
                throw error;
            for (const f of RAY_FACTS)
                skip(f, `the vertical-ray work budget ran out (over ${c.rayWork} triangle tests or ${MAX_GRID_ENTRIES} grid entries): a number would be a guess`);
        }
    }
    for (const f of MESH_NOT_IMPLEMENTED)
        skip(f, "not implemented in this fork: expensive mesh analysis (spec section 8, step 5), never measured");
    return { facts, evidence, blind: blind.sort(), stats: { objects: read.objects.length, triangles: read.triangles, ms: Date.now() - started }, details, constants: c };
}
function blindResult(reason, src, started) {
    const names = [...MESH_FACTS, ...REPO_NAMES, ...MESH_NOT_IMPLEMENTED];
    return {
        facts: {}, blind: [...names].sort(), stats: { objects: 0, triangles: 0, ms: Date.now() - started }, constants: { ...MESH_CONSTANTS },
        evidence: Object.fromEntries(names.map(n => [n, { source: `${src} (not measured)`, method: "not measured", approx: false, notes: reason }])),
    };
}
async function guarded(read, options) {
    const started = Date.now();
    const src = options.source ?? "mesh";
    try {
        return meshFactsFromRead(await read(), options);
    }
    catch (error) {
        if (options.signal?.aborted)
            throw error;
        const code = error instanceof MeshReadError ? error.code : "unreadable";
        return blindResult(`${code === "too_large" ? "malha grande: " : ""}${error.message}`, src, started);
    }
}
/** Mesh facts of one plate (0-based) of an opened 3MF (openProject). Never throws on the content of the file: the facts come back blind with the reason. */
export const meshFactsFromProject = (project, plateIndex, options = {}) => guarded(() => readProjectMesh(project, plateIndex), { ...options, source: options.source ?? `3MF plate ${plateIndex + 1}` });
/** Mesh facts of one STL file. */
export const meshFactsFromStl = (filePath, options = {}) => guarded(() => readStlMesh(filePath), { ...options, source: options.source ?? "STL" });
