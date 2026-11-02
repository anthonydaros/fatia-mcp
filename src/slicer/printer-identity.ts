import fs from 'node:fs/promises';
import path from 'node:path';
import { asArray, meta } from '../knowledge/facts/settings.js';
export interface PrinterIdentity {
    name: string;
    model_id: string;
}
export async function loadPrinterIdentities(profilesRoot: string): Promise<PrinterIdentity[]> {
    const root = path.join(profilesRoot, 'BBL', 'machine'), out: PrinterIdentity[] = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json'))
            continue;
        const file = path.join(root, entry.name);
        if ((await fs.stat(file)).size > 1024 * 1024)
            continue;
        let value;
        try {
            value = JSON.parse(await fs.readFile(file, 'utf8'));
        }
        catch {
            continue;
        }
        if (value.type === 'machine_model' && typeof value.name === 'string' && typeof value.model_id === 'string')
            out.push({ name: value.name, model_id: value.model_id });
    }
    return out;
}
export function resolvePrinterIdentity(value: unknown, identities: readonly PrinterIdentity[]) {
    const raw = typeof value === 'string' ? value : null;
    const matches = identities.filter(p => raw === p.model_id || raw === p.name || raw?.toLowerCase() === p.name.replace(/^Bambu Lab /, '').replace(/ /g, '').toLowerCase() || (raw?.startsWith(p.name + ' ') && /^\d+(?:\.\d+)? nozzle(?: |$)/.test(raw.slice(p.name.length + 1))));
    const names = [...new Set(matches.map(p => p.name))];
    return { raw, canonical_model: names.length === 1 ? names[0] : null, source: names.length === 1 ? 'installed_profile' : 'unknown' };
}
export function printerEvidence(config: Record<string, unknown>, sliceInfo: any, identities: readonly PrinterIdentity[], target?: string) {
    const selected = resolvePrinterIdentity(target, identities);
    const saved = resolvePrinterIdentity(config.printer_model ?? config.printer_settings_id, identities);
    return { saved_preset: config.printer_settings_id ?? null, saved, target: selected, sliced: asArray(sliceInfo?.plate).map(p => {
            const identity = resolvePrinterIdentity(meta(p, 'printer_model_id'), identities);
            return { plate_index: Number(meta(p, 'index')) - 1, ...identity, matches_target: identity.canonical_model && selected.canonical_model ? identity.canonical_model === selected.canonical_model : null };
        }) };
}
