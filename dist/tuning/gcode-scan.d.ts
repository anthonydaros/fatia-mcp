export type ScanValue = string | number | boolean | string[];
export interface ScanEvidence {
    source: string;
    method: string;
    approx: boolean;
    notes: string;
}
export interface GcodeScanOptions {
    /** Label of the scanned file for the evidence map. */
    source?: string;
    /** Keep the numbers of a truncated file, every one marked approx. A zero, false or empty value is still left out: a partial scan cannot show an absence. */
    allowPartial?: boolean;
    /** Config in the G-code block format ("key" -> text after " = "), for a G-code whose own CONFIG_BLOCK is missing or comes last. */
    fallbackConfig?: Record<string, string>;
    /** slice_info support_used: lets "no support" be a known zero when the config alone cannot say. */
    supportUsed?: boolean;
    /** slice_info: does any used filament map to extruder 2 (the Bowden aux nozzle)? false makes the aux maxima a known 0. */
    auxExtruderUsed?: boolean;
    /** Stop with an error past this many bytes (default: the 256 MiB inspection limit). */
    maxBytes?: number;
    signal?: AbortSignal;
    /** Work and memory caps against hostile input (defaults in DEFAULT_LIMITS; tests lower them). A cap that trips makes the crossing facts approximate and is counted in details.skipped. */
    limits?: Partial<GcodeScanLimits>;
}
export interface GcodeScanLimits {
    /** Obstacle segments entered in the crossing grid per layer. */
    layerSegments: number;
    /** Grid cell entries per layer (a long segment covers many cells). */
    layerCells: number;
    /** Points kept for one non-extruding run; a longer run gets no crossing test. */
    runPoints: number;
    /** Bucket entries visited by all crossing tests and support-island merges of the file. */
    work: number;
    /** Vertices of extruder_printable_area (all polygons together). */
    polyVertices: number;
    /** Keys of the header block and of the config block, each. */
    keys: number;
    /** Characters of every line read inside the header and config blocks, all blocks together (the real config block is about 100 KB). Past it nothing is stored and the scan is incomplete. */
    blockBytes: number;
}
export interface TravelOrigin {
    unprotected: number;
    crossing: number;
}
export interface GcodeScanDetails {
    header: {
        studioVersion?: string;
        estimatedTimeS?: number;
        weightG?: number;
        layers?: number;
        maxZ?: number;
    };
    layers: number;
    tools: number[];
    features: Record<string, {
        segments: number;
        weight_g: number;
    }>;
    unknownFeatures: string[];
    lifts: {
        spiral: number;
        normal: number;
        slope: number;
        layerChange: number;
        withoutRetract: number;
    };
    runs: number;
    retractRuns: number;
    unprotected: {
        total: number;
        crossing: number;
        crossingSevere: number;
        curlRisk: number;
        over20mm: number;
        inSupport: number;
        belowMin: number;
        maxMm: number;
        maxLayer: number;
        maxZ: number;
        layerChange: number;
        byOrigin: Record<string, TravelOrigin>;
        crossedRoles: Record<string, number>;
        afterSparseSevere: number;
        work: number;
    };
    firstLayer: {
        segments: number;
        speeds: Record<string, number>;
        areaMm2: number;
    };
    flow: {
        maxMm3s: number;
        limit: number;
    };
    /** gridSegments: obstacles not entered in the grid; crossingRuns: unprotected travels whose crossing test was cut short (long run or work budget). */
    skipped: {
        longLines: number;
        badWords: number;
        gridSegments: number;
        crossingRuns: number;
        blockLines: number;
    };
}
export interface GcodeScan {
    facts: Record<string, ScanValue>;
    evidence: Record<string, ScanEvidence>;
    complete: boolean;
    /** Names of the facts this scan did not measure (why: evidence[name].notes). */
    blind: string[];
    stats: {
        lines: number;
        bytes: number;
        ms: number;
    };
    details: GcodeScanDetails;
}
/** Every fact the scan can produce (the `blind` list covers exactly the ones it did not). */
export declare const GCODE_SCAN_FACTS: readonly ["gcode.layer_count", "gcode.extruded_weight_g", "gcode.support_line_count", "gcode.support_interface_line_count", "gcode.support_weight_g", "gcode.ironing_line_count", "gcode.first_layer_height_mm", "gcode.first_layer_speed_mm_s", "gcode.first_layer_wall_speed_mm_s", "gcode.first_layer_infill_speed_mm_s", "gcode.first_layer_area_mm2", "gcode.first_layer_brim_present", "gcode.flow_limit_exceeded_share", "gcode.min_line_width_mm", "gcode.top_layer_count", "gcode.zhop_lift_count", "gcode.zhop_type_mismatch", "gcode.unprotected_travel_count", "gcode.unprotected_travel_crossing_count", "gcode.unprotected_travel_curl_risk_count", "gcode.unprotected_travels_by_origin", "gcode.unprotected_travels_in_support", "gcode.unprotected_travel_over_20mm_count", "gcode.unprotected_travel_max_mm", "gcode.tool_xy_outside_area_count", "gcode.aux_nozzle_max_extrusion_feedrate_mm_s", "gcode.aux_nozzle_max_extrusion_accel_mm_s2", "gcode.flush_length_mismatch_count", "gcode.purge_g", "gcode.tower_g", "gcode.tower_height_mm", "gcode.missing_thin_feature_count", "plate.tool_changes", "plate.waste_weight_g"];
/** The line-by-line state machine. `line` takes one decoded line without its terminator; `finish` builds the result. */
export declare function createGcodeScanner(options?: GcodeScanOptions): {
    line(s: string): void;
    tooLong(): void;
    readonly lines: number;
    finish: (stats: {
        lines: number;
        bytes: number;
        ms: number;
    }) => GcodeScan;
};
/** Scan an async stream of chunks (a file read stream, or an entry stream of an archive). Lines up to 64 KB, LF or CRLF. */
export declare function scanGcodeStream(chunks: AsyncIterable<Uint8Array | string>, options?: GcodeScanOptions): Promise<GcodeScan>;
export declare function scanGcodeFile(filePath: string, options?: GcodeScanOptions): Promise<GcodeScan>;
/** Scan Metadata/plate_N.gcode (N = plateIndex + 1) of a sliced .3mf without inflating it into one buffer. */
export declare function scanPlateGcode(threeMfPath: string, plateIndex: number, options?: GcodeScanOptions): Promise<GcodeScan>;
