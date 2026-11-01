// The real slice step of prepare_print_project: one candidate project through the existing pipeline (the same plan + sliceSTL a "keep" slice_stl uses,
// one folder per slice, cancellation kills the CLI), then everything the facts need is read from the sliced 3MF and the 41 MB result is deleted.
// Nothing here prints or contacts a printer.
import path from "node:path";
import type { Readable } from "node:stream";
import { openProject } from "../knowledge/facts/settings.js";
import { streamSafe3mfEntryFromFile } from "../safety/archive.js";
import { removeQuietly, type BambuSliceOptions, type STLManipulator } from "../stl/stl-manipulator.js";
import { readConfigBlock } from "./config-block.js";
import { scanPlateGcode } from "./gcode-scan.js";
import type { SliceOutcome } from "./prepare.js";
import { scanHints } from "./slice-facts.js";

export interface StudioSliceOptions {
  manipulator: STLManipulator;
  slicerPath: string;
  /** "Bambu Lab X2D 0.4 nozzle" */
  printerPreset: string;
  /** Profile-name code of the model, "X2D" */
  modelCode: string;
  /** 0-based. */
  plateIndex: number;
  /** The same bed / nozzle options slice_stl passes. */
  bambuOptions?: BambuSliceOptions;
}

const HEAD_BYTES = 4 * 2 ** 20; // the CONFIG_BLOCK is at the top of the G-code

async function head(stream: Readable, bytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    if (size >= bytes) break; // leaving the loop destroys the stream
  }
  return Buffer.concat(chunks).toString("utf8", 0, bytes);
}

/** A project file in, the scanned plate out. Throws when the CLI fails or is cancelled. */
export function studioSlicer(o: StudioSliceOptions): (project: string, signal?: AbortSignal) => Promise<SliceOutcome> {
  return async (project, signal) => {
    const started = Date.now();
    const plan = await o.manipulator.planProjectSettings(project, o.slicerPath, o.printerPreset, o.modelCode);
    const output = await o.manipulator.sliceSTL(
      project, "bambustudio", o.slicerPath, undefined, undefined, o.printerPreset,
      { ...o.bambuOptions, ...(plan ? { projectPlan: plan } : {}), slicePlate: o.plateIndex + 1 }, signal);
    try {
      const opened = await openProject(output);
      let filamentSequence: unknown;
      try { filamentSequence = JSON.parse((await opened.read?.("Metadata/filament_sequence.json"))?.toString("utf8") ?? ""); } catch { /* absent or unreadable: the grouping fact stays blind */ }
      const gcodeName = `Metadata/plate_${o.plateIndex + 1}.gcode`;
      const gcode = await scanPlateGcode(output, o.plateIndex, { signal, ...scanHints(opened.sliceInfo, o.plateIndex) });
      const block = readConfigBlock(await head(await streamSafe3mfEntryFromFile(output, gcodeName), HEAD_BYTES));
      return { gcode, slice: { sliceInfo: opened.sliceInfo, filamentSequence, source: path.basename(output) }, block, ms: Date.now() - started };
    } finally {
      await removeQuietly(path.dirname(output));
    }
  };
}
