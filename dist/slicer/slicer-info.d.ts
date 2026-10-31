export type Release = {
    tag: string;
    published_at: string | null;
    url: string;
    prerelease: boolean;
};
/** CFBundleShortVersionString from `plutil -convert json` output; null when absent or not JSON. */
export declare function versionFromPlistJson(json: string): string | null;
/** Installed app version: macOS Info.plist, Windows file ProductVersion, null elsewhere or on any failure. */
export declare function readAppVersion(executable: string): Promise<string | null>;
/** "version" of BBL.json in the installation's profiles root; a different number from the app version. */
export declare function readProfileVersion(executable: string): string | null;
/** Published (non-draft) releases of bambulab/BambuStudio, newest first; null on any failure or after 5 s. */
export declare function fetchReleases(fetchImpl?: typeof fetch): Promise<Release[] | null>;
export declare const normalizeVersion: (v: string) => string;
export declare const sameVersion: (a: string, b: string) => boolean;
export declare function stateFilePath(): string;
export interface SlicerInfoOptions {
    executable: string;
    acknowledge?: boolean;
    checkUpdates?: boolean;
    stateFile?: string;
    fetchImpl?: typeof fetch;
}
export declare function slicerInfo(options: SlicerInfoOptions): Promise<Record<string, unknown>>;
