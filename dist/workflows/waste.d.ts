import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { type GcodeScan } from '../tuning/gcode-scan.js';
export declare const WASTE_TOOLS: Tool[];
export declare function summarizeObservedExtrusion(scan: GcodeScan): {
    observed_weights_g: Record<string, number | null>;
    observed_coverage: string;
    rounding_residual_g: number | null;
};
export declare function analyzePrintWaste(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>>;
