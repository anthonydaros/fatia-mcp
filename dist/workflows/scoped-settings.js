import { parseStringPromise } from 'xml2js';
import { MAX_TEXT_CHARS, listObjects, setObjectSettings } from '../tuning/project-text.js';
const list = (v) => v === undefined ? [] : Array.isArray(v) ? v : [v];
export async function buildItems(zip) {
    const text = await zip.file('3D/3dmodel.model')?.async('string');
    if (!text || text.length > MAX_TEXT_CHARS)
        throw Error('Missing or oversized main model');
    const build = text.match(/<build\b[^>]*>[\s\S]*?<\/build>/)?.[0];
    if (!build)
        throw Error('Missing model build items');
    const parsed = await parseStringPromise(build, { explicitArray: false, mergeAttrs: true });
    return list(parsed.build?.item).map(i => { if (typeof i.objectid !== 'string' || !/^\d+$/.test(i.objectid))
        throw Error('Invalid build object identity'); return { objectId: i.objectid, path: i['p:path'] ?? '' }; });
}
export async function applyScopedSettings(zip, modelText, scoped, uniform) {
    const rewritten = new Map(), edits = [];
    if (!scoped.length && !uniform)
        return { modelText, rewritten, edits, uniformItemIndices: [] };
    const items = await buildItems(zip), order = [...new Set(items.map(i => i.objectId))];
    if (items.some(i => i.path))
        throw Error('External build paths make object settings mapping ambiguous');
    const select = (indices) => {
        if (!indices.length || new Set(indices).size !== indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= items.length))
            throw Error('Invalid or duplicate item_indices');
        const ids = new Set(indices.map(i => items[i].objectId));
        for (const id of ids)
            if (items.some((item, i) => item.objectId === id && !indices.includes(i)))
                throw Error('Setting a shared object would affect unselected instances');
        return ids;
    };
    const apply = (ids, settings) => { const objects = listObjects(modelText).filter(o => ids.has(o.id)); if (objects.length !== ids.size)
        throw Error('Object metadata missing or ambiguous'); const r = setObjectSettings(modelText, objects, settings); modelText = r.xml; edits.push(...r.edits); };
    for (const group of scoped)
        apply(select(group.itemIndices), group.settings);
    const uniformItemIndices = uniform?.itemIndices ?? items.map((_, i) => i);
    if (uniform) {
        const height = Number(uniform.height);
        if (!Number.isFinite(height) || height < .05 || height > .6)
            throw Error('Uniform layer height must be .05.. .6 mm');
        const ids = select(uniformItemIndices);
        apply(ids, { layer_height: uniform.height });
        const objects = listObjects(modelText).filter(o => ids.has(o.id));
        for (const object of objects.reverse()) {
            const block = modelText.slice(object.start, object.end);
            const next = block.replace(/(<metadata\s+key="layer_height"\s+value=")[^"]*("[^>]*\/?>)/g, `$1${uniform.height}$2`);
            modelText = modelText.slice(0, object.start) + next + modelText.slice(object.end);
        }
        const verified = (await parseStringPromise(modelText, { explicitArray: false, mergeAttrs: true })).config;
        for (const object of list(verified?.object).filter(o => ids.has(String(o.id))))
            for (const node of [object, ...list(object.part)])
                if (list(node.metadata).some(m => m.key === 'layer_height' && String(m.value) !== uniform.height))
                    throw Error('Unsupported or conflicting layer-height metadata shape');
        // Bambu's importer indexes profiles/ranges by 1-based model-object creation order (first build instance), not 3MF object IDs.
        const ordinals = new Set(order.flatMap((id, i) => ids.has(id) ? [i + 1] : []));
        const profile = await zip.file('Metadata/layer_heights_profile.txt')?.async('string');
        if (profile !== undefined) {
            if (profile.length > MAX_TEXT_CHARS)
                throw Error('Layer profile is too large');
            const seen = new Set();
            const lines = profile.match(/[^\n]*(?:\n|$)/g) ?? [];
            const kept = lines.filter(line => { if (!line.trim())
                return true; const m = /^object_id=(\d+)\|([^\r\n]*)\r?\n?$/.exec(line); if (!m)
                throw Error('Unsupported layer profile format'); const id = Number(m[1]); const values = m[2].split(';').filter(v => v !== '').map(Number); if (id < 1 || id > order.length || seen.has(id) || values.length % 2 || values.some(v => !Number.isFinite(v)))
                throw Error('Ambiguous or malformed layer profile'); seen.add(id); return !ordinals.has(id); }).join('');
            if (kept !== profile)
                rewritten.set('Metadata/layer_heights_profile.txt', kept);
        }
        const ranges = await zip.file('Metadata/layer_config_ranges.xml')?.async('string');
        if (ranges !== undefined) {
            if (ranges.length > MAX_TEXT_CHARS)
                throw Error('Layer ranges are too large');
            await parseStringPromise(ranges);
            const next = ranges.replace(/<object\b[^>]*\bid="(\d+)"[^>]*>[\s\S]*?<\/object>/g, (block, id) => {
                const ordinal = Number(id);
                if (ordinal < 1 || ordinal > order.length)
                    throw Error('Ambiguous layer range object');
                return ordinals.has(ordinal) ? block.replace(/<option\b[^>]*\bopt_key="layer_height"[^>]*>[\s\S]*?<\/option>/g, '') : block;
            });
            const parsed = (await parseStringPromise(next, { explicitArray: false, mergeAttrs: true })).objects;
            const seenRanges = new Set();
            for (const object of list(parsed?.object)) {
                const id = Number(object.id);
                if (seenRanges.has(id) || !Number.isInteger(id) || id < 1 || id > order.length)
                    throw Error('Ambiguous layer range object');
                seenRanges.add(id);
                if (ordinals.has(id) && list(object.range).some(r => list(r.option).some(o => o.opt_key === 'layer_height')))
                    throw Error('Unsupported layer range option shape');
            }
            if (next !== ranges)
                rewritten.set('Metadata/layer_config_ranges.xml', next);
        }
    }
    return { modelText, rewritten, edits, uniformItemIndices: uniform ? uniformItemIndices : [] };
}
