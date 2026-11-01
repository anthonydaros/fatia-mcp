import type { FactProvider, ProjectFiles } from "../types.js";
export declare const asArray: (x: unknown) => any[];
/** Value of the <metadata key="..." value="..."/> child of an XML node parsed with mergeAttrs. */
export declare const meta: (node: any, key: string) => unknown;
/** The printer being targeted, spelled as the project settings spell it ("Bambu Lab X2D"). */
export declare const targetName: (model: string) => string;
/** Opens a 3MF through the safe archive reader and parses the three metadata files tier 1 needs. Never throws on their content. */
export declare function openProject(filePath: string): Promise<ProjectFiles>;
/** "object:instance" of each model_instance on one plate (plater_id is 1-based); undefined when model_settings.config has no such plate. */
export declare function plateInstances(modelSettings: any, plateIndex: number): string[] | undefined;
/** True when a model file paints colours (so the filaments in use are not all listed in model_settings.config); undefined when the 3MF has no geometry to look at. */
export declare function hasPaint(project: ProjectFiles): Promise<boolean | undefined>;
/** The Studio that saved the 3MF; anything but a plain dotted version is treated as unknown (the value is third-party text). */
export declare function savedVersion(project: ProjectFiles): string | undefined;
export declare const settingsProvider: FactProvider;
