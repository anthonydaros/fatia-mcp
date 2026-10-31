import type { FactProvider } from "../types.js";
/** Facts whose 3MF key the guide marks "a confirmar numa X2D real". */
export declare const UNCONFIRMED_FACTS: ReadonlySet<string>;
/** A verdict fact is easier to trust next to the numbers behind it; preflight adds these to a finding's evidence. */
export declare const EVIDENCE_ALSO: Readonly<Record<string, readonly string[]>>;
type Vec = readonly [number, number, number];
/**
 * Whether a box fits in the volume with any face down and the footprint turned about Z (Carver's test for a
 * rectangle inside a rectangle). shortcut: the box of the part, not its shape and never tilted, so a mesh that only
 * fits tilted counts as not fitting; refine when mesh analysis exists.
 */
export declare function fitsVolume(size: Vec, volume: Vec): boolean;
export declare const structureProvider: FactProvider;
export {};
