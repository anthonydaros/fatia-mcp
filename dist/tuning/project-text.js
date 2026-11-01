export const MAX_TEXT_CHARS = 32 * 2 ** 20; // far above any real metadata file (the 17-plate sample is 66 KB)
const KEY = /^[A-Za-z0-9_]+$/;
const BAD_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
/** A key and a value as Studio stores them; anything else cannot be written safely. */
export function assertWritable(key, value) {
    if (!KEY.test(key))
        throw new Error(`Unsafe setting key ${JSON.stringify(key)}.`);
    for (const v of Array.isArray(value) ? value : [value]) {
        if (typeof v !== "string" || BAD_CHARS.test(v))
            throw new Error(`Setting ${key}: values must be strings without control characters.`);
    }
}
/** Where every top-level member of a JSON object starts and ends (and every element of its array value). */
function scanObject(text) {
    if (text.length > MAX_TEXT_CHARS)
        throw new Error("JSON file is too large to edit.");
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const fail = (what) => { throw new Error(`Invalid JSON object at offset ${i}: ${what}.`); };
    const ws = () => { while (i < text.length && " \t\r\n".includes(text[i]))
        i++; };
    const string = () => {
        const start = i;
        if (text[i] !== '"')
            fail("a string was expected");
        i++;
        while (i < text.length && text[i] !== '"')
            i += text[i] === "\\" ? 2 : 1;
        if (i >= text.length)
            fail("unterminated string");
        return { start, end: ++i };
    };
    const value = () => {
        const start = i;
        if (text[i] === '"')
            return string();
        if (text[i] === "[" || text[i] === "{") {
            let depth = 0;
            do {
                if (text[i] === '"') {
                    string();
                    continue;
                }
                depth += "[{".includes(text[i]) ? 1 : "]}".includes(text[i]) ? -1 : 0;
                i++;
            } while (depth > 0 && i < text.length);
            if (depth > 0)
                fail("unterminated value");
            return { start, end: i };
        }
        while (i < text.length && !",]} \t\r\n".includes(text[i]))
            i++;
        if (i === start)
            fail("a value was expected");
        return { start, end: i };
    };
    ws();
    if (text[i] !== "{")
        fail("an object was expected");
    const open = i++;
    const members = new Map();
    let last = -1;
    let indent = "    ";
    ws();
    while (text[i] !== "}") {
        if (text[i] === undefined)
            fail("unterminated object");
        const key = string();
        if (members.size === 0) {
            const before = text.slice(text.lastIndexOf("\n", key.start) + 1, key.start);
            if (/^[ \t]*$/.test(before))
                indent = before;
        }
        ws();
        if (text[i] !== ":")
            fail("a colon was expected");
        i++;
        ws();
        const span = value();
        const member = { value: span };
        if (text[span.start] === "[") {
            const after = i;
            i = span.start + 1;
            member.elements = [];
            ws();
            while (text[i] !== "]") {
                member.elements.push(value());
                ws();
                if (text[i] === ",") {
                    i++;
                    ws();
                }
                else if (text[i] !== "]")
                    fail("a comma was expected in a list");
            }
            i = after;
        }
        members.set(JSON.parse(text.slice(key.start, key.end)), member);
        last = span.end;
        ws();
        if (text[i] === ",") {
            i++;
            ws();
        }
        else if (text[i] !== "}")
            fail("a comma was expected");
    }
    return { members, open, last, indent, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}
function applyEdits(text, edits) {
    const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
    for (let k = 1; k < sorted.length; k++)
        if (sorted[k].end > sorted[k - 1].start)
            throw new Error("Overlapping edits.");
    return sorted.reduce((out, e) => out.slice(0, e.start) + e.text + out.slice(e.end), text);
}
/** A list laid out the way `original` was (one element per line at the same indent, or inline), with new elements. */
function layoutList(original, values, scan) {
    const items = values.map(v => JSON.stringify(v));
    const multi = original === undefined ? scan.indent !== "" || scan.eol === "\r\n" : original.includes("\n");
    if (!multi)
        return `[${items.join(original?.includes('", "') ? ", " : ",")}]`;
    const closeIndent = original === undefined ? scan.indent : original.slice(original.lastIndexOf("\n") + 1, original.lastIndexOf("]"));
    const itemIndent = /\[\s*?\r?\n([ \t]*)/.exec(original ?? "")?.[1] ?? `${closeIndent}    `;
    return `[${scan.eol}${items.map(item => itemIndent + item).join(`,${scan.eol}`)}${scan.eol}${closeIndent}]`;
}
/**
 * Set top-level members of a JSON object text. A list keeps its layout and, when the length is unchanged, every element
 * whose value is unchanged keeps its bytes; a new key is appended after the last member. Returns the new text.
 */
export function setMembers(text, values) {
    const scan = scanObject(text);
    const edits = [];
    let appended = "";
    for (const [key, value] of Object.entries(values)) {
        assertWritable(key, value);
        const member = scan.members.get(key);
        if (!member) {
            appended += `${scan.members.size + appended.length === 0 ? "" : ","}${scan.eol}${scan.indent}${JSON.stringify(key)}: ${Array.isArray(value) ? layoutList(undefined, value, scan) : JSON.stringify(value)}`;
            continue;
        }
        const original = text.slice(member.value.start, member.value.end);
        if (Array.isArray(value)) {
            if (!member.elements)
                throw new Error(`Setting ${key} is not a list in the project.`);
            if (member.elements.length !== value.length) {
                edits.push({ ...member.value, text: layoutList(original, value, scan) });
            }
            else {
                value.forEach((v, j) => {
                    const span = member.elements[j];
                    if (JSON.parse(text.slice(span.start, span.end)) !== v)
                        edits.push({ ...span, text: JSON.stringify(v) });
                });
            }
        }
        else {
            if (member.elements)
                throw new Error(`Setting ${key} is a list in the project; give one value per element or a scalar to fill it.`);
            if (JSON.parse(original) !== value)
                edits.push({ ...member.value, text: JSON.stringify(value) });
        }
    }
    if (appended) {
        const at = scan.last >= 0 ? scan.last : scan.open + 1;
        edits.push({ start: at, end: at, text: appended + (scan.last < 0 ? scan.eol : "") });
    }
    return applyEdits(text, edits);
}
/** The value a change writes: a scalar fills every element of a list (or only those `elements` selects); a list must keep its length. */
export function resolveValue(key, base, value, config, elements) {
    if (!Array.isArray(base)) {
        if (Array.isArray(value))
            throw new Error(`Setting ${key} is a scalar in the project; a list was given.`);
        if (elements)
            throw new Error(`Setting ${key}: "elements" needs a list-valued key.`);
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length !== base.length)
            throw new Error(`Setting ${key}: ${value.length} values given for a list of ${base.length}.`);
        return value;
    }
    if (!elements)
        return base.map(() => value);
    const labels = config[elements.index_by];
    if (!Array.isArray(labels) || labels.length !== base.length) {
        throw new Error(`Setting ${key}: "elements" needs the aligned list ${elements.index_by} (${base.length} entries) in the project.`);
    }
    const selected = labels.map(label => String(label).startsWith(elements.starts_with));
    if (!selected.some(Boolean))
        throw new Error(`Setting ${key}: no element of ${elements.index_by} starts with "${elements.starts_with}".`);
    return base.map((old, i) => (selected[i] ? value : old));
}
/* ---------------------------------- XML ---------------------------------- */
const xmlEscape = (s) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const xmlUnescape = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e]);
const attr = (s, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1];
export const MAX_OBJECTS = 5000; // a plate holds dozens; the cap keeps a hostile file from making every later step slow
/** The <object> blocks of model_settings.config; `header` is the object's own metadata (before its first <part>). One forward pass, no regex over the whole text. */
export function listObjects(xml) {
    if (xml.length > MAX_TEXT_CHARS)
        throw new Error("model_settings.config is too large to edit.");
    const objects = [];
    let pos = 0;
    for (;;) {
        const start = xml.indexOf("<object", pos);
        if (start < 0)
            break;
        pos = start + 7;
        if (!/\s/.test(xml[pos] ?? ""))
            continue; // <objects>, <object_x>
        const tagEnd = xml.indexOf(">", pos);
        if (tagEnd < 0)
            throw new Error("model_settings.config has an unterminated <object> tag.");
        pos = tagEnd + 1;
        if (xml[tagEnd - 1] === "/")
            continue; // <object .../> holds nothing
        const end = xml.indexOf("</object>", pos);
        if (end < 0)
            throw new Error("model_settings.config has an unterminated <object>.");
        const part = xml.slice(pos, end).indexOf("<part");
        const header = { start: pos, end: part >= 0 ? pos + part : end };
        pos = end + 9;
        const id = attr(xml.slice(start + 7, tagEnd), "id");
        if (id === undefined)
            continue;
        if (objects.length >= MAX_OBJECTS)
            throw new Error(`model_settings.config has more than ${MAX_OBJECTS} objects.`);
        const name = /<metadata\s+key="name"\s+value="([^"]*)"/.exec(xml.slice(header.start, header.end))?.[1];
        objects.push({ id: xmlUnescape(id), name: name === undefined ? undefined : xmlUnescape(name), start, end, header });
    }
    return objects;
}
/** Set per-object settings (`<metadata key=".." value=".."/>` inside the object, as Studio stores an object's own config). */
export function setObjectSettings(xml, targets, settings) {
    const done = [];
    const edits = [];
    for (const object of targets) {
        const header = xml.slice(object.header.start, object.header.end);
        let insertAt = -1;
        let indent = "    ";
        for (const m of header.matchAll(/([ \t]{0,16})<metadata\s+key="[^"<>]*"[^<>]*\/>/g)) {
            insertAt = object.header.start + m.index + m[0].length;
            indent = m[1];
        }
        const eol = xml.includes("\r\n") ? "\r\n" : "\n";
        let appended = "";
        for (const [key, value] of Object.entries(settings)) {
            assertWritable(key, value);
            const found = new RegExp(`(<metadata\\s+key="${key}"\\s+value=")([^"]*)(")`).exec(header);
            const from = found ? xmlUnescape(found[2]) : null;
            if (found) {
                if (from !== value)
                    edits.push({ start: object.header.start + found.index + found[1].length, end: object.header.start + found.index + found[1].length + found[2].length, text: xmlEscape(value) });
            }
            else {
                appended += `${eol}${indent}<metadata key="${key}" value="${xmlEscape(value)}"/>`;
            }
            if (from !== value)
                done.push({ object: object.id, name: object.name, key, from, to: value });
        }
        if (appended) {
            if (insertAt < 0)
                throw new Error(`Object ${object.id} has no <metadata> to place an override after.`);
            edits.push({ start: insertAt, end: insertAt, text: appended });
        }
    }
    return { xml: applyEdits(xml, edits), edits: done };
}
/** The plate's gcode_file reference is a slice result: Studio writes it empty for an unsliced plate. */
export function blankGcodeFiles(xml) {
    return xml.replace(/(<metadata\s+key="gcode_file"\s+value=")[^"]+(")/g, "$1$2");
}
const EMPTY_GROUPING = '{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]}';
/**
 * filament_sequence.json holds, per plate, the slicer's filament-to-nozzle grouping from the last slice (a slice result); Studio's unsliced
 * export and a never-sliced project hold the empty form for every plate. Returns that form, or undefined when the file already is it.
 * Throws when the text is not a JSON object.
 */
export function blankFilamentSequence(json) {
    if (json.length > MAX_TEXT_CHARS)
        throw new Error("filament_sequence.json is too large to edit.");
    const plates = JSON.parse(json.replace(/^\uFEFF/, ""));
    if (!plates || typeof plates !== "object" || Array.isArray(plates))
        throw new Error("filament_sequence.json is not a JSON object.");
    const keys = Object.keys(plates);
    if (keys.every(key => JSON.stringify(plates[key]) === EMPTY_GROUPING))
        return undefined;
    return `{${keys.map(key => `${JSON.stringify(key)}:${EMPTY_GROUPING}`).join(",")}}`;
}
/** `from` moved back over the spaces and tabs that indent it (never before `floor`). */
function indentStart(xml, from, floor) {
    while (from > floor && (xml[from - 1] === " " || xml[from - 1] === "\t"))
        from--;
    return from;
}
/** `from` moved forward over trailing spaces and tabs and one line break. */
function lineEnd(xml, from) {
    while (xml[from] === " " || xml[from] === "\t")
        from++;
    if (xml[from] === "\r")
        from++;
    if (xml[from] === "\n")
        from++;
    return from;
}
/** slice_info.config without its <plate> results: the header (client type and version) is all an unsliced project carries. */
export function stripSliceResults(xml) {
    let out = "";
    let pos = 0;
    for (;;) {
        const open = xml.indexOf("<plate>", pos);
        const close = open < 0 ? -1 : xml.indexOf("</plate>", open);
        if (close < 0)
            break;
        out += xml.slice(pos, indentStart(xml, open, pos));
        pos = lineEnd(xml, close + 8);
    }
    return out + xml.slice(pos);
}
/** A relationships part without the relationships that point at removed entries; undefined when none is left. */
export function dropRelationships(xml, removed) {
    let out = "";
    let pos = 0;
    let from = 0;
    for (;;) {
        const open = xml.indexOf("<Relationship", from);
        if (open < 0)
            break;
        from = open + 13;
        if (/\w/.test(xml[from] ?? ""))
            continue; // <Relationships>
        const tagEnd = xml.indexOf(">", from);
        if (tagEnd < 0)
            break;
        from = tagEnd + 1;
        if (xml[tagEnd - 1] !== "/")
            continue;
        const target = attr(xml.slice(open, from), "Target");
        if (target === undefined || !removed.has(xmlUnescape(target).replace(/^\//, "")))
            continue;
        out += xml.slice(pos, indentStart(xml, open, pos));
        pos = from = lineEnd(xml, from);
    }
    out += xml.slice(pos);
    return /<Relationship\b/.test(out) ? out : undefined;
}
