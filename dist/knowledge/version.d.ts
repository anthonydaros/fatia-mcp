export type VersionStatus = "applies" | "not_applies" | "unknown";
type Op = "" | "=" | "<" | "<=" | ">" | ">=";
/** null segment = wildcard (x). */
export interface VersionClause {
    op: Op;
    segs: Array<number | null>;
}
/**
 * Comma = OR. A clause is `[op]version`, version = 1 to 4 dot segments, "x" or "*" is a wildcard, leading zeros are
 * ignored ("02.08" = "2.8"). Without an operator the clause matches the segments it names ("2.7.1" is any 2.7.1.*,
 * "2.8.4.57" is that exact build). With an operator missing segments count as 0 ("<2.8.2" = "<2.8.2.0"); wildcards are
 * only allowed without an operator or with "=". null = not parseable.
 */
export declare function parseVersionPredicate(text: string): VersionClause[] | null;
/** unknown = no installed version, or a predicate/version that does not parse. */
export declare function matchVersion(predicate: string, installed: string | null | undefined): VersionStatus;
/** Every key of applies_to must hold; `installed` maps the key ("bambu_studio", "blender") to the installed version. */
export declare function appliesTo(appliesTo: Record<string, string> | null, installed: Record<string, string | null | undefined>): VersionStatus;
export {};
