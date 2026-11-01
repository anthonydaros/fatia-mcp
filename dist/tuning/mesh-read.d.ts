import type { ProjectFiles } from "../knowledge/types.js";
/** Triangle soup in world space: pos = x,y,z per vertex, idx = 3 vertex numbers per triangle (counter-clockwise seen from outside). */
export interface Soup {
    pos: Float64Array;
    idx: Uint32Array;
}
/** One printable object (a build item): all its model parts together. */
export interface MeshObject {
    name: string;
    soup: Soup;
}
export interface ReadMesh {
    objects: MeshObject[];
    triangles: number;
}
export type MeshReadFailure = "too_large" | "no_geometry" | "unreadable" | "no_plate";
export declare class MeshReadError extends Error {
    readonly code: MeshReadFailure;
    constructor(code: MeshReadFailure, message: string);
}
/** Triangles accepted over all instances of one read (the spec's safe limit for the linear pass). */
export declare const MAX_TRIANGLES = 3000000;
/**
 * Makes the triangles idx[from..to) face outward. A closed mesh whose signed volume is negative is inside out (reversed winding, common from other
 * exporters; Studio repairs it and slices it like a normal part), so two corners of each triangle are swapped. The sum starts at the first vertex to
 * keep it small. Meaningful for closed meshes only: an open surface has no sign, and keeps what it has when the volume is not negative.
 */
export declare function faceOutward(pos: Float64Array, idx: Uint32Array, from: number, to: number): void;
/** Reads the printable normal-part meshes of one plate of an opened 3MF. A file without geometry (a GUI-sliced export) is `no_geometry`. */
export declare function readProjectMesh(project: ProjectFiles, plateIndex: number, maxTriangles?: number): Promise<ReadMesh>;
/** Reads one STL (binary or ASCII) as a single object; units are taken as millimetres. */
export declare function readStlMesh(filePath: string, maxTriangles?: number): Promise<ReadMesh>;
