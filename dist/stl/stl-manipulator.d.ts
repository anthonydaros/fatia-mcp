import * as THREE from 'three';
import { EventEmitter } from 'events';
import { type ProjectSettingsPlan } from '../slicer/project-settings.js';
export type ProgressCallback = (progress: number, message?: string) => void;
export type OperationResult = {
    success: boolean;
    filePath?: string;
    error?: string;
    operationId: string;
};
export type TransformationType = 'scale' | 'rotate' | 'translate' | 'extendBase' | 'customModify';
export type TransformationAxis = 'x' | 'y' | 'z' | 'all';
export type BoundingBox = {
    min: THREE.Vector3;
    max: THREE.Vector3;
    center: THREE.Vector3;
    dimensions: THREE.Vector3;
};
export type TransformationParams = {
    type: TransformationType;
    axis?: TransformationAxis;
    value: number | number[];
    relative?: boolean;
    selectionBounds?: THREE.Box3;
};
export declare const SLICER_TYPES: readonly ["bambustudio", "prusaslicer", "cura", "slic3r"];
export type SlicerType = typeof SLICER_TYPES[number];
export declare function normalizeSlicerType(rawSlicerType: string): SlicerType;
export declare function isBambuCompatibleSlicer(slicerType: SlicerType): boolean;
export interface BambuSliceOptions {
    uptodate?: boolean;
    repetitions?: number;
    orient?: boolean;
    arrange?: boolean;
    ensureOnBed?: boolean;
    cloneObjects?: string;
    skipObjects?: string;
    loadFilaments?: string;
    loadFilamentIds?: string;
    filamentColours?: string[];
    bedType?: string;
    nozzleType?: string;
    nozzleVolumeType?: 'Standard' | 'High Flow';
    enableTimelapse?: boolean;
    allowMixTemp?: boolean;
    scale?: number;
    rotate?: number;
    rotateX?: number;
    rotateY?: number;
    minSave?: boolean;
    skipModifiedGcodes?: boolean;
    slicePlate?: number;
    projectPlan?: ProjectSettingsPlan;
    exportOnly?: boolean;
}
export declare function bambuCliFailureReason(exitCode: unknown, resultPath: string): string | undefined;
export declare class STLManipulator extends EventEmitter {
    private tempDir;
    private activeOperations;
    constructor(tempDir?: string);
    /**
     * Generate a unique operation ID
     */
    private generateOperationId;
    private getAvailableProfileRoots;
    private findProfileFile;
    private buildFilamentIdIndex;
    private readJsonFile;
    private writeTempJson;
    private resolveBambuLikeSettingsBundle;
    /** Resolve BBL dependencies before invoking the CLI; failures stop the slice. */
    private maybeFlattenBundle;
    /**
     * The CLI applies every key in every --load-settings/--load-filaments file,
     * so machine settings carried by a process or filament file (for example a
     * template 3MF's project_settings from another printer) would replace the
     * selected preset's start G-code, model, and bed geometry. The machine
     * preset owns those keys; drop them from the other profiles.
     */
    private isolateMachineSettings;
    /**
     * A project made for the target printer lists the printer and filament keys it edited; the plan carries them
     * (ProjectSettingsPlan.machineOverlay, filaments[].overlay), and they are merged here onto the prepared machine
     * and filament files, which otherwise replace every such value the project holds.
     */
    private applyProjectEdits;
    /** --load-filaments is positional; a single override must cover every project slot. */
    private expandProjectFilaments;
    /**
     * Map a 3MF's creator settings onto the target printer. Undefined when the 3MF
     * carries none; the caller decides whether to keep them (BambuSliceOptions.projectPlan).
     */
    planProjectSettings(inputPath: string, slicerPath: string, printerPreset: string, modelCode: string, skipFilaments?: boolean): Promise<ProjectSettingsPlan | undefined>;
    private resolveBambuStudioBedType;
    /**
     * Load STL file and return geometry and bounding box
     */
    private loadSTL;
    /**
     * Save a geometry to STL file
     */
    private saveSTL;
    /**
     * Get comprehensive information about an STL file
     */
    getSTLInfo(stlFilePath: string): Promise<{
        filePath: string;
        fileName: string;
        fileSize: number;
        boundingBox: BoundingBox;
        vertexCount: number;
        faceCount: number;
        objects?: Array<{
            name: string;
            vertexCount: number;
            faceCount: number;
            boundingBox: BoundingBox;
            item: number;
            objectId: string;
        }>;
        items?: Array<{
            objectId: string;
            printable: boolean;
        }>;
    }>;
    /**
     * Extract mesh info from a 3MF file: walk the build items and their component
     * trees, applying every transform, so the box matches what the slicer places.
     */
    private get3MFInfo;
    /**
     * Scale an STL model uniformly or along specific axes
     */
    scaleSTL(stlFilePath: string, scaleFactors: number | [number, number, number], progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Rotate an STL model around specific axes
     */
    rotateSTL(stlFilePath: string, rotationAngles: [number, number, number], // [x, y, z] in degrees
    progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Translate (move) an STL model along specific axes
     */
    translateSTL(stlFilePath: string, translationValues: [number, number, number], // [x, y, z] in mm
    progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Generate an SVG visualization of an STL file from multiple angles
     * @param stlFilePath Path to the STL file
     * @param width Width of each view in pixels
     * @param height Height of each view in pixels
     * @param progressCallback Optional callback for progress updates
     * @returns Path to the generated SVG file
     */
    generateVisualization(stlFilePath: string, width?: number, height?: number, progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Apply a specific transformation to a selected section of an STL file
     * This allows for targeted modifications of specific parts of a model
     */
    modifySection(stlFilePath: string, selection: THREE.Box3 | 'top' | 'bottom' | 'center', transformation: TransformationParams, progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Add a slab under the model: the model moves up by the extension along Z (the
     * printing axis), so the result is exactly the original height plus the extension.
     * The slab spans the model's bounding rectangle.
     * @param stlFilePath Path to the input STL file
     * @param extensionMm Amount to extend the base, in millimeters
     * @param progressCallback Optional callback for progress updates
     * @returns Path to the modified STL file
     */
    extendBase(stlFilePath: string, extensionMm: number, progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Slice an STL or 3MF file using the specified slicer
     * @param stlFilePath Path to the input STL or 3MF file
     * @param slicerType Type of slicer (prusaslicer, cura, slic3r, bambustudio)
     * @param slicerPath Path to the slicer executable
     * @param slicerProfile Optional path to the slicer profile/config file
     * @param progressCallback Optional callback for progress updates
     * @param printerPreset Optional BambuStudio printer preset name (e.g., "Bambu Lab P1S 0.4 nozzle")
     * @param bambuOptions Optional BambuStudio-specific CLI flags
     * @param signal Aborting kills the slicer process
     * @returns Path to the generated G-code or sliced 3MF file
     */
    sliceSTL(stlFilePath: string, slicerType: SlicerType, slicerPath: string, slicerProfile?: string, progressCallback?: ProgressCallback, printerPreset?: string, bambuOptions?: BambuSliceOptions, signal?: AbortSignal): Promise<string>;
    /**
     * Enhanced version of confirmTemperatures with better error handling
     * @param gcodePath Path to the G-code file
     * @param expected Expected temperature settings
     * @param progressCallback Optional callback for progress updates
     * @returns Object with comparison results
     */
    confirmTemperatures(gcodePath: string, expected: {
        extruder?: number;
        bed?: number;
    }, progressCallback?: ProgressCallback): Promise<{
        match: boolean;
        actual: {
            extruder?: number;
            bed?: number;
        };
        expected: {
            extruder?: number;
            bed?: number;
        };
        allTemperatures: {
            extruder: number[];
            bed: number[];
        };
    }>;
    /**
     * Merge vertices within a specified tolerance.
     */
    mergeVertices(stlFilePath: string, tolerance?: number, // Default tolerance in mm
    progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Center the model at the origin (0,0,0).
     */
    centerModel(stlFilePath: string, progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Rotate the model so its largest flat face lies on the XY plane (Z=0).
     */
    layFlat(stlFilePath: string, progressCallback?: ProgressCallback): Promise<string>;
}
