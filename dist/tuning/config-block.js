// What a sliced G-code says about the settings it was sliced with: the CONFIG_BLOCK at the top of the file (real X2D plate:
// lines 17-602, "; key = value", ~585 keys, vectors already resolved to the extruders and filaments the plate uses).
import { same } from "./engine.js";
const HEAD_CHARS = 4 * 2 ** 20; // the block is at the top; never scan a 40 MB plate for it
/** Key -> text after " = ", exactly as the G-code prints it. Undefined when the text has no complete block. */
export function readConfigBlock(gcode) {
    const head = gcode.slice(0, HEAD_CHARS);
    const start = head.indexOf("; CONFIG_BLOCK_START");
    const end = head.indexOf("; CONFIG_BLOCK_END", start);
    if (start < 0 || end < 0)
        return undefined;
    const block = {};
    for (const line of head.slice(start, end).split(/\r?\n/)) {
        const m = /^; ([A-Za-z0-9_.]+) = (.*)$/.exec(line);
        if (m)
            block[m[1]] = m[2];
    }
    return block;
}
const unquote = (text) => (text ?? "").split(/[;,]/).map(part => part.replace(/^"|"$/g, ""));
/**
 * The elements of a project value that the block must show for `key`: the block keeps one value per extruder (process and printer
 * vectors, picked by the extruder's id and variant) or one per filament (filament vectors, picked by the filament's variant).
 * Undefined when the project's list does not line up with what the block says (then the key cannot be compared, not "wrong").
 */
export function expectedBlockElements(config, block, key, scope) {
    const value = config[key];
    if (!Array.isArray(value))
        return typeof value === "string" ? [value] : undefined;
    const texts = value.map(String);
    if (scope === "filament") {
        const labels = config.filament_extruder_variant;
        const filaments = Array.isArray(config.filament_settings_id) ? config.filament_settings_id.length : 0;
        if (texts.length === filaments)
            return texts;
        if (!Array.isArray(labels) || labels.length !== texts.length || filaments === 0 || texts.length % filaments)
            return undefined;
        const per = texts.length / filaments;
        const used = unquote(block.filament_extruder_variant);
        const picked = used.map((label, f) => {
            const j = labels.slice(f * per, (f + 1) * per).indexOf(label);
            return j < 0 ? undefined : texts[f * per + j];
        });
        return picked.length === filaments && picked.every(v => v !== undefined) ? picked : undefined;
    }
    const prefix = scope === "process" ? "print" : "printer";
    const [labels, ids] = [config[`${prefix}_extruder_variant`], config[`${prefix}_extruder_id`]];
    const [usedLabels, usedIds] = [unquote(block[`${prefix}_extruder_variant`]), unquote(block[`${prefix}_extruder_id`])];
    if (!Array.isArray(labels) || !Array.isArray(ids) || labels.length !== texts.length)
        return texts.length === usedIds.length ? texts : undefined;
    const picked = usedLabels.map((label, e) => texts[labels.findIndex((l, j) => l === label && String(ids[j]) === usedIds[e])]);
    return picked.length > 0 && picked.every(v => v !== undefined) ? picked : undefined;
}
/**
 * Compare the tuned value of one key with the block: ok true (every shown element equals the tuned one, numbers compared as numbers),
 * false (the slice used another value), null (the block lacks the key or the list cannot be lined up: unverified, never "ok").
 */
export function checkBlockValue(config, block, key, scope) {
    const expected = expectedBlockElements(config, block, key, scope) ?? null;
    const actual = block[key] ?? null;
    if (!expected || actual === null)
        return { key, expected, actual, ok: null };
    const shown = unquote(actual);
    return { key, expected, actual, ok: shown.length === expected.length && shown.every((s, i) => same(s, expected[i])) };
}
