export interface PrinterIdentity {
    name: string;
    model_id: string;
}
export declare function loadPrinterIdentities(profilesRoot: string): Promise<PrinterIdentity[]>;
export declare function resolvePrinterIdentity(value: unknown, identities: readonly PrinterIdentity[]): {
    raw: string | null;
    canonical_model: string | null;
    source: string;
};
export declare function printerEvidence(config: Record<string, unknown>, sliceInfo: any, identities: readonly PrinterIdentity[], target?: string): {
    saved_preset: {} | null;
    saved: {
        raw: string | null;
        canonical_model: string | null;
        source: string;
    };
    target: {
        raw: string | null;
        canonical_model: string | null;
        source: string;
    };
    sliced: {
        matches_target: boolean | null;
        raw: string | null;
        canonical_model: string | null;
        source: string;
        plate_index: number;
    }[];
};
