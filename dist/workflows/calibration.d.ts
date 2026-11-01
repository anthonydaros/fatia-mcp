import type { Tool } from '@modelcontextprotocol/sdk/types.js';
export declare const CALIBRATION_TOOLS: Tool[];
export interface CalibrationDeps {
    printerPreset: string;
    tempDir: string;
    outputDir: string;
    signal?: AbortSignal;
    maxNozzleTemperature?: number;
}
export declare function createCalibrationProject(args: Record<string, unknown>, deps: CalibrationDeps): Promise<Record<string, any>>;
