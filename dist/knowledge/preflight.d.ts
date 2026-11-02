import type { MeshInfo } from "./types.js";
export interface PreflightDeps {
    profilesRoot?: string;
    signal?: AbortSignal;
    /** BAMBU_MODEL, used when the call names no model. */
    defaultModel?: string;
    validModels: readonly string[];
    /** Last resort when neither the call, the environment nor the 3MF name a supported printer (elicitation). */
    askModel(): Promise<string>;
    /** STLManipulator.getSTLInfo: bounding boxes and triangle counts of an STL or 3MF. */
    meshInfo(filePath: string): Promise<MeshInfo>;
    /** Installed Bambu Studio version, cached per process. */
    studioVersion(): Promise<string | null>;
    /** slicerInfo({checkUpdates: false}); not cached, because acknowledging a version changes it. */
    studioInfo(): Promise<Record<string, unknown>>;
}
/**
 * The cheapest input a fact needs: its provider's tier, else by area (G-code 3, mesh analysis 4, Blender 5),
 * else 2 (declared by the user, or a key the guide has not confirmed). A rule's tier is the highest of its facts.
 */
export declare function factTier(fact: string): number;
export declare function preflightCheck(args: Record<string, unknown>, deps: PreflightDeps): Promise<Record<string, unknown>>;
