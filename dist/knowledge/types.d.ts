export type Confidence = "preset" | "oficial" | "bug conhecido" | "teste de revisor" | "relato" | "hipotese" | "nao verificado";
export type Severity = "blocker" | "warning" | "tip";
export type Stage = "pre-slice" | "project-settings" | "post-slice-gcode" | "blender-prep" | "material" | "hardware";
export type Op = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "exists" | "matches" | "any_eq";
export type Condition = {
    all: Condition[];
} | {
    any: Condition[];
} | {
    not: Condition;
} | {
    fact: string;
    op: Op;
    value?: unknown;
};
/** A scalar, or a list of scalars (per-filament / per-extruder settings). null = known absent; missing key = unknown. */
export type Scalar = string | number | boolean;
export type FactValue = Scalar | Scalar[] | null;
export type Facts = Record<string, FactValue | undefined>;
export interface Topic {
    id: string;
    domain: "bambu" | "blender" | "both";
    title: string;
    tags: string[];
    symptoms: string[];
    printers: string[];
    applies_to: Record<string, string> | null;
    confidence: Confidence;
    body: string;
    src: string[];
}
export interface Rule {
    id: string;
    domain: "bambu" | "blender";
    title: string;
    severity: Severity;
    stage: Stage;
    detect: {
        method: string;
        when?: Condition | null;
        when_text: string;
        facts: string[];
    };
    problem: string;
    solution: {
        settings: Record<string, string> | null;
        steps: string[];
        message: string;
    };
    confidence: Confidence;
    auto_apply: boolean;
    printers: string[];
    applies_to: Record<string, string> | null;
    topic: string;
    src: string[];
}
export interface Fact {
    name: string;
    description: string;
    source_of_truth: string;
    cost: "free" | "cheap" | "expensive";
}
export interface Manifest {
    kb_version: string;
    counts: Record<string, number>;
    files: Record<string, string>;
    sources: Record<string, string>;
}
/** The metadata of an opened 3MF that tier-1 facts read. XML parts are parsed with xml2js (explicitArray: false, mergeAttrs: true). */
export interface ProjectFiles {
    /** Metadata/project_settings.config exactly as Studio wrote it (strings and lists of strings). */
    config?: Record<string, unknown>;
    /** Why config is missing: no such file, or it is not a JSON object. */
    configProblem?: string;
    /** Root <config> of Metadata/slice_info.config (header, and a <plate> per slice when sliced). */
    sliceInfo?: any;
    /** Root <config> of Metadata/model_settings.config (objects, parts and plates). */
    modelSettings?: any;
    /** Entry names of the archive. */
    names?: string[];
    /** The bytes of one entry of the safely opened archive, cut to maxBytes; undefined when absent. */
    read?: (name: string, maxBytes?: number) => Promise<Buffer | undefined>;
}
/** The fields of STLManipulator.getSTLInfo that the box facts read. `objects` and `items` exist for 3MF input only. */
export interface MeshInfo {
    boundingBox: {
        dimensions: {
            x: number;
            y: number;
            z: number;
        };
    };
    faceCount: number;
    objects?: Array<{
        faceCount: number;
        boundingBox: {
            min: {
                x: number;
                y: number;
                z: number;
            };
            max: {
                x: number;
                y: number;
                z: number;
            };
        };
        item: number;
        objectId: string;
    }>;
    items?: Array<{
        objectId: string;
        printable: boolean;
    }>;
}
export interface FactContext {
    /** Absolute path of the input file and what it is. */
    filePath: string;
    kind: "3mf" | "mesh" | "gcode";
    /** getSTLInfo, injected so the facts never import the server. */
    meshInfo: (filePath: string) => Promise<MeshInfo>;
    /** The opened 3MF; undefined for mesh and G-code input. */
    project?: ProjectFiles;
    /** 0-based plate the plate-level facts (object_count, filament_count) describe. */
    plateIndex: number;
    /** The bambu_model the user will slice for, e.g. "x2d". */
    targetPrinter: string;
    /** Installed Bambu Studio version, null when unreadable. */
    installedStudio: () => Promise<string | null>;
}
/** Computes only the facts asked for. The caller skips a provider whose `needs` are missing, so its facts stay unknown. */
export interface FactProvider {
    /** 1 settings, 2 cheap structure and box facts. A fact nobody provides is graded by its area (see factTier). */
    tier: number;
    provides(fact: string): boolean;
    needs: readonly "3mf"[];
    collect(ctx: FactContext, wanted: readonly string[]): Promise<Facts>;
}
