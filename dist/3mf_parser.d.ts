import { ThreeMFData, CollarCharmAnalysis, ThreeMFAmsRequirements, ThreeMFPlateObjects } from './types.js';
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
export declare function analyzeCollarCharm3MF(filePath: string, plateIndex?: number): Promise<CollarCharmAnalysis>;
export declare function getCollarCharmRolePolicy(): {
    colors: {
        readonly inner: "black";
        readonly outer: "white";
    };
    amsSlots: {
        readonly inner: 0;
        readonly outer: 4;
    };
};
export declare function analyze3MFAmsRequirements(filePath: string, plateIndex?: number): Promise<ThreeMFAmsRequirements>;
export declare function analyze3MFPlateObjects(filePath: string, plateIndex?: number): Promise<ThreeMFPlateObjects>;
