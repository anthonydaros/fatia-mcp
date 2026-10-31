/** ".../BambuStudio.app/Contents/MacOS/BambuStudio" -> ".../BambuStudio.app"; null when not inside a bundle. */
export declare function appBundleFor(executable: string): string | null;
/** Opens a model or sliced project in the slicer's GUI so a person can review it. Never slices or prints. */
export declare function openInSlicer(rawPath: string, executable: string): Promise<Record<string, unknown>>;
