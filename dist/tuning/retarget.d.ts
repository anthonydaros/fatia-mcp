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
}
export declare function studioRetargeter(o: StudioRetargetOptions): Retargeter;
