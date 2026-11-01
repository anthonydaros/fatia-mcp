import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { SliceOutcome } from '../tuning/prepare.js';
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
