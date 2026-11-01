import type { Elements, SettingValue } from "./types.js";
export declare const MAX_TEXT_CHARS: number;
/** A key and a value as Studio stores them; anything else cannot be written safely. */
export declare function assertWritable(key: string, value: SettingValue): void;
interface Span {
    start: number;
    end: number;
}
/**
 * Set top-level members of a JSON object text. A list keeps its layout and, when the length is unchanged, every element
 * whose value is unchanged keeps its bytes; a new key is appended after the last member. Returns the new text.
 */
export declare function setMembers(text: string, values: Record<string, SettingValue>): string;
/** The value a change writes: a scalar fills every element of a list (or only those `elements` selects); a list must keep its length. */
export declare function resolveValue(key: string, base: SettingValue | undefined, value: SettingValue, config: Record<string, unknown>, elements?: Elements): SettingValue;
export interface ModelObject {
    id: string;
    name: string | undefined;
    start: number;
    end: number;
    header: Span;
}
export declare const MAX_OBJECTS = 5000;
/** The <object> blocks of model_settings.config; `header` is the object's own metadata (before its first <part>). One forward pass, no regex over the whole text. */
export declare function listObjects(xml: string): ModelObject[];
export interface ObjectEdit {
    object: string;
    name: string | undefined;
    key: string;
    from: string | null;
    to: string;
}
/** Set per-object settings (`<metadata key=".." value=".."/>` inside the object, as Studio stores an object's own config). */
export declare function setObjectSettings(xml: string, targets: ModelObject[], settings: Record<string, string>): {
    xml: string;
    edits: ObjectEdit[];
};
/** The plate's gcode_file reference is a slice result: Studio writes it empty for an unsliced plate. */
export declare function blankGcodeFiles(xml: string): string;
/**
 * filament_sequence.json holds, per plate, the slicer's filament-to-nozzle grouping from the last slice (a slice result); Studio's unsliced
 * export and a never-sliced project hold the empty form for every plate. Returns that form, or undefined when the file already is it.
 * Throws when the text is not a JSON object.
 */
export declare function blankFilamentSequence(json: string): string | undefined;
/** slice_info.config without its <plate> results: the header (client type and version) is all an unsliced project carries. */
export declare function stripSliceResults(xml: string): string;
/** A relationships part without the relationships that point at removed entries; undefined when none is left. */
export declare function dropRelationships(xml: string, removed: ReadonlySet<string>): string | undefined;
export {};
