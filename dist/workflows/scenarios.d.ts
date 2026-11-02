import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { SliceOutcome } from '../tuning/prepare.js';
export declare const OBJECT_SETTINGS_PROPERTY: {
    type: string;
    maxItems: number;
    description: string;
    items: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            item_indices: {
                type: string;
                minItems: number;
                maxItems: number;
                uniqueItems: boolean;
                items: {
                    type: string;
                    minimum: number;
                };
            };
            settings: {
                type: string;
                additionalProperties: boolean;
                properties: any;
            };
        };
    };
};
export declare function parseObjectSettings(raw: unknown): Array<{
    itemIndices: number[];
    settings: Record<string, string>;
}>;
export declare const SCENARIO_TOOLS: Tool[];
export interface ScenarioDeps {
    printerPreset: string;
    tempDir: string;
    outputDir: string;
    signal?: AbortSignal;
    slice: (project: string, signal?: AbortSignal, plateIndex?: number) => Promise<SliceOutcome>;
    now?: () => number;
}
export declare function compareSliceScenarios(args: Record<string, unknown>, deps: ScenarioDeps): Promise<Record<string, any>>;
