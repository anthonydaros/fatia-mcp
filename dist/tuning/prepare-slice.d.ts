import { type BambuSliceOptions, type STLManipulator } from "../stl/stl-manipulator.js";
import type { SliceAll } from "./layout-stage.js";
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
/** A project file in, the scanned plate out (`plateIndex` overrides the one the slicer was built with: the layout stage renumbers the plates). Throws when the CLI fails or is cancelled. */
export declare function studioSlicer(o: StudioSliceOptions): (project: string, signal?: AbortSignal, plateIndex?: number) => Promise<SliceOutcome>;
/**
 * Every plate of a project in ONE CLI call (`--slice 0`): each plate's predicted time and weight from the slice result and its G-code scanned for
 * the travels that cross extrusion. This is how the layout stage measures a candidate. Throws when the CLI fails or is cancelled.
 */
export declare function studioAllPlatesSlicer(o: Omit<StudioSliceOptions, "plateIndex">): SliceAll;
