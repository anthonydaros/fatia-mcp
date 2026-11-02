import { summarizeObservedExtrusion } from '../workflows/waste.js';
// The real slice step of prepare_print_project: one candidate project through the existing pipeline (the same plan + sliceSTL a "keep" slice_stl uses,
// one folder per slice, cancellation kills the CLI), then everything the facts need is read from the sliced 3MF and the 41 MB result is deleted.
// Nothing here prints or contacts a printer.
import path from "node:path";
import { sliceResultsFrom } from "../3mf_parser.js";
import { openProject } from "../knowledge/facts/settings.js";
import { streamSafe3mfEntryFromFile } from "../safety/archive.js";
import { removeQuietly } from "../stl/stl-manipulator.js";
import { readConfigBlock } from "./config-block.js";
import { scanGcodeStream } from "./gcode-scan.js";
import { scanHints, sliceFacts } from "./slice-facts.js";
const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const HEAD_BYTES = 4 * 2 ** 20; // the CONFIG_BLOCK is at the top of the G-code
async function scanWithConfig(output, plateIndex, options) {
    const name = `Metadata/plate_${plateIndex + 1}.gcode`;
    const stream = await streamSafe3mfEntryFromFile(output, name);
    const chunks = [];
    let size = 0;
    async function* captureHead() {
        for await (const chunk of stream) {
            if (size < HEAD_BYTES) {
                const prefix = chunk.subarray(0, HEAD_BYTES - size);
                chunks.push(Buffer.from(prefix));
                size += prefix.length;
            }
            yield chunk;
        }
    }
    // Consume through EOF so the scanner and archive size/CRC checks still verify the entire plate.
    const gcode = await scanGcodeStream(captureHead(), { source: `${path.basename(output)}:${name}`, ...options });
    return { gcode, block: readConfigBlock(Buffer.concat(chunks, size).toString("utf8")) };
}
/** A project file in, the scanned plate out (`plateIndex` overrides the one the slicer was built with: the layout stage renumbers the plates). Throws when the CLI fails or is cancelled. */
export function studioSlicer(o) {
    return async (project, signal, plateOverride) => {
        const started = Date.now();
        const plateIndex = plateOverride ?? o.plateIndex;
        const plan = await o.manipulator.planProjectSettings(project, o.slicerPath, o.printerPreset, o.modelCode);
        const output = await o.manipulator.sliceSTL(project, "bambustudio", o.slicerPath, undefined, undefined, o.printerPreset, { ...o.bambuOptions, ...(plan ? { projectPlan: plan } : {}), slicePlate: plateIndex + 1 }, signal);
        try {
            const opened = await openProject(output);
            let filamentSequence;
            try {
                filamentSequence = JSON.parse((await opened.read?.("Metadata/filament_sequence.json"))?.toString("utf8") ?? "");
            }
            catch { /* absent or unreadable: the grouping fact stays blind */ }
            const { gcode, block } = await scanWithConfig(output, plateIndex, { signal, ...scanHints(opened.sliceInfo, plateIndex) });
            return { gcode, slice: { sliceInfo: opened.sliceInfo, filamentSequence, source: path.basename(output) }, block, ms: Date.now() - started };
        }
        finally {
            await removeQuietly(path.dirname(output));
        }
    };
}
/**
 * Every plate of a project in ONE CLI call (`--slice 0`): each plate's predicted time and weight from the slice result and its G-code scanned for
 * the travels that cross extrusion. This is how the layout stage measures a candidate. Throws when the CLI fails or is cancelled.
 */
export function studioAllPlatesSlicer(o) {
    return async (project, signal) => {
        const plan = await o.manipulator.planProjectSettings(project, o.slicerPath, o.printerPreset, o.modelCode);
        const output = await o.manipulator.sliceSTL(project, "bambustudio", o.slicerPath, undefined, undefined, o.printerPreset, { ...o.bambuOptions, ...(plan ? { projectPlan: plan } : {}), slicePlate: 0 }, signal);
        try {
            const opened = await openProject(output);
            const out = [];
            for (const info of sliceResultsFrom(opened.sliceInfo)) {
                if (!Number.isInteger(info.index) || info.index < 1)
                    continue;
                const plateIndex = info.index - 1;
                const { gcode, block } = await scanWithConfig(output, plateIndex, { signal, ...scanHints(opened.sliceInfo, plateIndex) });
                const facts = sliceFacts({ plateIndex, sliceInfo: opened.sliceInfo, gcode, source: path.basename(output) }).facts;
                const node = list(opened.sliceInfo?.plate).find(p => list(p?.metadata).some(m => m?.key === "index" && Number(m.value) === info.index));
                const maps = list(node?.metadata).find(m => m?.key === "filament_maps")?.value;
                const crossing = gcode.facts["gcode.unprotected_travel_crossing_count"];
                out.push({
                    gcode_complete: gcode.complete, block, metrics: gcode.facts, observed_extrusion: summarizeObservedExtrusion(gcode),
                    plate: info.index, time_s: typeof facts["plate.time_s"] === "number" ? facts["plate.time_s"] : null, weight_g: typeof facts["plate.weight_g"] === "number" ? facts["plate.weight_g"] : null,
                    crossing: typeof crossing === "number" ? crossing : null,
                    ...(typeof maps === "string" ? { filament_maps: maps.trim().split(/\s+/).map(Number).filter(Number.isFinite) } : {}),
                    warnings: info.warnings.map(w => String(w.msg ?? "")).filter(Boolean),
                });
            }
            return out;
        }
        finally {
            await removeQuietly(path.dirname(output));
        }
    };
}
