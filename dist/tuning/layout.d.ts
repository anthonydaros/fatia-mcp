import type { ProjectFiles } from "../knowledge/types.js";
/** Objects the stage accepts: past this a hostile or enormous project is refused before anything is packed. */
export declare const MAX_LAYOUT_OBJECTS = 500;
export declare const CELL_FACTOR = 1.2;
export interface Rect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}
export interface Box extends Rect {
    z0: number;
    z1: number;
}
/** What one nozzle can reach, in the plate's local coordinates. */
export interface Nozzle {
    rect: Rect;
    height: number;
}
export interface BedGeometry {
    /** printable_area as a rectangle, local coordinates (a bed that is not a rectangle is approximated by its bounding box: see notes). */
    bed: Rect;
    height: number;
    /** One entry per nozzle (extruder_printable_area / extruder_printable_height). */
    nozzles: Nozzle[];
    /** Filament slot (0-based) -> nozzle (0-based), from filament_map; a missing entry means nozzle 0. */
    filamentMap: number[];
    strideX: number;
    strideY: number;
    /** filament_map_mode of the project: "Auto ..." means the slicer may regroup the filaments itself. */
    mapMode: string | undefined;
    notes: string[];
}
export declare class LayoutLimitError extends Error {
}
type Config = Record<string, unknown>;
export declare const intersection: (a: Rect, b: Rect) => Rect;
/** The target printer's plate and nozzle geometry from its project settings; undefined when printable_area is missing or unusable. */
export declare function geometryFromConfig(config: Config): BedGeometry | undefined;
export declare const gridColumns: (plateCount: number) => number;
/** World position of the plate's local 0,0. */
export declare function plateOrigin(index: number, plateCount: number, geo: BedGeometry): {
    x: number;
    y: number;
};
/** The plate's printable rectangle in world coordinates. */
export declare function plateRect(index: number, plateCount: number, geo: BedGeometry): Rect;
/** Where a set of filament slots can print, in local coordinates: the area every nozzle they map to can reach, and the lowest of their height limits. */
export interface Bin {
    rect: Rect;
    height: number;
    nozzles: number[];
}
export declare function binFor(slots: number[], geo: BedGeometry): Bin;
export interface LayoutObject {
    /** "objectId:instance", the key model_settings.config's model_instance uses. */
    key: string;
    objectId: string;
    instance: number;
    /** Position among the build items (the order of the `<item>` tags). */
    itemIndex: number;
    name: string;
    /** Filament slots (1-based) the object prints with. */
    slots: number[];
    painted: boolean;
    /** Colour class: the slots it uses, plus "+paint" for a painted object. Two classes never share a plate. */
    classKey: string;
    box: Box;
    volume_mm3: number;
    /** 0-based plates that list the instance (exactly one in a sound project). */
    plates: number[];
}
export interface LayoutPlate {
    index: number;
    locked: boolean;
    name: string | undefined;
    keys: string[];
}
export interface LayoutModel {
    objects: LayoutObject[];
    plates: LayoutPlate[]; /** Plate instances with no printable mesh (a non-printable item, an empty object). */
    unplaced: string[];
}
export declare const classKeyOf: (slots: number[], painted: boolean) => string;
/** Every printable object with its world box and the plates model_settings.config assigns it to. Throws MeshReadError (no geometry...) or LayoutLimitError. */
export declare function readLayoutModel(project: ProjectFiles): Promise<LayoutModel>;
export type IssueKind = "outside_plate" | "straddling" | "between_plates" | "outside_nozzle_area" | "overlap" | "too_tall" | "bed_changed" | "locked_plate" | "plate_assignment" | "blocker";
export interface LayoutIssue {
    kind: IssueKind;
    /** error: the project cannot print as it is; warning: it can but should not; info: nothing is wrong yet. */
    severity: "error" | "warning" | "info";
    /** 1-based plate, when the issue belongs to one. */
    plate?: number;
    objects: string[];
    evidence: Record<string, unknown>;
    text: string;
    fix: string;
}
export interface PlateStat {
    /** 1-based. */
    plate: number;
    locked: boolean;
    objects: string[];
    classes: string[];
    footprint_mm2: number;
    bed_mm2: number;
    /** Sum of the objects' bounding-box areas over the plate's area: an upper bound of what the footprints cover. */
    utilisation: number;
}
export interface LayoutAnalysis {
    issues: LayoutIssue[];
    plates: PlateStat[];
    clean: boolean;
}
export interface AnalysisOptions {
    /** Edge-to-edge distance under which two neighbours count as overlapping. */
    minGapMm: number;
}
/** Edge-to-edge distance of two boxes in XY; negative when they intersect (minus the smaller overlap). */
export declare function gapBetween(a: Rect, b: Rect): number;
export declare function analyzeLayout(model: LayoutModel, geo: BedGeometry, opts: AnalysisOptions): LayoutAnalysis;
/** The bed of the project's author against the target's; undefined when they are the same size or the source is unknown. */
export declare function bedChange(source: Config | undefined, geo: BedGeometry): LayoutIssue | undefined;
export {};
