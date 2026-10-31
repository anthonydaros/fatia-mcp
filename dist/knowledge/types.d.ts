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
