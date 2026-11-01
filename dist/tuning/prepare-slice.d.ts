import { type BambuSliceOptions, type STLManipulator } from "../stl/stl-manipulator.js";
import type { SliceOutcome } from "./prepare.js";
export interface StudioSliceOptions {
    manipulator: STLManipulator;
    slicerPath: string;
    /** "Bambu Lab X2D 0.4 nozzle" */
    printerPreset: string;
    /** Profile-name code of the model, "X2D" */
    modelCode: string;
    /** 0-based. */
    plateIndex: number;
    /** The same bed / nozzle options slice_stl passes. */
    bambuOptions?: BambuSliceOptions;
}
/** A project file in, the scanned plate out. Throws when the CLI fails or is cancelled. */
export declare function studioSlicer(o: StudioSliceOptions): (project: string, signal?: AbortSignal) => Promise<SliceOutcome>;
