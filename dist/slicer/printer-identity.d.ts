export interface PrinterIdentity {
    name: string;
    model_id: string;
}
export declare function loadPrinterIdentities(profilesRoot: string): Promise<PrinterIdentity[]>;
export declare function resolvePrinterIdentity(value: unknown, identities: readonly PrinterIdentity[]): {
    raw: string | null;
    canonical_model: null;
    source: "unknown";
} | {
    raw: string;
    canonical_model: string;
    source: "installed_profile";
} | {
    raw: string;
    canonical_model: string;
    source: "bundled_reference";
};
export declare function printerEvidence(config: Record<string, unknown>, sliceInfo: any, identities: readonly PrinterIdentity[], target?: string): {
    saved_preset: {} | null;
    saved: {
        raw: string | null;
        canonical_model: null;
        source: "unknown";
    } | {
        raw: string;
        canonical_model: string;
        source: "installed_profile";
    } | {
        raw: string;
        canonical_model: string;
        source: "bundled_reference";
    };
    target: {
        raw: string | null;
        canonical_model: null;
        source: "unknown";
    } | {
        raw: string;
        canonical_model: string;
        source: "installed_profile";
    } | {
        raw: string;
        canonical_model: string;
        source: "bundled_reference";
    };
    sliced: ({
        matches_target: boolean | null;
        raw: string | null;
        canonical_model: null;
        source: "unknown";
        plate_index: number;
    } | {
        matches_target: boolean | null;
        raw: string;
        canonical_model: string;
        source: "installed_profile";
        plate_index: number;
    } | {
        matches_target: boolean | null;
        raw: string;
        canonical_model: string;
        source: "bundled_reference";
        plate_index: number;
    })[];
};
