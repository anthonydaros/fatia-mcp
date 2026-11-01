/** Key -> text after " = ", exactly as the G-code prints it. Undefined when the text has no complete block. */
export declare function readConfigBlock(gcode: string): Record<string, string> | undefined;
/**
 * The elements of a project value that the block must show for `key`: the block keeps one value per extruder (process and printer
 * vectors, picked by the extruder's id and variant) or one per filament (filament vectors, picked by the filament's variant).
 * Undefined when the project's list does not line up with what the block says (then the key cannot be compared, not "wrong").
 */
export declare function expectedBlockElements(config: Record<string, unknown>, block: Record<string, string>, key: string, scope: "process" | "filament" | "printer"): string[] | undefined;
export interface BlockCheck {
    key: string;
    expected: string[] | null;
    actual: string | null;
    ok: boolean | null;
}
/**
 * Compare the tuned value of one key with the block: ok true (every shown element equals the tuned one, numbers compared as numbers),
 * false (the slice used another value), null (the block lacks the key or the list cannot be lined up: unverified, never "ok").
 */
export declare function checkBlockValue(config: Record<string, unknown>, block: Record<string, string>, key: string, scope: "process" | "filament" | "printer"): BlockCheck;
