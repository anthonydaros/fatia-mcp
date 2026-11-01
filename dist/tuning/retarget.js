// Step 0 of a tuning run: the project for the target printer (P0). Studio's own CLI does the mapping, through the same plan and
// pipeline a "keep" slice uses (planProjectSettings, then sliceSTL with the plan). When a plan exists only its settings are needed,
// so the CLI runs with --export-3mf alone: the target printer's machine, process and filament settings come back merged in a fraction
// of a second, with no plate sliced. Without a plan (an STL, or a 3MF without settings) the project does not exist yet and a real slice
// writes it. Why: an unsliced export of an STL has an empty extruder_nozzle_stats, and the CLI cannot slice such a project
// ("No valid nozzle found"); the slice is what fills it in. See docs/TUNING-WRITER.md.
import fs from "node:fs/promises";
import path from "node:path";
import { loadSafe3mfArchive } from "../safety/archive.js";
import { settingsReport } from "../slicer/project-settings.js";
import { STLManipulator } from "../stl/stl-manipulator.js";
/** A project the CLI can slice has one nozzle entry per extruder; an export that skipped the slice may not. */
async function hasNozzleStats(archive) {
    try {
        const config = JSON.parse(((await (await loadSafe3mfArchive(archive)).file("Metadata/project_settings.config")?.async("string")) ?? "").replace(/^﻿/, ""));
        return Array.isArray(config.extruder_nozzle_stats) && config.extruder_nozzle_stats.length > 0 && config.extruder_nozzle_stats.length === config.nozzle_diameter?.length;
    }
    catch {
        return false;
    }
}
export function studioRetargeter(o) {
    return async (source) => {
        const manipulator = o.manipulator ?? new STLManipulator(o.tempDir);
        const plan = source.toLowerCase().endsWith(".3mf")
            ? await manipulator.planProjectSettings(source, o.slicerPath, o.printerPreset, o.modelCode)
            : undefined;
        const run = async (exportOnly) => {
            // Plate 1 only: the settings are global, and slicing every plate of a big project would cost minutes for nothing.
            const exported = await manipulator.sliceSTL(source, "bambustudio", o.slicerPath, undefined, undefined, o.printerPreset, { projectPlan: plan, exportOnly, ...(plan && !exportOnly ? { slicePlate: 1 } : {}) });
            try {
                return await fs.readFile(exported);
            }
            finally {
                await fs.rm(path.dirname(exported), { recursive: true, force: true });
            }
        };
        let archive = await run(plan !== undefined);
        if (plan && !(await hasNozzleStats(archive)))
            archive = await run(false);
        return {
            archive,
            report: plan ? settingsReport(plan, "keep") : null,
            process: plan?.process,
            edited: plan ? Object.keys(plan.overlay) : [],
        };
    };
}
