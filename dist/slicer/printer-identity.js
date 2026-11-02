import fs from 'node:fs/promises';
import path from 'node:path';
import { PRINTER_REFERENCE } from './printer-reference.js';
import { asArray, meta } from '../knowledge/facts/settings.js';
export async function loadPrinterIdentities(profilesRoot) {
    const root = path.join(profilesRoot, 'BBL', 'machine'), out = [];
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
function normalize(value) { return value.trim().toLowerCase(); }
function matchesIdentity(raw, identity) {
    const value = normalize(raw), name = normalize(identity.name);
    const short = name.replace(/^bambu lab /, '').replace(/ /g, '');
    const reference = PRINTER_REFERENCE.find(p => normalize(p.name) === name);
    return value === normalize(identity.model_id) || value === name || value === short || value === reference?.model_key ||
        (value.startsWith(name + ' ') && /^\d+(?:\.\d+)? nozzle(?: |$)/.test(value.slice(name.length + 1)));
}
export function resolvePrinterIdentity(value, identities) {
    const raw = typeof value === 'string' ? value : null;
    const unknown = { raw, canonical_model: null, source: 'unknown' };
    if (!raw?.trim())
        return unknown;
    const installed = identities.filter(p => matchesIdentity(raw, p));
    if (installed.length) {
        const definitions = new Set(installed.map(p => normalize(p.name) + ':' + normalize(p.model_id)));
        return definitions.size === 1 ? { raw, canonical_model: installed[0].name, source: 'installed_profile' } : unknown;
    }
    const bundled = PRINTER_REFERENCE.filter(p => matchesIdentity(raw, p));
    if (bundled.length !== 1)
        return unknown;
    const candidate = bundled[0];
    // A selected installation that reassigns either half of the pair overrides this dated reference.
    if (identities.some(p => (normalize(p.name) === normalize(candidate.name) || normalize(p.model_id) === normalize(candidate.model_id)) &&
        (normalize(p.name) !== normalize(candidate.name) || normalize(p.model_id) !== normalize(candidate.model_id))))
        return unknown;
    return { raw, canonical_model: candidate.name, source: 'bundled_reference' };
}
export function printerEvidence(config, sliceInfo, identities, target) {
    const selected = resolvePrinterIdentity(target, identities);
    const saved = resolvePrinterIdentity(config.printer_model ?? config.printer_settings_id, identities);
    return { saved_preset: config.printer_settings_id ?? null, saved, target: selected, sliced: asArray(sliceInfo?.plate).map(p => {
            const identity = resolvePrinterIdentity(meta(p, 'printer_model_id'), identities);
            return { plate_index: Number(meta(p, 'index')) - 1, ...identity, matches_target: identity.canonical_model && selected.canonical_model ? identity.canonical_model === selected.canonical_model : null };
        }) };
}
