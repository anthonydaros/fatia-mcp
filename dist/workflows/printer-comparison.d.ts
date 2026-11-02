import { type Retargeter } from '../tuning/project-writer.js';
import type { SliceAll } from '../tuning/layout-stage.js';
export interface PrinterComparisonDeps {
    tempDir: string;
    outputDir: string;
    signal?: AbortSignal;
    now?: () => number;
    target: (model: string) => Promise<{
        printerPreset: string;
        retarget: Retargeter;
        sliceAll: SliceAll;
    }>;
}
/** Compare print operating estimates for the unchanged authored project, never a printer purchase ROI. */
export declare function comparePrinterModels(args: Record<string, unknown>, deps: PrinterComparisonDeps): Promise<Record<string, any>>;
