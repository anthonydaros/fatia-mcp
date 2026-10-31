// applies_to predicates ("<2.8.2", ">=2.8", "2.8.x", "02.08.04.57", "2.7.1, 2.8.2.61") against an installed version.
import { normalizeVersion } from "../slicer/slicer-info.js";
const CLAUSE = /^(<=|>=|<|>|=)?\s*v?((?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,3})$/;
/**
 * Comma = OR. A clause is `[op]version`, version = 1 to 4 dot segments, "x" or "*" is a wildcard, leading zeros are
 * ignored ("02.08" = "2.8"). Without an operator the clause matches the segments it names ("2.7.1" is any 2.7.1.*,
 * "2.8.4.57" is that exact build). With an operator missing segments count as 0 ("<2.8.2" = "<2.8.2.0"); wildcards are
 * only allowed without an operator or with "=". null = not parseable.
 */
export function parseVersionPredicate(text) {
    const clauses = [];
    for (const part of String(text).split(",")) {
        const m = CLAUSE.exec(part.trim());
        if (!m)
            return null;
        const segs = m[2].split(".").map(s => (/^\d+$/.test(s) ? Number(s) : null));
        const op = (m[1] ?? "");
        if (segs.includes(null) && op !== "" && op !== "=")
            return null;
        clauses.push({ op, segs });
    }
    return clauses;
}
/** "v02.08.04.57" -> [2, 8, 4, 57]; null when any segment is not a plain number. */
function parseInstalled(version) {
    const parts = normalizeVersion(version).split(".");
    return parts.every(p => /^\d+$/.test(p)) ? parts.map(Number) : null;
}
function cmpSegments(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length, 4); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d)
            return d < 0 ? -1 : 1;
    }
    return 0;
}
function clauseMatches({ op, segs }, installed) {
    if (op === "" || op === "=") {
        const named = op === "" ? segs : [...segs, 0, 0, 0, 0].slice(0, Math.max(4, segs.length));
        return named.every((s, i) => s === null || s === (installed[i] ?? 0));
    }
    const c = cmpSegments(installed, segs);
    return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0;
}
/** unknown = no installed version, or a predicate/version that does not parse. */
export function matchVersion(predicate, installed) {
    const clauses = parseVersionPredicate(predicate);
    const have = installed ? parseInstalled(installed) : null;
    if (!clauses || !have)
        return "unknown";
    return clauses.some(c => clauseMatches(c, have)) ? "applies" : "not_applies";
}
/** Every key of applies_to must hold; `installed` maps the key ("bambu_studio", "blender") to the installed version. */
export function appliesTo(appliesTo, installed) {
    if (!appliesTo)
        return "applies";
    const states = Object.entries(appliesTo).map(([key, predicate]) => matchVersion(predicate, installed[key]));
    return states.includes("not_applies") ? "not_applies" : states.includes("unknown") ? "unknown" : "applies";
}
