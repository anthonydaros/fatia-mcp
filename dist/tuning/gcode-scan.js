// Streaming scanner for a sliced Bambu Studio G-code: a plain .gcode, or Metadata/plate_N.gcode of a .gcode.3mf.
// Spec: kb/tuning/out/analyzer-spec.md section 5 (real X2D formats). One pass, O(1) memory in the file size: the state of the current
// line plus the obstacle segments of the current layer. G-code, comments and config values are data: read, never executed or obeyed.
//
// A fact the scan cannot stand behind is left out (never guessed, never 0): the key is missing, the name goes to `blind` and
// `evidence[name].notes` says why. A zero is a known value only when the whole file was read (EXECUTABLE_BLOCK_END seen, config read)
// and, for the roles whose marker has never been seen in a real file (support, brim, prime tower, ironing, flush, aux nozzle), only
// when the file's own config (or the slice result) says that thing is off. A marker that IS in the file is counted as it is.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { MAX_PRINT_FILE_BYTES, streamSafe3mfEntryFromFile } from "../safety/archive.js";
/** Every fact the scan can produce (the `blind` list covers exactly the ones it did not). */
export const GCODE_SCAN_FACTS = [
    "gcode.layer_count", "gcode.extruded_weight_g",
    "gcode.support_line_count", "gcode.support_interface_line_count", "gcode.support_weight_g", "gcode.ironing_line_count",
    "gcode.first_layer_height_mm", "gcode.first_layer_speed_mm_s", "gcode.first_layer_wall_speed_mm_s", "gcode.first_layer_infill_speed_mm_s",
    "gcode.first_layer_area_mm2", "gcode.first_layer_brim_present",
    "gcode.flow_limit_exceeded_share", "gcode.min_line_width_mm", "gcode.top_layer_count", "gcode.zhop_lift_count", "gcode.zhop_type_mismatch",
    "gcode.unprotected_travel_count", "gcode.unprotected_travel_crossing_count", "gcode.unprotected_travel_curl_risk_count",
    "gcode.unprotected_travels_by_origin", "gcode.unprotected_travels_in_support", "gcode.unprotected_travel_over_20mm_count",
    "gcode.unprotected_travel_max_mm",
    "gcode.tool_xy_outside_area_count", "gcode.aux_nozzle_max_extrusion_feedrate_mm_s", "gcode.aux_nozzle_max_extrusion_accel_mm_s2",
    "gcode.flush_length_mismatch_count", "gcode.purge_g", "gcode.tower_g", "gcode.tower_height_mm",
    "gcode.missing_thin_feature_count", "plate.tool_changes", "plate.waste_weight_g",
];
const MAX_LINE = 64 * 1024; // the sample has a 15 345 character line (machine_start_gcode); more than 64 KB is not a G-code line
const COORD_LIMIT = 1e5; // mm: a coordinate word beyond this is garbage, not a move
const CELL = 4; // mm, crossing grid
const MAX_CELLS = 16384; // cells one segment may cover; a longer one (hostile input) is skipped and counted
// The real X2D plate peaks at 3 174 segments per layer, 12 points per run, 584 config keys and 4 polygon vertices.
const DEFAULT_LIMITS = { layerSegments: 500000, layerCells: 4000000, runPoints: 50000, work: 3e8, polyVertices: 256, keys: 10000, blockBytes: 4 * 2 ** 20 };
/** A copy of a slice of a decoded chunk: V8 keeps the whole chunk text alive for as long as a sliced string lives, so a stored value must not be one. */
const own = (v) => Buffer.from(v).toString();
const OVER_MM = 20;
const SEVERE = new Set(["Outer wall", "Inner wall", "Overhang wall", "Floating vertical shell", "Support", "Support interface", "Support transition", "Top surface"]);
const WALLS = new Set(["Outer wall", "Inner wall", "Overhang wall", "Floating vertical shell"]);
const OBSTACLES = new Set([...WALLS, "Support", "Support interface", "Support transition", "Top surface", "Bridge", "Bottom surface", "Internal solid infill", "Gap infill"]);
const CURL = new Set(["Overhang wall", "Bridge", "Top surface"]);
const INFILL = new Set(["Sparse infill", "Internal solid infill", "Bottom surface", "Top surface"]);
const MODEL_ROLES = new Set([...WALLS, "Top surface", "Bottom surface", "Internal solid infill", "Gap infill", "Sparse infill", "Ironing"]);
const KNOWN = new Set([...OBSTACLES, "Sparse infill", "Custom", "Skirt", "Brim", "Ironing", "Prime tower", "Flush", "Travel"]);
const MARKERS = ["; WIPE_TOWER_START", "; NOZZLE_CHANGE_START", "; FLUSH_START", "; VFLUSH_START", "; CP_TOOLCHANGE_WIPE"];
const LIFT_NAME = ["", "Spiral Lift", "Normal Lift", "Slope Lift"];
const LIFT_STYLE = /^(Normal|Slope|Spiral) Lift$/;
const isSupport = (name) => name.startsWith("Support");
function makeFeat(name) {
    const support = isSupport(name);
    return {
        name, support, wall: WALLS.has(name), curl: CURL.has(name), infill: INFILL.has(name), severe: SEVERE.has(name) || support,
        obstacle: OBSTACLES.has(name) || support, interface: support && /interface/i.test(name), transition: support && /transition/i.test(name),
        tower: name === "Prime tower", ironing: name === "Ironing", brim: name === "Brim", top: name === "Top surface",
        footprint: !(name === "Custom" || name === "Skirt" || name === "Brim" || name === "Prime tower" || support), segs: 0, grams: 0,
    };
}
const r3 = (v) => Math.round(v * 1000) / 1000;
const nums = (text) => (text === undefined ? [] : text.split(/[;,]/).map(t => Number.parseFloat(t)));
const at = (list, i) => (Number.isFinite(list[i]) ? list[i] : list[0]);
function parsePolys(text, maxVertices) {
    const polys = [];
    let vertices = 0;
    for (const part of (text ?? "").split("#")) {
        const pts = part.split(",").flatMap(p => p.split("x").map(Number));
        vertices += pts.length / 2;
        if (pts.length < 6 || pts.length % 2 || vertices > maxVertices || pts.some(v => !Number.isFinite(v)))
            return []; // inside() walks every vertex of every move
        const xs = pts.filter((_, i) => i % 2 === 0), ys = pts.filter((_, i) => i % 2 === 1);
        const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        polys.push({ pts, minX, maxX, minY, maxY, rect: pts.length === 8 && pts.every((v, i) => v === (i % 2 ? minY : minX) || v === (i % 2 ? maxY : maxX)) });
    }
    return polys;
}
function inside(poly, x, y, tol) {
    if (x < poly.minX - tol || x > poly.maxX + tol || y < poly.minY - tol || y > poly.maxY + tol)
        return false;
    if (poly.rect)
        return true;
    const p = poly.pts;
    let inn = false, near = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
        const [ax, ay, bx, by] = [p[j], p[j + 1], p[i], p[i + 1]];
        if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax)
            inn = !inn;
        const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2)) : 0;
        if (Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) <= tol)
            near = true;
    }
    return inn || near;
}
function arcLen(x0, y0, x1, y1, i, j, cw) {
    const cx = x0 + i, cy = y0 + j, r = Math.hypot(i, j);
    let d = Math.atan2(y1 - cy, x1 - cx) - Math.atan2(y0 - cy, x0 - cx);
    if (cw) {
        if (d >= 0)
            d -= 2 * Math.PI;
    }
    else if (d <= 0)
        d += 2 * Math.PI; // start == end is a full circle
    return Math.abs(d) * r;
}
const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
function properCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1 = orient(ax, ay, bx, by, cx, cy), d2 = orient(ax, ay, bx, by, dx, dy);
    const d3 = orient(cx, cy, dx, dy, ax, ay), d4 = orient(cx, cy, dx, dy, bx, by);
    const e = 1e-6; // interior with interior; touching at an end does not count
    return ((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e));
}
const cellIndex = (v) => Math.max(-512, Math.min(1535, Math.floor(v / CELL)));
const cellKey = (i, j) => (i + 512) * 2048 + (j + 512);
/** The line-by-line state machine. `line` takes one decoded line without its terminator; `finish` builds the result. */
export function createGcodeScanner(options = {}) {
    const src = options.source ?? "G-code";
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const PRE = 0, HEADER = 1, CONFIG = 2, EXEC = 3, DONE = 4;
    let block = PRE;
    let execEnded = false, configDone = false, printing = false, printed = false, skippable = false;
    const cfg = { ...options.fallbackConfig };
    let configKeys = Object.keys(cfg).length;
    const header = {};
    let ready = false; // config was known when the executable block started
    // config-derived
    let minTravel = [], filMinTravel = [], fmap = [], maxVol = [], areaFil = [], gPerMm = [], polys = [];
    // motion state
    let x = 0, y = 0, z = 0, f = 0, relE = true, relXYZ = false, lastE = 0, accel = 0, tool = 0;
    let currentObject, objectLabelsValid = true;
    const objectObservations = new Map();
    let layerHeightLayers = 0, lastHeightLayer = -1, lastModelLayer = -1, modelHeightMarkersValid = true;
    let minLayerHeight = Infinity, maxLayerHeight = -Infinity;
    let layer = -1, layerZ = 0, layerH = 0, width = 0, lcPending = false, lines = 0, longLines = 0, badWords = 0;
    const toolsSeen = new Set();
    let toolChanges = 0;
    const markersSeen = new Set();
    // features
    const feats = [makeFeat("")];
    const featIds = new Map([["", 0]]);
    let cur = 0, lastFeat = -1, lastSupportSeg = -1;
    const unknownFeatures = [];
    // run (the non-extruding moves between two extrusions)
    let inRun = false, runLen = 0, runRetract = false, runLift = 0, runLayerChange = false, runFeat = -1, runPrevSeg = -1, runTrunc = false;
    const runPts = [];
    // layer segment store + grid (obstacles only)
    let cap = 1024, segCount = 0;
    let sx0 = new Float64Array(cap), sy0 = new Float64Array(cap), sx1 = new Float64Array(cap), sy1 = new Float64Array(cap);
    let sf = new Uint8Array(cap), sw = new Float32Array(cap), seen = new Uint32Array(cap), stamp = 0;
    let cells = new Map();
    const supportIds = [];
    const pairs = [];
    let pendingPair = -1, gridSkipped = 0, cellEntries = 0;
    let work = 0, crossSkipped = 0, headerKeys = 0, blockBytes = 0, blockLines = 0; // blockLines: header/config lines not stored because a key or byte cap tripped // work: bucket entries visited so far, against limits.work
    const hitFlag = [], hitList = [];
    // counters
    let runs = 0, retractRuns = 0, zhopLifts = 0, liftsNoRetract = 0, liftsLayerChange = 0, unprotLayerChange = 0, belowMin = 0;
    const lifts = [0, 0, 0, 0], styles = [0, 0, 0, 0];
    let unprotected = 0, crossing = 0, crossingSevere = 0, curlRisk = 0, over20 = 0, inSupport = 0, afterSparseSevere = 0;
    let maxLen = 0, maxLayer = -1, maxZ = 0;
    const byOrigin = new Map();
    const crossedRoles = new Map();
    let outside = 0, layers = 0, topLayers = 0, lastTopLayer = -1;
    let totalGrams = 0, minWallWidth = Infinity, flowLen = 0, flowOver = 0, flowMax = 0, flowLimit = 0;
    let flBrim = false, flArea = 0, flSegs = 0, flHeight = Number.NaN;
    let flMax = 0, flWall = 0, flInfill = 0;
    const flSpeeds = new Map();
    const extFeed = [0, 0], extAccel = [0, 0], extSegs = [0, 0];
    let flushLines = 0, flushLen = 0, towerMaxZ = 0;
    let arcSeen = false, blockKeys = 0;
    const extruderOf = (t) => Math.max(0, Math.min(1, Number.isFinite(fmap[t]) ? fmap[t] : 0));
    const minTravelOf = (t) => {
        const own = filMinTravel[t];
        if (Number.isFinite(own))
            return own;
        const v = at(minTravel, extruderOf(t));
        return Number.isFinite(v) ? v : Number.NaN;
    };
    function featId(name) {
        let id = featIds.get(name);
        if (id !== undefined)
            return id;
        if (feats.length >= 200)
            return 0; // a hostile file cannot grow the table; extra names fall in the unnamed role
        id = feats.length;
        name = own(name);
        feats.push(makeFeat(name));
        featIds.set(name, id);
        if (!KNOWN.has(name) && !isSupport(name))
            unknownFeatures.push(name);
        return id;
    }
    function prepare() {
        const c = cfg;
        minTravel = nums(c.retraction_minimum_travel);
        filMinTravel = nums(c.filament_retraction_minimum_travel);
        fmap = nums(c.filament_map).map(v => v - 1);
        maxVol = nums(c.filament_max_volumetric_speed);
        const diam = nums(c.filament_diameter ?? header.filament_diameter), dens = nums(c.filament_density ?? header.filament_density);
        areaFil = diam.map(d => Math.PI * (d / 2) ** 2);
        gPerMm = areaFil.map((a, i) => (a * at(dens, i)) / 1000);
        polys = parsePolys(c.extruder_printable_area, limits.polyVertices);
        ready = configKeys > 0;
    }
    const gram = (t) => (Number.isFinite(gPerMm[t]) ? gPerMm[t] : gPerMm[0]);
    const area = (t) => (Number.isFinite(areaFil[t]) ? areaFil[t] : areaFil[0]);
    function grow() {
        cap *= 2;
        const f64 = (a) => { const n = new Float64Array(cap); n.set(a); return n; };
        sx0 = f64(sx0);
        sy0 = f64(sy0);
        sx1 = f64(sx1);
        sy1 = f64(sy1);
        const n8 = new Uint8Array(cap);
        n8.set(sf);
        sf = n8;
        const n32 = new Float32Array(cap);
        n32.set(sw);
        sw = n32;
        seen = new Uint32Array(cap);
        stamp = 0;
    }
    function addSeg(ax, ay, bx, by, id) {
        const n = segCount;
        const [i0, i1, j0, j1] = [cellIndex(Math.min(ax, bx)), cellIndex(Math.max(ax, bx)), cellIndex(Math.min(ay, by)), cellIndex(Math.max(ay, by))];
        const covered = (i1 - i0 + 1) * (j1 - j0 + 1);
        if (covered > MAX_CELLS || segCount >= limits.layerSegments || cellEntries + covered > limits.layerCells) {
            gridSkipped++;
            return -1;
        }
        cellEntries += covered;
        if (n >= cap)
            grow();
        segCount++;
        sx0[n] = ax;
        sy0[n] = ay;
        sx1[n] = bx;
        sy1[n] = by;
        sf[n] = id;
        sw[n] = width;
        for (let i = i0; i <= i1; i++)
            for (let j = j0; j <= j1; j++) {
                const k = cellKey(i, j);
                const bucket = cells.get(k);
                if (bucket)
                    bucket.push(n);
                else
                    cells.set(k, [n]);
            }
        return n;
    }
    /** Feature ids of the obstacles the polyline crosses, in hitList. False when part of the polyline was not tested (a segment too long for the grid, or the work budget is spent). */
    function crossings() {
        hitList.length = 0;
        let tested = true;
        for (let p = 2; p < runPts.length; p += 2) {
            if (work > limits.work) {
                tested = false;
                break;
            }
            if (++stamp >= 0xfffffff0) {
                seen.fill(0);
                stamp = 1;
            }
            const [ax, ay, bx, by] = [runPts[p - 2], runPts[p - 1], runPts[p], runPts[p + 1]];
            const [i0, i1, j0, j1] = [cellIndex(Math.min(ax, bx)), cellIndex(Math.max(ax, bx)), cellIndex(Math.min(ay, by)), cellIndex(Math.max(ay, by))];
            if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_CELLS) {
                tested = false;
                continue;
            }
            for (let i = i0; i <= i1; i++)
                for (let j = j0; j <= j1; j++) {
                    const bucket = cells.get(cellKey(i, j));
                    work += 1 + (bucket?.length ?? 0);
                    if (!bucket)
                        continue;
                    for (const id of bucket) {
                        if (seen[id] === stamp)
                            continue;
                        seen[id] = stamp;
                        const fid = sf[id];
                        if (!hitFlag[fid] && properCross(ax, ay, bx, by, sx0[id], sy0[id], sx1[id], sy1[id])) {
                            hitFlag[fid] = true;
                            hitList.push(fid);
                        }
                    }
                }
        }
        for (const fid of hitList)
            hitFlag[fid] = false;
        return tested && work <= limits.work;
    }
    function resolveIslands() {
        if (pairs.length) {
            // support island = connected set of this layer's support segments whose ends lie within 1.5 line widths of each other
            const parent = new Int32Array(segCount);
            for (let i = 0; i < segCount; i++)
                parent[i] = i;
            const find = (a) => { while (parent[a] !== a) {
                parent[a] = parent[parent[a]];
                a = parent[a];
            } return a; };
            const buckets = new Map();
            const key = (px, py) => Math.max(-512, Math.min(1535, Math.floor(px / 2))) * 2048 + Math.max(-512, Math.min(1535, Math.floor(py / 2)));
            for (const id of supportIds)
                for (const [px, py] of [[sx0[id], sy0[id]], [sx1[id], sy1[id]]]) {
                    const k = key(px, py);
                    const b = buckets.get(k);
                    if (b)
                        b.push(id);
                    else
                        buckets.set(k, [id]);
                }
            for (const id of supportIds)
                for (const [px, py] of [[sx0[id], sy0[id]], [sx1[id], sy1[id]]]) {
                    if (work > limits.work)
                        break; // budget spent: the remaining segments are not merged (inSupport is then a lower bound)
                    for (let di = -1; di <= 1; di++)
                        for (let dj = -1; dj <= 1; dj++) {
                            const near = buckets.get(key(px + di * 2, py + dj * 2)) ?? [];
                            work += 1 + near.length;
                            for (const other of near) {
                                if (find(other) === find(id))
                                    continue;
                                const tol = 1.5 * Math.max(sw[id], sw[other], 0.1);
                                if (Math.hypot(sx0[other] - px, sy0[other] - py) <= tol || Math.hypot(sx1[other] - px, sy1[other] - py) <= tol)
                                    parent[find(other)] = find(id);
                            }
                        }
                }
            for (let p = 0; p < pairs.length; p += 2)
                if (find(pairs[p]) === find(pairs[p + 1]))
                    inSupport++;
            pairs.length = 0;
        }
        supportIds.length = 0;
    }
    function startRun() {
        inRun = true;
        runLen = 0;
        runRetract = false;
        runLift = 0;
        runLayerChange = lcPending;
        lcPending = false;
        runFeat = lastFeat;
        runPrevSeg = lastSupportSeg;
        runPts.length = 0;
        runPts.push(x, y);
        runTrunc = false;
    }
    function endRun() {
        if (!inRun)
            return;
        inRun = false;
        runs++;
        const over = runLen > minTravelOf(tool);
        if (runRetract)
            retractRuns++;
        if (runLift) {
            lifts[runLift]++;
            if (runLayerChange)
                liftsLayerChange++;
            else {
                zhopLifts++;
                styles[runLift]++;
                if (!runRetract)
                    liftsNoRetract++;
            }
        }
        if (!(over && !runRetract && !runLift)) {
            if (!over && !runRetract && !runLift)
                belowMin++;
            return;
        }
        if (runLayerChange) {
            unprotLayerChange++;
            return;
        }
        unprotected++;
        if (runLen > OVER_MM)
            over20++;
        if (runLen > maxLen) {
            maxLen = runLen;
            maxLayer = layer;
            maxZ = layerZ;
        }
        const origin = runFeat >= 0 ? feats[runFeat].name : "(none)";
        let o = byOrigin.get(origin);
        if (!o)
            byOrigin.set(origin, o = { unprotected: 0, crossing: 0 });
        o.unprotected++;
        if (runTrunc || !crossings())
            crossSkipped++; // runTrunc: more points than limits.runPoints, no crossing test at all
        if (!runTrunc && hitList.length) {
            crossing++;
            o.crossing++;
            let severe = false, curl = false;
            for (const fid of hitList) {
                const ft = feats[fid];
                crossedRoles.set(ft.name, (crossedRoles.get(ft.name) ?? 0) + 1);
                if (ft.severe)
                    severe = true;
                if (ft.curl)
                    curl = true;
            }
            if (severe) {
                crossingSevere++;
                if (origin === "Sparse infill")
                    afterSparseSevere++;
            }
            if (curl)
                curlRisk++;
        }
        if (runFeat >= 0 && feats[runFeat].support && runPrevSeg >= 0)
            pendingPair = runPrevSeg;
    }
    function extrusion(dxy, e, nx, ny, arc) {
        endRun();
        if (arc)
            arcSeen = true;
        const ft = feats[cur];
        ft.segs++;
        const grams = e * gram(tool);
        ft.grams += grams;
        totalGrams += grams;
        lastFeat = cur;
        let id = -1;
        if (ft.obstacle) {
            id = addSeg(x, y, nx, ny, cur);
            if (id >= 0 && ft.support)
                supportIds.push(id);
        }
        lastSupportSeg = ft.support ? id : -1;
        if (pendingPair >= 0 && ft.support && id >= 0)
            pairs.push(pendingPair, id);
        pendingPair = -1;
        if (!printing)
            return;
        if (ft.wall && width > 0 && width < minWallWidth)
            minWallWidth = width;
        if (ft.tower && z > towerMaxZ)
            towerMaxZ = z;
        const ext = extruderOf(tool);
        extSegs[ext]++;
        if (f / 60 > extFeed[ext])
            extFeed[ext] = f / 60;
        if (accel > extAccel[ext])
            extAccel[ext] = accel;
        if (ft.name !== "Custom" && dxy > 0.01) {
            const a = area(tool), lim = at(maxVol, tool);
            if (a > 0 && lim > 0) {
                const flow = ((e * a) / dxy) * (f / 60);
                flowLimit = lim;
                flowLen += dxy;
                if (flow > flowMax)
                    flowMax = flow;
                if (flow > lim * 1.001)
                    flowOver += dxy;
            }
        }
        if (ft.top && layer !== lastTopLayer) {
            topLayers++;
            lastTopLayer = layer;
        }
        if (layer === 0 && ft.name !== "Custom") {
            flSegs++;
            const speed = f / 60;
            if (speed > flMax)
                flMax = speed;
            if (ft.wall && speed > flWall)
                flWall = speed;
            if (ft.infill && speed > flInfill)
                flInfill = speed;
            const key = Math.round(speed);
            flSpeeds.set(key, (flSpeeds.get(key) ?? 0) + 1);
            if (ft.footprint)
                flArea += dxy * width;
            if (ft.brim)
                flBrim = true;
        }
    }
    function motion(cmd, s, i) {
        let nx = x, ny = y, nz = z, ev = 0, hasE = false, hasXY = false, hasZ = false, I = 0, J = 0;
        const n = s.length;
        while (i < n) {
            let c = s.charCodeAt(i);
            if (c === 59)
                break; // ';' starts a comment
            if (c <= 32) {
                i++;
                continue;
            }
            let j = i + 1;
            while (j < n && (c = s.charCodeAt(j)) > 32 && c !== 59)
                j++;
            const v = Number.parseFloat(s.slice(i + 1, j));
            const letter = s.charCodeAt(i);
            i = j;
            if (!Number.isFinite(v) || Math.abs(v) > COORD_LIMIT) {
                badWords++;
                continue;
            }
            switch (letter) {
                case 88:
                    nx = relXYZ ? x + v : v;
                    hasXY = true;
                    break; // X
                case 89:
                    ny = relXYZ ? y + v : v;
                    hasXY = true;
                    break; // Y
                case 90:
                    nz = relXYZ ? z + v : v;
                    hasZ = true;
                    break; // Z
                case 69:
                    ev = v;
                    hasE = true;
                    break; // E
                case 70:
                    f = v;
                    break; // F
                case 73:
                    I = v;
                    break; // I
                case 74:
                    J = v;
                    break; // J
            }
        }
        let e = 0;
        if (hasE) {
            if (relE)
                e = ev;
            else {
                e = ev - lastE;
                lastE = ev;
            }
        }
        const arc = cmd >= 2;
        const dxy = arc ? arcLen(x, y, nx, ny, I, J, cmd === 2) : Math.hypot(nx - x, ny - y);
        // timelapse park moves (SKIPPABLE blocks) and machine start/end code move the nozzle but are not travels of the part
        if (skippable) { /* position only */ }
        else if (hasE && e > 0 && (dxy > 0 || arc)) {
            if (printing && layer > 0 && MODEL_ROLES.has(feats[cur].name)) {
                if (lastHeightLayer !== layer || !Number.isFinite(layerH) || layerH <= 0)
                    modelHeightMarkersValid = false;
                else {
                    minLayerHeight = Math.min(minLayerHeight, layerH);
                    maxLayerHeight = Math.max(maxLayerHeight, layerH);
                    if (lastModelLayer !== layer) {
                        layerHeightLayers++;
                        lastModelLayer = layer;
                    }
                }
            }
            if (printing && currentObject) {
                const observation = objectObservations.get(currentObject);
                if (observation) {
                    observation.extrusion_segments++;
                    const role = feats[cur].name;
                    const prefix = role === 'Outer wall' ? 'outer' : role === 'Inner wall' ? 'inner' : undefined;
                    if (prefix) {
                        const speed = `${prefix}_wall_speed_max_mm_s`, acceleration = `${prefix}_wall_acceleration_max_mm_s2`;
                        if (f > 0)
                            observation[speed] = Math.max(observation[speed] ?? 0, f / 60);
                        if (accel > 0)
                            observation[acceleration] = Math.max(observation[acceleration] ?? 0, accel);
                    }
                    if (layer > 0 && MODEL_ROLES.has(role) && lastHeightLayer !== layer)
                        observation.heightMarkersComplete = false;
                    if (layer > 0 && MODEL_ROLES.has(role) && layerH > 0 && lastHeightLayer === layer) {
                        observation.min_layer_height_mm = Math.min(observation.min_layer_height_mm ?? Infinity, layerH);
                        observation.max_layer_height_mm = Math.max(observation.max_layer_height_mm ?? -Infinity, layerH);
                    }
                }
            }
            extrusion(dxy, e, nx, ny, arc);
        }
        else if (!printing) { /* position only */ }
        else if (hasE && e < 0) {
            if (!inRun)
                startRun();
            runRetract = true;
        }
        else if (!(hasE && e > 0)) {
            if (!inRun)
                startRun();
            if (arc && hasZ && !hasXY && nz > z)
                runLift = 1; // spiral lift: G3 Z.. I.. J.. P1, no X, Y or E
            else if (hasZ && !hasXY && !arc) {
                if (nz > z && nz > layerZ + 0.001 && !runLift)
                    runLift = 2;
            } // normal lift: G1 Z up above the layer
            else if (hasZ && hasXY && !arc && nz > z + 1e-6 && nz > layerZ + 0.001)
                runLift || (runLift = 3); // slope: Z must rise against the previous Z
            if (hasXY) {
                runLen += dxy;
                if (runPts.length < 2 * limits.runPoints)
                    runPts.push(nx, ny);
                else
                    runTrunc = true;
            }
        }
        if (printing && !skippable && hasXY && polys.length) {
            const poly = polys[Math.min(extruderOf(tool), polys.length - 1)];
            if (!inside(poly, nx, ny, 0.01))
                outside++;
        }
        x = nx;
        y = ny;
        z = nz;
    }
    function handleTool(s, i) {
        let j = i + 1;
        while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57)
            j++;
        if (j === i + 1 || (j < s.length && s.charCodeAt(j) > 32 && s.charCodeAt(j) !== 59))
            return false;
        const t = Number(s.slice(i + 1, j));
        if (t >= 254)
            return true; // T65279 / T65535: retract the filament to the AMS, not a tool change
        toolsSeen.add(t);
        if (printing && t !== tool)
            toolChanges++;
        tool = t;
        return true;
    }
    function flush(s, i) {
        for (const word of s.slice(i).split(";")[0].trim().split(/\s+/)) {
            if (word[0] === "L") {
                const v = Number.parseFloat(word.slice(1));
                if (Number.isFinite(v) && v >= 0 && v < 1e4) {
                    flushLines++;
                    flushLen += v;
                }
            }
        }
    }
    function changeLayer() {
        resolveIslands();
        layer++;
        layers++;
        segCount = 0;
        cellEntries = 0;
        cells.clear();
        lastSupportSeg = -1;
        pendingPair = -1;
        if (inRun)
            runLayerChange = true;
        else
            lcPending = true;
        if (!printing && !printed)
            printing = true;
    }
    function exec(s) {
        let i = 0;
        const n = s.length;
        while (i < n && s.charCodeAt(i) <= 32)
            i++;
        if (i >= n)
            return;
        const c0 = s.charCodeAt(i);
        if (c0 === 59) {
            comment(s, i);
            return;
        }
        // command word
        let j = i + 1;
        while (j < n && s.charCodeAt(j) > 32 && s.charCodeAt(j) !== 59)
            j++;
        const word = s.slice(i, j);
        switch (word) {
            case "G1":
            case "G0":
                motion(1, s, j);
                return;
            case "G2":
                motion(2, s, j);
                return;
            case "G3":
                motion(3, s, j);
                return;
            case "M83":
                relE = true;
                return;
            case "M82":
                relE = false;
                return;
            case "G90":
                relXYZ = false;
                return;
            case "G91":
                relXYZ = true;
                return;
            case "G92": {
                const m = /\bE(-?[\d.]+)/.exec(s);
                if (m)
                    lastE = Number.parseFloat(m[1]);
                return;
            }
            case "M204": {
                for (const w of s.slice(j).split(";")[0].trim().split(/\s+/))
                    if (w[0] === "S" || w[0] === "P") {
                        const v = Number.parseFloat(w.slice(1));
                        if (Number.isFinite(v))
                            accel = v;
                    }
                return;
            }
            case "M620.10":
                flush(s, j);
                return;
        }
        if (c0 === 84)
            handleTool(s, i); // T
    }
    function comment(s, i) {
        // s[i] === ';' ; frequent markers first
        if (s.startsWith("; LINE_WIDTH: ", i)) {
            const v = Number.parseFloat(s.slice(i + 14));
            if (Number.isFinite(v))
                width = v;
        }
        else if (s.startsWith("; FEATURE: ", i)) {
            const name = s.slice(i + 11).trim().slice(0, 64);
            cur = featId(name);
        }
        else if (s.startsWith('; start printing object, unique label id: ', i) || s.startsWith('; stop printing object, unique label id: ', i)) {
            const match = /^; (start|stop) printing object, unique label id: (\d+)\s*$/.exec(s.slice(i));
            if (!match || match[2].length > 12) {
                objectLabelsValid = false;
                currentObject = undefined;
                return;
            }
            const label = match[2];
            if (match[1] === 'start') {
                if (currentObject !== undefined)
                    objectLabelsValid = false;
                if (!objectObservations.has(label) && objectObservations.size < 500)
                    objectObservations.set(label, { heightMarkersComplete: true, starts: 0, stops: 0, extrusion_segments: 0 });
                const observation = objectObservations.get(label);
                if (observation) {
                    observation.starts++;
                    currentObject = label;
                }
                else {
                    objectLabelsValid = false;
                    currentObject = undefined;
                }
            }
            else {
                if (currentObject !== label)
                    objectLabelsValid = false;
                const observation = objectObservations.get(label);
                if (observation)
                    observation.stops++;
                currentObject = undefined;
            }
        }
        else if (s.startsWith("; LAYER_HEIGHT: ", i)) {
            const v = Number.parseFloat(s.slice(i + 16));
            if (Number.isFinite(v)) {
                layerH = v;
                if (layer === 0 && Number.isNaN(flHeight))
                    flHeight = v;
                if (layer > 0 && v > 0)
                    lastHeightLayer = layer;
            }
        }
        else if (s.startsWith("; Z_HEIGHT: ", i)) {
            const v = Number.parseFloat(s.slice(i + 12));
            if (Number.isFinite(v))
                layerZ = v;
        }
        else if (s.startsWith("; CHANGE_LAYER", i))
            changeLayer();
        else if (s.startsWith("; MACHINE_START_GCODE_END", i)) {
            if (!printed) {
                printing = true;
                endRunDrop();
            }
        }
        else if (s.startsWith("; MACHINE_END_GCODE_START", i)) {
            printing = false;
            printed = true;
            endRunDrop();
        }
        else if (s.startsWith("; SKIPPABLE_START", i))
            skippable = true; // the open run stays open: its retraction and lift come first
        else if (s.startsWith("; SKIPPABLE_END", i))
            skippable = false;
        else if (s.startsWith("; EXECUTABLE_BLOCK_END", i) && s.trimEnd() === "; EXECUTABLE_BLOCK_END") {
            block = DONE;
            execEnded = true;
            resolveIslands();
        }
        else
            for (const m of MARKERS)
                if (s.startsWith(m, i)) {
                    markersSeen.add(m.slice(2));
                    break;
                }
    }
    /** Drop the open run without counting it: it is not between two extrusions of the part (machine code or a timelapse park). */
    function endRunDrop() { inRun = false; lcPending = false; }
    function outerLine(s) {
        const inBlock = block === HEADER || block === CONFIG;
        if (inBlock)
            blockBytes += s.length + 1;
        const over = inBlock && blockBytes > limits.blockBytes;
        if (over)
            blockLines++;
        if (s.charCodeAt(0) !== 59)
            return;
        const marker = s.trimEnd(); // block markers are whole lines: "; EXECUTABLE_BLOCK_END_X" is not one
        if (marker === "; HEADER_BLOCK_START")
            block = HEADER;
        else if (marker === "; CONFIG_BLOCK_START")
            block = CONFIG;
        else if (marker === "; EXECUTABLE_BLOCK_START") {
            block = EXEC;
            prepare();
        }
        else if (marker === "; HEADER_BLOCK_END" || marker === "; CONFIG_BLOCK_END") {
            if (block === CONFIG)
                configDone = blockKeys > 0;
            block = PRE;
        }
        else if (block === CONFIG) {
            const eq = over ? -1 : s.indexOf(" = ", 2);
            if (eq > 2) {
                const key = s.slice(2, eq);
                const known = key in cfg;
                if (known || configKeys < limits.keys) {
                    if (!known)
                        configKeys++;
                    blockKeys++;
                    cfg[key] = own(s.slice(eq + 3));
                } // the caps keep a hostile block from growing with the file
                else
                    blockLines++;
            }
        }
        else if (block === HEADER && !over) {
            const m = /^; BambuStudio (\S+)\s*$/.exec(s);
            if (m)
                header.studio_version = own(m[1]);
            else {
                const t = /total estimated time: ([^;]+)/.exec(s);
                if (t)
                    header.total_estimated_time = own(t[1].trim());
                const c = s.indexOf(":", 2); // indexOf, not a regex: a lazy group before \s*: is quadratic on a 64 KB line of spaces
                if (c > 2) {
                    const key = s.slice(2, c).trimEnd();
                    if (key && !key.includes(";") && !(key in header)) {
                        if (headerKeys < limits.keys) {
                            headerKeys++;
                            header[key] = own(s.slice(c + 1).trimStart());
                        }
                        else
                            blockLines++;
                    }
                }
            }
        }
    }
    function finish(stats) {
        resolveIslands();
        const t0 = performance.now();
        const hasConfig = (configDone || Object.keys(options.fallbackConfig ?? {}).length > 0) && blockLines === 0; // a capped block is a block not read
        const complete = execEnded && hasConfig && longLines === 0;
        const partial = !complete;
        const why = !execEnded ? "the file is truncated (no EXECUTABLE_BLOCK_END)" : blockLines ? `the header/config blocks passed their cap (${limits.blockBytes} characters or ${limits.keys} keys): ${blockLines} line(s) not stored` : !hasConfig ? "the config block was not read" : longLines ? `${longLines} line(s) over 64 KB were skipped` : "";
        const facts = {};
        const evidence = {};
        const blind = [];
        const capped = gridSkipped > 0 || crossSkipped > 0 || work > limits.work;
        const capNote = `work caps: ${gridSkipped} obstacle segment(s) not entered in the crossing grid, ${crossSkipped} travel(s) with a cut-short crossing test${work > limits.work ? ", support-island merge stopped by the work budget" : ""}; the counts are lower bounds`;
        const sourceOf = (what) => `${src} (${what})`;
        // `bounded`: the value is a lower bound because a cap tripped (capNote), as a truncated file's is
        const put = (name, value, what, method, approx = false, notes = "", bounded = false) => {
            if (partial && !options.allowPartial)
                return skip(name, `${why}: a partial scan is not a measurement`);
            if ((partial || bounded) && (value === 0 || value === false || (Array.isArray(value) && value.length === 0)))
                return skip(name, partial ? `${why}: a partial scan cannot show an absence` : `${capNote}: a capped scan cannot show an absence`);
            const extra = partial ? `${why}: covers only the part that was read (a count is a lower bound, a minimum an upper bound, a share is of that part only)` : "";
            facts[name] = value;
            evidence[name] = { source: sourceOf(what), method, approx: approx || partial || bounded, notes: [notes, extra, bounded && !partial ? capNote : ""].filter(Boolean).join("; ") };
        };
        const skip = (name, reason) => {
            if (!blind.includes(name))
                blind.push(name);
            evidence[name] = { source: sourceOf("not measured"), method: "not measured", approx: false, notes: reason };
        };
        const tools = [...toolsSeen].sort((a, b) => a - b);
        const multiTool = tools.length > 1 || markersSeen.size > 0;
        const spiral = cfg.spiral_mode === "1" || cfg.spiral_mode === "true";
        const bySeq = cfg.print_sequence === "by object";
        const layersOk = !spiral && !bySeq;
        const travelBlock = !ready ? "the G-code has no config block before the executable block (retraction_minimum_travel unknown)"
            : !Number.isFinite(minTravelOf(tools[0] ?? 0)) ? "retraction_minimum_travel is not in the config"
                : spiral ? "spiral_mode is on: there are no layers or travels to compare"
                    : bySeq ? "print_sequence is by object: the layer order differs from what the detector assumes"
                        : multiTool ? `multi-filament G-code (${tools.length > 1 ? `tools ${tools.join(", ")}` : [...markersSeen].join(", ")}): the purge/tower travel is not the defect the ladder fixes, and no multi-filament sample has validated the detector`
                            : "";
        const anyExtrusion = feats.some(ft => ft.segs > 0);
        const hasHeader = (key) => header[key] !== undefined;
        // layers and mass (cross-checks with the header)
        if (layers > 0)
            put("gcode.layer_count", layers, "executable block", "count of '; CHANGE_LAYER' markers", false, hasHeader("total layer number") ? `header says ${header["total layer number"]}` : "");
        else
            skip("gcode.layer_count", "no '; CHANGE_LAYER' marker: not a Bambu Studio G-code");
        if (anyExtrusion && ready && Number.isFinite(totalGrams) && gPerMm.length)
            put("gcode.extruded_weight_g", r3(totalGrams), "executable block", "sum of E of every extrusion x filament cross-section x density", false, hasHeader("total filament weight [g]") ? `header says ${header["total filament weight [g]"]} g` : "");
        else
            skip("gcode.extruded_weight_g", "no extrusion read, or filament_diameter / filament_density missing from the config");
        // support family, ironing, brim, prime tower: [N] markers, a zero needs the config to say the feature is off
        const sum = (pick, field) => feats.reduce((a, ft) => (pick(ft) ? a + ft[field] : a), 0);
        const supportSeen = feats.some(ft => ft.support && ft.segs > 0);
        const supportOff = complete && (cfg.enable_support === "0" || options.supportUsed === false);
        const supportWhy = "support is enabled (or unknown) but no 'Support*' feature label is in the file; those labels come from the Studio binary and were never seen in a real file, so 0 would be a guess";
        const supportNote = `Support ${sum(ft => ft.support && !ft.interface && !ft.transition, "segs")}, Support interface ${sum(ft => ft.interface, "segs")}, Support transition ${sum(ft => ft.transition, "segs")}`;
        if (supportSeen || supportOff) {
            const zeroWhy = supportSeen ? "" : `no support: ${cfg.enable_support === "0" ? "enable_support = 0 in the G-code's own config" : "slice_info support_used = false"}`;
            put("gcode.support_line_count", sum(ft => ft.support, "segs"), "executable block", "extrusion segments under '; FEATURE: Support*'", false, supportSeen ? supportNote : zeroWhy);
            put("gcode.support_interface_line_count", sum(ft => ft.interface, "segs"), "executable block", "extrusion segments under '; FEATURE: Support interface'", false, supportSeen ? supportNote : zeroWhy);
            if (ready && gPerMm.length)
                put("gcode.support_weight_g", r3(sum(ft => ft.support, "grams")), "executable block", "sum of E of support segments x cross-section x density", false, zeroWhy);
            else
                skip("gcode.support_weight_g", "filament_diameter / filament_density missing from the config");
        }
        else
            for (const name of ["gcode.support_line_count", "gcode.support_interface_line_count", "gcode.support_weight_g"])
                skip(name, supportWhy);
        const ironSeen = feats.some(ft => ft.ironing && ft.segs > 0);
        if (ironSeen || (complete && cfg.ironing_type === "no ironing"))
            put("gcode.ironing_line_count", sum(ft => ft.ironing, "segs"), "executable block", "extrusion segments under '; FEATURE: Ironing' (E > 0)", false, ironSeen ? "" : "ironing_type = no ironing in the G-code's own config");
        else
            skip("gcode.ironing_line_count", "ironing is on (or unknown) but no 'Ironing' feature label is in the file, a label never seen in a real file");
        const towerSeen = feats.some(ft => ft.tower && ft.segs > 0);
        const towerOff = complete && cfg.enable_prime_tower === "0" && !markersSeen.has("WIPE_TOWER_START");
        if ((towerSeen || towerOff) && ready && gPerMm.length) {
            put("gcode.tower_g", r3(sum(ft => ft.tower, "grams")), "executable block", "sum of E under '; FEATURE: Prime tower' x cross-section x density", false, towerSeen ? "" : "enable_prime_tower = 0 in the G-code's own config");
            put("gcode.tower_height_mm", towerSeen ? r3(towerMaxZ) : 0, "executable block", "highest Z of a 'Prime tower' extrusion", false, towerSeen ? "" : "enable_prime_tower = 0 in the G-code's own config");
        }
        else
            for (const name of ["gcode.tower_g", "gcode.tower_height_mm"])
                skip(name, "the prime tower is on (or unknown) but no 'Prime tower' feature label is in the file, a label never seen in a real file");
        // first layer
        const firstDone = layer >= 1 || execEnded;
        const flBlock = !layersOk ? (spiral ? "spiral_mode is on: there is no first layer to read" : "print_sequence is by object: the first layer is not one layer of the plate") : !firstDone ? "the first layer was not read to its end" : flSegs === 0 ? "no extrusion on the first layer" : "";
        for (const name of ["gcode.first_layer_speed_mm_s", "gcode.first_layer_wall_speed_mm_s", "gcode.first_layer_infill_speed_mm_s", "gcode.first_layer_area_mm2", "gcode.first_layer_brim_present", "gcode.first_layer_height_mm"]) {
            if (flBlock) {
                skip(name, flBlock);
                continue;
            }
            switch (name) {
                case "gcode.first_layer_speed_mm_s":
                    put(name, r3(flMax), "executable block", "max F/60 over first-layer extrusions, 'Custom' excluded", false, `speeds seen (mm/s: segments) ${[...flSpeeds].map(([k, v]) => `${k}: ${v}`).join(", ")}`);
                    break;
                case "gcode.first_layer_wall_speed_mm_s":
                    if (flWall > 0)
                        put(name, r3(flWall), "executable block", "max F/60 over first-layer wall extrusions (report only: initial_layer_speed)");
                    else
                        skip(name, "no wall extrusion on the first layer");
                    break;
                case "gcode.first_layer_infill_speed_mm_s":
                    if (flInfill > 0)
                        put(name, r3(flInfill), "executable block", "max F/60 over first-layer infill and surface extrusions (report only: initial_layer_infill_speed)");
                    else
                        skip(name, "no infill extrusion on the first layer");
                    break;
                case "gcode.first_layer_area_mm2":
                    put(name, Math.round(flArea * 10) / 10, "executable block", "sum of segment length x '; LINE_WIDTH' on the first layer, support/brim/skirt/tower/Custom excluded", true, "line overlap inflates it (+2.6% against plate_N.json on the sample): compare rounds, not absolute values; arcs by arc length");
                    break;
                case "gcode.first_layer_height_mm":
                    if (Number.isFinite(flHeight))
                        put(name, flHeight, "executable block", "first '; LAYER_HEIGHT:' after the first '; CHANGE_LAYER'");
                    else
                        skip(name, "no '; LAYER_HEIGHT:' on the first layer");
                    break;
                case "gcode.first_layer_brim_present":
                    if (flBrim)
                        put(name, true, "executable block", "'; FEATURE: Brim' extrusion on the first layer");
                    else if (complete && cfg.brim_type === "no_brim")
                        put(name, false, "executable block", "brim_type = no_brim in the G-code's own config", false, "no 'Brim' label either");
                    else
                        skip(name, "a brim is configured (or unknown) and no 'Brim' feature label is on the first layer; the label comes from the Studio binary and was never seen in a real file");
                    break;
            }
        }
        // flow and widths
        if (flowLen > 0)
            put("gcode.flow_limit_exceeded_share", Number((flowOver / flowLen).toPrecision(6)), "executable block", "length with (E x filament area / length) x F/60 above filament_max_volumetric_speed x 1.001, over the length extruded ('Custom' excluded)", false, `peak ${r3(flowMax)} mm3/s against the limit ${flowLimit}`);
        else
            skip("gcode.flow_limit_exceeded_share", "filament_max_volumetric_speed or the filament diameter is missing from the config, or no extrusion was read");
        if (Number.isFinite(minWallWidth))
            put("gcode.min_line_width_mm", minWallWidth, "executable block", "smallest '; LINE_WIDTH' in force on a wall extrusion (planned width, not measured)", false, "Gap infill excluded");
        else
            skip("gcode.min_line_width_mm", "no wall extrusion was read");
        if (anyExtrusion && layers > 0)
            put("gcode.top_layer_count", topLayers, "executable block", "distinct layers with a 'Top surface' extrusion", false, "not the physical top thickness: sloped surfaces make a top on many layers");
        else
            skip("gcode.top_layer_count", "no layer or extrusion was read");
        // z-hop and travels
        if (!travelBlock && layers > 0) {
            const lifted = styles[1] + styles[2] + styles[3];
            put("gcode.zhop_lift_count", zhopLifts, "executable block", "travels (runs between extrusions) with a Z lift, layer-change lifts excluded", false, `spiral ${styles[1]}, normal ${styles[2]}, slope ${styles[3]}; ${liftsLayerChange} layer-change lifts not counted; ${liftsNoRetract} lifts without a retraction`);
            const hop = (cfg.z_hop_types ?? "").split(",").map(t => t.trim());
            if (cfg.z_hop_types === undefined)
                skip("gcode.zhop_type_mismatch", "z_hop_types is not in the config");
            else if (!hop.every(t => LIFT_STYLE.test(t)))
                put("gcode.zhop_type_mismatch", false, "executable block", "machine z_hop_types is not an explicit Normal/Slope/Spiral Lift, so there is nothing to disagree with", false, `z_hop_types = ${cfg.z_hop_types}${cfg.filament_z_hop_types ? `; filament override ${cfg.filament_z_hop_types}` : ""}`);
            else {
                const machine = hop[extruderOf(tools[0] ?? 0)] ?? hop[0];
                const ranked = [1, 2, 3].sort((a, b) => styles[b] - styles[a]);
                if (new Set(hop).size > 1 && tools.length > 1)
                    skip("gcode.zhop_type_mismatch", "z_hop_types differs per extruder and several tools are used");
                else if (lifted === 0)
                    put("gcode.zhop_type_mismatch", false, "executable block", "no travel lift in the G-code to compare", false, `z_hop_types = ${machine}`);
                else if (styles[ranked[0]] === styles[ranked[1]])
                    skip("gcode.zhop_type_mismatch", "the lift styles tie for the most frequent, so there is no dominant style");
                else
                    put("gcode.zhop_type_mismatch", LIFT_NAME[ranked[0]] !== machine, "executable block", "dominant travel-lift style in the G-code against the machine z_hop_types in the G-code's config", false, `dominant ${LIFT_NAME[ranked[0]]} (${styles[ranked[0]]} of ${lifted}); machine ${machine}`);
            }
            const approx = arcSeen || capped;
            const note = "travel = non-extruding XY run longer than retraction_minimum_travel, no retraction, no lift, not the layer change" + (arcSeen ? "; extrusion arcs enter the crossing test as chords" : "");
            put("gcode.unprotected_travel_count", unprotected, "executable block", "unprotected-travel detector (spec 5.1)", false, `${note}; threshold ${minTravelOf(tools[0] ?? 0)} mm`);
            put("gcode.unprotected_travel_crossing_count", crossing, "executable block", "unprotected travels whose path crosses an already printed wall/support/top/bridge/solid/gap segment of the same layer (4 mm grid)", approx, "Sparse infill is not an obstacle; any origin", capped);
            put("gcode.unprotected_travel_curl_risk_count", curlRisk, "executable block", "crossing travels that cross Overhang wall, Bridge or Top surface", true, "analyzer inference (class I): unweighted count, no severity model", capped);
            put("gcode.unprotected_travels_by_origin", [...byOrigin].sort((a, b) => b[1].unprotected - a[1].unprotected || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}: ${v.unprotected} unprotected, ${v.crossing} crossing`), "executable block", "unprotected travels grouped by the feature of the extrusion before them", approx, "report evidence, never a condition", capped);
            put("gcode.unprotected_travel_over_20mm_count", over20, "executable block", `unprotected travels longer than ${OVER_MM} mm`, false, "report evidence");
            put("gcode.unprotected_travel_max_mm", r3(maxLen), "executable block", "longest unprotected travel", false, `layer ${maxLayer + 1}, Z ${maxZ}; report evidence`);
            if (supportSeen || supportOff)
                put("gcode.unprotected_travels_in_support", inSupport, "executable block", "unprotected travels between two support extrusions of the same support island (ends within 1.5 line widths)", false, supportSeen ? "" : "no support in the file", capped);
            else
                skip("gcode.unprotected_travels_in_support", supportWhy);
        }
        else
            for (const name of ["gcode.zhop_lift_count", "gcode.zhop_type_mismatch", "gcode.unprotected_travel_count", "gcode.unprotected_travel_crossing_count", "gcode.unprotected_travel_curl_risk_count", "gcode.unprotected_travels_by_origin", "gcode.unprotected_travels_in_support", "gcode.unprotected_travel_over_20mm_count", "gcode.unprotected_travel_max_mm"])
                skip(name, travelBlock || "no layer was read");
        // tools and nozzles
        if (ready && polys.length) {
            put("gcode.tool_xy_outside_area_count", outside, "executable block", "end points of G0/G1/G2/G3 between the machine start and end code outside extruder_printable_area of the active extruder (0.01 mm tolerance)", multiTool, multiTool ? "active extruder from T<n> and filament_map, never validated on a real multi-filament file" : "");
        }
        else
            skip("gcode.tool_xy_outside_area_count", cfg.extruder_printable_area ? `extruder_printable_area is malformed or has more than ${limits.polyVertices} vertices` : "extruder_printable_area is not in the config, or the print was not read to its end");
        const auxPairs = [["gcode.aux_nozzle_max_extrusion_feedrate_mm_s", extFeed], ["gcode.aux_nozzle_max_extrusion_accel_mm_s2", extAccel]];
        for (const [name, arr] of auxPairs) {
            if (extSegs[1] > 0)
                put(name, r3(arr[1]), "executable block", "max over extrusions whose tool maps to extruder 2 (filament_map)", true, "tool -> filament -> extruder mapping inferred, never validated on a real file");
            else if (complete && options.auxExtruderUsed === false)
                put(name, 0, "slice_info + executable block", "no used filament maps to extruder 2 (slice_info filament_maps) and no extrusion used it", false, "known zero by the spec's shortcut");
            else
                skip(name, "no extrusion with the aux nozzle was read and slice_info does not say it is unused");
        }
        // purge and waste
        if (flushLines > 0) {
            if (ready && gPerMm.length)
                put("gcode.purge_g", r3(flushLen * (gPerMm[0] ?? 0)), "executable block", "sum of L of every 'M620.10 .. L<mm>' x cross-section x density", true, `${flushLines} flush commands; the A0/A1 pairing per change is unvalidated, so this may count a change twice`);
            else
                skip("gcode.purge_g", "filament_diameter / filament_density missing from the config");
            skip("gcode.flush_length_mismatch_count", "M620.10 L commands are present but how each maps to a flush_volumes_matrix cell has never been observed in a real file");
        }
        else if (complete && toolChanges === 0 && !multiTool) {
            put("gcode.purge_g", 0, "executable block", "no tool change and no 'M620.10 .. L' command in the whole file", false, "single filament");
            put("gcode.flush_length_mismatch_count", 0, "executable block", "no 'M620.10 .. L' command in the whole file", false, "single filament");
        }
        else
            for (const name of ["gcode.purge_g", "gcode.flush_length_mismatch_count"])
                skip(name, "no 'M620.10 .. L' command was read but the file is truncated, or it changes tools without them: the flush format was never seen in a real file");
        if (complete)
            put("plate.tool_changes", toolChanges, "executable block", "T<n> (n < 254) selections after the machine start code that change the tool", toolChanges > 0, toolChanges ? "counted from T<n> lines, never validated on a real multi-filament X2D file" : "single tool");
        else
            skip("plate.tool_changes", "the file is truncated: a tool change may come later");
        if (facts["gcode.purge_g"] !== undefined && facts["gcode.tower_g"] !== undefined) {
            put("plate.waste_weight_g", r3(facts["gcode.purge_g"] + facts["gcode.tower_g"]), "executable block", "gcode.purge_g + gcode.tower_g", evidence["gcode.purge_g"].approx || evidence["gcode.tower_g"].approx);
        }
        else
            skip("plate.waste_weight_g", "purge or prime tower weight is not known");
        skip("gcode.missing_thin_feature_count", "needs the part mesh as well as the G-code (a mesh + G-code fact); this scan does not read the mesh");
        for (const name of GCODE_SCAN_FACTS)
            if (facts[name] === undefined && !blind.includes(name))
                skip(name, "not measured");
        if (unknownFeatures.length)
            evidence["gcode.layer_count"] = { ...evidence["gcode.layer_count"], notes: `${evidence["gcode.layer_count"]?.notes ?? ""}; unrecognised feature labels: ${unknownFeatures.join(", ")}`.replace(/^; /, "") };
        blind.sort();
        const num = (key) => { const v = Number.parseFloat(header[key] ?? ""); return Number.isFinite(v) ? v : undefined; };
        const time = /(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/.exec(header.total_estimated_time ?? "");
        const estimatedTimeS = header.total_estimated_time && time ? (Number(time[1] ?? 0) * 86400 + Number(time[2] ?? 0) * 3600 + Number(time[3] ?? 0) * 60 + Number(time[4] ?? 0)) : undefined;
        const details = {
            objectObservations: Object.fromEntries([...objectObservations].map(([id, o]) => { const { starts, stops, heightMarkersComplete, ...observed } = o; return [id, { ...observed, layer_heights_complete: complete && badWords === 0 && objectLabelsValid && starts === stops && heightMarkersComplete && observed.min_layer_height_mm !== undefined, complete: complete && badWords === 0 && objectLabelsValid && currentObject === undefined && starts === stops && observed.extrusion_segments > 0 }]; })),
            layerHeights: { all: { min_mm: Number.isFinite(minLayerHeight) ? minLayerHeight : null, max_mm: Number.isFinite(maxLayerHeight) ? maxLayerHeight : null, complete: complete && badWords === 0 && unknownFeatures.length === 0 && modelHeightMarkersValid && layerHeightLayers > 0, layers_observed: layerHeightLayers, excludes_first_layer: true } },
            header: { studioVersion: header.studio_version, estimatedTimeS, weightG: num("total filament weight [g]"), layers: num("total layer number"), maxZ: num("max_z_height") },
            layers, tools,
            features: Object.fromEntries(feats.filter(ft => ft.segs > 0).map(ft => [ft.name, { segments: ft.segs, weight_g: r3(ft.grams) }])),
            unknownFeatures,
            lifts: { spiral: lifts[1], normal: lifts[2], slope: lifts[3], layerChange: liftsLayerChange, withoutRetract: liftsNoRetract },
            runs, retractRuns,
            unprotected: {
                total: unprotected, crossing, crossingSevere, curlRisk, over20mm: over20, inSupport, belowMin, maxMm: maxLen, maxLayer, maxZ, layerChange: unprotLayerChange,
                byOrigin: Object.fromEntries(byOrigin), crossedRoles: Object.fromEntries(crossedRoles), afterSparseSevere, work,
            },
            firstLayer: { segments: flSegs, speeds: Object.fromEntries(flSpeeds), areaMm2: flArea },
            flow: { maxMm3s: flowMax, limit: flowLimit },
            skipped: { longLines, badWords, gridSegments: gridSkipped, crossingRuns: crossSkipped, blockLines },
        };
        stats.ms += performance.now() - t0;
        return { facts, evidence, complete, blind, stats, details };
    }
    return {
        line(s) {
            lines++;
            if (block === EXEC)
                exec(s);
            else
                outerLine(s);
        },
        tooLong() { longLines++; },
        get lines() { return lines; },
        finish,
    };
}
/** Scan an async stream of chunks (a file read stream, or an entry stream of an archive). Lines up to 64 KB, LF or CRLF. */
export async function scanGcodeStream(chunks, options = {}) {
    const start = performance.now();
    const maxBytes = options.maxBytes ?? MAX_PRINT_FILE_BYTES;
    const scanner = createGcodeScanner(options);
    let bytes = 0;
    let carry = null;
    let discarding = false; // inside a line that already passed 64 KB: drop it up to its newline
    for await (const raw of chunks) {
        options.signal?.throwIfAborted();
        let buf = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
        bytes += buf.length;
        if (bytes > maxBytes)
            throw new Error(`G-code scan: input exceeds the ${Math.round(maxBytes / 2 ** 20)} MiB inspection limit`);
        if (discarding) {
            const nl = buf.indexOf(10);
            if (nl < 0)
                continue;
            discarding = false;
            buf = buf.subarray(nl + 1);
        }
        if (carry) {
            buf = Buffer.concat([carry, buf]);
            carry = null;
        }
        const last = buf.lastIndexOf(10);
        if (last >= 0) {
            // decode the complete lines of the chunk at once (a newline never splits a UTF-8 character), then cut them by hand
            const text = buf.toString("utf8", 0, last);
            for (let from = 0; from <= text.length;) {
                let nl = text.indexOf("\n", from);
                if (nl < 0)
                    nl = text.length;
                const end = nl > from && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
                if (end - from > MAX_LINE)
                    scanner.tooLong();
                else
                    scanner.line(text.slice(from, end));
                from = nl + 1;
            }
        }
        const rest = buf.subarray(last + 1);
        if (rest.length > MAX_LINE) {
            scanner.tooLong();
            discarding = true;
        }
        else if (rest.length)
            carry = Buffer.from(rest); // copy: do not keep the whole chunk alive
    }
    // an unterminated last line is a cut file: only a comment is safe to read (a cut command could carry a wrong number)
    if (carry && carry.length && !discarding) {
        const text = carry.toString("utf8");
        if (text.trimStart().startsWith(";"))
            scanner.line(text.trimEnd());
    }
    const stats = { lines: scanner.lines, bytes, ms: 0 };
    const result = scanner.finish(stats);
    stats.ms = Math.round(performance.now() - start);
    return result;
}
export async function scanGcodeFile(filePath, options = {}) {
    const info = await stat(filePath);
    if (!info.isFile())
        throw new Error("G-code scan: input must be a regular file");
    if (info.size > (options.maxBytes ?? MAX_PRINT_FILE_BYTES))
        throw new Error("G-code scan: file exceeds the 256 MiB inspection limit");
    return scanGcodeStream(createReadStream(filePath, { highWaterMark: 256 * 1024 }), { source: basename(filePath), ...options });
}
/** Scan Metadata/plate_N.gcode (N = plateIndex + 1) of a sliced .3mf without inflating it into one buffer. */
export async function scanPlateGcode(threeMfPath, plateIndex, options = {}) {
    const name = `Metadata/plate_${plateIndex + 1}.gcode`;
    const stream = await streamSafe3mfEntryFromFile(threeMfPath, name);
    return scanGcodeStream(stream, { source: `${basename(threeMfPath)}:${name}`, ...options });
}
