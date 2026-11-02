import { type OptimizationOptions } from './optimization-options.js';
import type { LayoutInput } from "./prepare.js";
export declare const PREPARE_TOOLS: readonly [{
    readonly name: "prepare_print_project";
    readonly description: string;
    readonly inputSchema: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly properties: {
            readonly path: {
                readonly type: "string";
                readonly description: "Local .3mf project (also a .gcode.3mf) or .stl. Never modified.";
            };
            readonly plate_index: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly description: "0-based plate of a multi-plate 3MF to slice and judge. Default 0, or the plate with the longest predicted time after a layout change. When passed, it means the NEW numbering if the layout rewrote the plates.";
            };
            readonly bambu_model: {
                readonly type: "string";
                readonly description: "Printer the user will slice for (x2d, a1, h2d, ...). Default BAMBU_MODEL; the reference printer is the X2D. A project made for another printer is retargeted first.";
            };
            readonly part_context: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly description: "What the user said about the part; leave a key out when they did not say it. Never infer from the file.";
                readonly properties: {
                    readonly [x: string]: {
                        type: string;
                        enum: ("none" | "rigid" | "silicone" | "keychain" | "pix_plate" | "face_down_plate" | "other" | "functional" | "high_load")[];
                    } | {
                        type: string;
                    };
                };
            };
            readonly optimization: {
                type: string;
                additionalProperties: boolean;
                description: string;
                properties: {
                    objective: {
                        type: string;
                        enum: string[];
                        default: string;
                        description: string;
                    };
                    constraints: {
                        type: string;
                        additionalProperties: boolean;
                        description: string;
                        properties: {
                            [k: string]: {
                                type: string;
                                minimum: number;
                                maximum: number;
                                description: string;
                            };
                        };
                    };
                    candidates: {
                        type: string;
                        minItems: number;
                        maxItems: number;
                        description: string;
                        items: {
                            type: string;
                            additionalProperties: boolean;
                            required: string[];
                            properties: {
                                name: {
                                    type: string;
                                    minLength: number;
                                    maxLength: number;
                                };
                                settings: {
                                    type: string;
                                    additionalProperties: boolean;
                                    properties: any;
                                };
                            };
                        };
                    };
                    allow_reorientation: {
                        type: string;
                        default: boolean;
                        description: string;
                    };
                    targets: {
                        type: string;
                        maxItems: number;
                        description: string;
                        items: {
                            type: string;
                            additionalProperties: boolean;
                            required: string[];
                            properties: {
                                plate_index: {
                                    type: string;
                                    minimum: number;
                                    maximum: number;
                                };
                                item_index: {
                                    type: string;
                                    minimum: number;
                                    maximum: number;
                                };
                            };
                        };
                    };
                };
            };
            readonly select_round: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 49;
                readonly description: "Deliver this measured tuning round (0-based), if eligible, instead of the default best round. Round IDs refer to this run; unavailable, failed or blocked rounds are rejected. Alternatives remain unsliced projects for review.";
            };
            readonly max_slices: {
                readonly type: "integer";
                readonly minimum: 2;
                readonly maximum: 50;
                readonly description: "Most CLI slices in all (retarget, baseline, tuned rounds and final verification). Default 12.";
            };
            readonly max_minutes: {
                readonly type: "number";
                readonly minimum: 1;
                readonly maximum: 240;
                readonly description: "Wall-clock budget in minutes. Default 20.";
            };
            readonly output_dir: {
                readonly type: "string";
                readonly description: "Folder for the new project. Default: ~/.fatia-mcp/outputs (or FATIA_OUTPUT_DIR).";
            };
            readonly output_name: {
                readonly type: "string";
                readonly description: "File name of the new project (not a path). Default <source>_tuned.3mf; a name that exists gets a numeric suffix.";
            };
            readonly open_in_studio: {
                readonly type: "boolean";
                readonly description: "Open the new, unsliced project in Bambu Studio for review. Default true; a failure to open is a warning.";
            };
            readonly apply: {
                readonly type: "string";
                readonly enum: readonly ["recommended", "strong_only"];
                readonly description: "Which confidences are written. Default recommended.";
            };
            readonly dry_run: {
                readonly type: "boolean";
                readonly description: "Plan only: no slicing, nothing delivered (the layout is analysed and planned, its candidates unmeasured). Default false.";
            };
            readonly layout: {
                readonly type: "string";
                readonly enum: readonly ["auto", "check_only", "off"];
                readonly description: "auto (default): fix the layout, deciding the number of plates by measurement. check_only: report the issues and the plan, change nothing. off: skip the layout stage.";
            };
            readonly layout_gap_mm: {
                readonly type: "number";
                readonly minimum: 0;
                readonly maximum: 100;
                readonly description: "Edge-to-edge gap between objects on a plate. Default max(8, 2 x brim width + 2 when the project has a brim).";
            };
            readonly layout_margin_mm: {
                readonly type: "number";
                readonly minimum: 0;
                readonly maximum: 50;
                readonly description: "Distance kept from the edge of the usable area. Default 5.";
            };
            readonly layout_max_slices: {
                readonly type: "integer";
                readonly minimum: 1;
                readonly maximum: 20;
                readonly description: "CLI slices the layout candidates may use (one per candidate, all its plates). Separate from max_slices. Default 6.";
            };
            readonly layout_max_minutes: {
                readonly type: "number";
                readonly minimum: 1;
                readonly maximum: 240;
                readonly description: "Wall-clock minutes the layout candidates may take. Separate from max_minutes. Default 12.";
            };
        };
        readonly required: readonly ["path"];
    };
    readonly annotations: {
        readonly readOnlyHint: false;
        readonly destructiveHint: false;
        readonly idempotentHint: false;
        readonly openWorldHint: false;
    };
}];
export interface PrepareArgs {
    optimization?: OptimizationOptions;
    path: string;
    plateIndex: number;
    plateIndexExplicit: boolean;
    layout: LayoutInput;
    model?: string;
    partContext?: unknown;
    selectRound?: number;
    maxSlices: number;
    maxMinutes: number;
    outputDir?: string;
    outputName?: string;
    openInStudio: boolean;
    apply: "recommended" | "strong_only";
    dryRun: boolean;
}
/** Strict: a typo or a wrong type is an error that says what to send, never silently ignored. */
export declare function parsePrepareArgs(args: Record<string, unknown> | undefined): PrepareArgs;
