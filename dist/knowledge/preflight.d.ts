export interface PreflightDeps {
    /** BAMBU_MODEL, used when the call names no model. */
    defaultModel?: string;
    validModels: readonly string[];
    /** Last resort when neither the call, the environment nor the 3MF name a supported printer (elicitation). */
    askModel(): Promise<string>;
    /** Installed Bambu Studio version, cached per process. */
    studioVersion(): Promise<string | null>;
    /** slicerInfo({checkUpdates: false}); not cached, because acknowledging a version changes it. */
    studioInfo(): Promise<Record<string, unknown>>;
}
export declare function preflightCheck(args: Record<string, unknown>, deps: PreflightDeps): Promise<Record<string, unknown>>;
