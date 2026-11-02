import { ThreeMFData, ThreeMFPlateObjects } from './types.js';
export { ThreeMFData };
export declare function parse3MF(filePath: string): Promise<ThreeMFData>;
export declare function extractBambuTemplateSettings(filePath: string, outputDir: string): Promise<string>;
/** Per-plate time, weight, filament use and slicer warnings from the parsed root <config> of a slice_info.config. */
export declare function sliceResultsFrom(config: any): {
    index: number;
    prediction_s: number;
    weight_g: number;
    filaments: {
        type: any;
        color: any;
        used_g: number;
        used_m: number;
    }[];
    warnings: {
        msg: any;
        level: number;
        error_code: any;
    }[];
}[];
/** Per-plate time, weight, filament use and slicer warnings that Bambu Studio records in a sliced 3MF. */
export declare function readSliceResults(filePath: string): Promise<{
    index: number;
    prediction_s: number;
    weight_g: number;
    filaments: {
        type: any;
        color: any;
        used_g: number;
        used_m: number;
    }[];
    warnings: {
        msg: any;
        level: number;
        error_code: any;
    }[];
}[]>;
export declare function analyze3MFPlateObjects(filePath: string, plateIndex?: number): Promise<ThreeMFPlateObjects & {
    build_items: Array<{
        item_index: number;
        object_id: string;
        instance: number;
        name: string;
    }> | null;
    build_items_problem: string | null;
}>;
