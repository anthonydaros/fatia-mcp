import type { FactProvider, ProjectFiles } from "../types.js";
/** Opens a 3MF through the safe archive reader and parses the three metadata files tier 1 needs. Never throws on their content. */
export declare function openProject(filePath: string): Promise<ProjectFiles>;
/** The Studio that saved the 3MF; anything but a plain dotted version is treated as unknown (the value is third-party text). */
export declare function savedVersion(project: ProjectFiles): string | undefined;
export declare const settingsProvider: FactProvider;
