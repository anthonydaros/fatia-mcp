import type { GcodeScan, ScanEvidence, ScanValue } from "./gcode-scan.js";
export interface SliceArtifacts {
    /** 0-based plate. */
    plateIndex: number;
    /** Root <config> of Metadata/slice_info.config. */
    sliceInfo?: any;
    /** Parsed result.json of the CLI run (outside the zip). */
    result?: any;
    /** Parsed Metadata/filament_sequence.json. */
    filamentSequence?: any;
    /** The scan of the same plate's G-code: fallbacks for time and weight. */
    gcode?: GcodeScan;
    /** Label for the evidence map. */
    source?: string;
}
export interface SliceFacts {
    facts: Record<string, ScanValue>;
    evidence: Record<string, ScanEvidence>;
    blind: string[];
}
/** What slice_info says that lets the G-code scan call a zero known: support unused, and no used filament on extruder 2 (the Bowden aux nozzle). */
export declare function scanHints(sliceInfo: any, plateIndex: number): {
    supportUsed?: boolean;
    auxExtruderUsed?: boolean;
};
export declare function sliceFacts(a: SliceArtifacts): SliceFacts;
