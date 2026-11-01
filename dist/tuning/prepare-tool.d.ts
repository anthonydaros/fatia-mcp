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
                readonly description: "0-based plate of a multi-plate 3MF to slice and judge. Default 0.";
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
            readonly max_slices: {
                readonly type: "integer";
                readonly minimum: 2;
                readonly maximum: 50;
                readonly description: "Most CLI slices in all (baseline and tuned rounds). Default 12.";
            };
            readonly max_minutes: {
                readonly type: "number";
                readonly minimum: 1;
                readonly maximum: 240;
                readonly description: "Wall-clock budget in minutes. Default 20.";
            };
            readonly output_dir: {
                readonly type: "string";
                readonly description: "Folder for the new project. Default: prepared/ under the server's TEMP_DIR.";
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
                readonly description: "Plan only: no slicing, nothing delivered. Default false.";
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
    path: string;
    plateIndex: number;
    model?: string;
    partContext?: unknown;
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
