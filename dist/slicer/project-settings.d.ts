type Config = Record<string, unknown>;
export interface ProjectSettingsPlan {
    from: {
        printer: string;
        process: string;
    };
    /** Target process preset a "keep" slice starts from. */
    process: string;
    /** Changed process keys, merged onto the target preset (vectors at the target's length). */
    overlay: Config;
    /** Target filament per project slot; unmapped slots hold the printer's default filament. */
    filaments: {
        slot: number;
        from: string;
        to: string;
    }[];
    defaults: {
        process: string;
        filament: string;
    };
    /** "key: project value -> printer default", one per difference "keep" would preserve. */
    kept: string[];
    notKept: string[];
}
export type ProjectSettingsMode = 'keep' | 'printer_default';
export interface SettingsReport {
    mode: ProjectSettingsMode;
    kept: string[];
    not_kept: string[];
    filament_map: {
        slot: number;
        from: string;
        to: string;
    }[];
}
export interface ProjectSettingsTarget {
    config: Config;
    /** Machine preset name, e.g. "Bambu Lab X2D 0.4 nozzle". */
    printerPreset: string;
    /** Profile-name code of the target model, e.g. "X2D". */
    modelCode: string;
    /** The flattened machine preset: it names the default process and filament. */
    machine: Config;
    /** Leaf preset by name, or undefined when the tree has none. */
    leaf(kind: 'process' | 'filament', name: string): Config | undefined;
    /** Flattened (inherits/include resolved) process preset. */
    flatProcess(name: string): Promise<Config>;
    /** The caller supplies its own filaments, so slots are neither mapped nor reported. */
    skipFilaments?: boolean;
}
export declare function readProjectConfig(filePath: string): Promise<Config | undefined>;
export declare function buildProjectSettingsPlan(t: ProjectSettingsTarget): Promise<ProjectSettingsPlan>;
/** What a slice in the chosen mode kept and dropped, for the tool result. */
export declare function settingsReport(plan: ProjectSettingsPlan, mode: ProjectSettingsMode): SettingsReport;
export {};
