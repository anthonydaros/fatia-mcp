import type { Fact, ProjectFiles } from "../knowledge/types.js";
import type { ScanEvidence, ScanValue } from "./gcode-scan.js";
import { type ReadMesh } from "./mesh-read.js";
import type { Settings } from "./types.js";
/** Implementation constants. The guide gives none of them (spec 8.2 says so); each one is reported in the evidence of the fact it shapes. */
export interface MeshConstants {
    /** A face this close to horizontal is flat: top levels, flat bottom. Spec 8.2 (2 degrees). */
    horizontalDeg: number;
    /** A downward face this close to horizontal is a flat ceiling that Studio bridges, not an overhang. Chosen equal to horizontalDeg. */
    bridgeBandDeg: number;
    /** Top-surface faces whose centroid Z differs by at most this chain into one level. Spec 8.2. */
    levelGapMm: number;
    /** A level needs at least this much uncovered area. Spec 8.2. */
    levelMinAreaMm2: number;
    /** Faces this high above the lowest point of the object are on the bed, not overhangs. Spec 8.2. */
    bedToleranceMm: number;
    /** The flat bottom is the downward flat faces this close to the lowest point (spec 8.2: z_min +- 0.02). */
    flatBottomToleranceMm: number;
    /** A region of overhang faces whose largest XY extent is below this is a small bridge or hole, not an overhang. Proposed by the spec (3 mm). */
    minRegionSpanMm: number;
    /**
     * A connected sloped region that rises less than this (Z extent) is a bevel, a tessellated arch top or a short step: geometry cannot say whether it asks
     * for support, so it is never counted and, when nothing clearer exists, makes the fact unknown. Below the threshold angle a region's horizontal reach is at
     * least 1.7 times its rise, so 5 mm is a reach of 8.7 mm or more. NOT a guide value and not validated on a printer: chosen above the tallest sloped region
     * (2.5 mm) of the sample that Studio printed with bridges and no support.
     */
    minRiseMm: number;
    /** Used when the settings have no usable support_threshold_angle (0 means automatic in Studio) or no layer height / top Z distance. */
    defaultThresholdDeg: number;
    defaultTopZMm: number;
    defaultLayerMm: number;
    /** XY cell of the ray grid. */
    gridCellMm: number;
    /** A hit closer than this to the ray origin is the face itself. */
    rayEpsMm: number;
    /** Rays per call; above it the faces are stride-sampled. */
    maxRays: number;
    /** Triangles above which no ray is cast (spec 8.1: 2 M). */
    maxRayTriangles: number;
    /** Triangle tests all rays together may make. */
    rayWork: number;
}
export declare const MESH_CONSTANTS: Readonly<MeshConstants>;
/** Facts of this analyzer that the tuning data declares (kb/out/facts.json, kb/tuning/out/tuning-facts.json). */
export declare const MESH_FACTS: readonly ["mesh.size_x_mm", "mesh.size_y_mm", "mesh.height_mm", "mesh.max_object_height_mm", "mesh.bbox_max_dim_mm", "mesh.footprint_area_mm2", "mesh.height_to_footprint", "mesh.triangle_count", "mesh.min_z_mm", "mesh.flat_bottom_area_mm2", "mesh.top_surface_levels", "mesh.unsupported_overhang_area_mm2"];
/** Facts declared on the repo side (not in the shipped knowledge base): evidence only, no tuning action reads them. */
export declare const REPO_MESH_FACTS: readonly Fact[];
/** Declared by the spec as mesh analysis but not implemented here (spec 9 step 5: expensive, never measured); they come back blind. */
export declare const MESH_NOT_IMPLEMENTED: readonly ["mesh.min_feature_mm", "mesh.has_slender_protrusions", "mesh.fit_hole_count", "mesh.has_cylindrical_walls", "object.flat_cut_or_pin_base_on_bed"];
export interface MeshEvidence extends ScanEvidence {
    /** True when the number is a prediction from geometry (what Studio will want), not a measurement of the part or of a slice. */
    predictive?: boolean;
}
export interface MeshDetails {
    thresholdDeg: number;
    restMm: number;
    /** The spec's first definition: every downward face below the threshold angle, not on the bed. 1422.8 on the sample's plate 1. */
    classicOverhangAreaMm2: number;
    flatCeilingAreaMm2: number;
    slopedCandidateAreaMm2: number;
    /** Sloped regions dropped because their largest XY extent is under minRegionSpanMm. */
    droppedBySpanMm2: number;
    /** Sloped regions dropped because they rise less than minRiseMm, and the tallest of them. */
    droppedByRiseMm2: number;
    maxDroppedRiseMm: number;
    /** Sloped area that rests on lower geometry. */
    restingAreaMm2: number;
    levels: Array<{
        z: number;
        areaMm2: number;
    }>;
    rays: number;
    sampled: boolean;
}
export interface MeshFacts {
    facts: Record<string, ScanValue>;
    evidence: Record<string, MeshEvidence>;
    /** Names of the facts this analysis did not produce (why: evidence[name].notes). */
    blind: string[];
    stats: {
        objects: number;
        triangles: number;
        ms: number;
    };
    details?: MeshDetails;
    constants: MeshConstants;
}
export interface MeshFactsOptions {
    /** The base project's settings: support_threshold_angle, support_top_z_distance, layer_height. */
    settings?: Settings;
    constants?: Partial<MeshConstants>;
    /** Label for the evidence map. */
    source?: string;
    signal?: AbortSignal;
}
export declare function meshFactsFromRead(read: ReadMesh, options?: MeshFactsOptions): MeshFacts;
/** Mesh facts of one plate (0-based) of an opened 3MF (openProject). Never throws on the content of the file: the facts come back blind with the reason. */
export declare const meshFactsFromProject: (project: ProjectFiles, plateIndex: number, options?: MeshFactsOptions) => Promise<MeshFacts>;
/** Mesh facts of one STL file. */
export declare const meshFactsFromStl: (filePath: string, options?: MeshFactsOptions) => Promise<MeshFacts>;
