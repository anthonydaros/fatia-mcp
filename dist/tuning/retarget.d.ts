import { STLManipulator } from "../stl/stl-manipulator.js";
import type { Retargeter } from "./project-writer.js";
export interface StudioRetargetOptions {
    slicerPath: string;
    tempDir: string;
    /** "Bambu Lab X2D 0.4 nozzle" */
    printerPreset: string;
    /** Profile-name code of the model, "X2D" */
    modelCode: string;
    manipulator?: STLManipulator;
    /** Aborting kills the CLI run in progress. */
    signal?: AbortSignal;
    /** false: refuse (instead of running) a retarget that needs a real slice, so a dry run never slices. Default true. */
    allowSlice?: boolean;
}
export declare function studioRetargeter(o: StudioRetargetOptions): Retargeter;
