// The MCP definition of prepare_print_project and the validation of its arguments. The loop itself is prepare.ts.
import type { LayoutInput } from "./prepare.js";
import { PART_BOOLEANS, PART_ENUMS } from "./part-context.js";

export const PREPARE_TOOLS = [
  {
    name: "prepare_print_project",
    description: [
      "Turn a part (a 3MF project or an STL) into a NEW project 3MF with tuned slicing parameters, ready for the user to open in Bambu Studio, slice and print THEMSELVES. It never prints and never contacts a printer; the original file is never modified (its SHA-256 is checked before and after) and the output never overwrites a file.",
      "It reads the part, lays the knowledge-base overlay on top of the project's own settings (never only the original's), then loops: slice with the Bambu Studio CLI, read the G-code, adjust, slice again (z-hop travels that can knock the part over, brim only when needed, warping, support, walls...) until the engine has nothing more to change, a ladder runs out of steps, it repeats itself, the budget ends, or you cancel. Every round is kept and the best measured one is delivered. First it slices the retargeted, untuned project once as the 'before' baseline.",
      "Returns a report (JSON plus a short Portuguese 'resumo' to show the user): verdict ready | ready_with_caveats | not_ready with the reasons; the diff (retarget, tuning, combined versus the original) where every change carries its confidence tag, guide source, rule ids, the round it came in and whether it is VERIFIED (measured on the G-code, slice result, mesh or 3MF, with the fact and its before/after) or PREDICTED ONLY; before/after metrics; the history per round; weak suggestions NOT applied; actions skipped because the part was not described (with the facts to declare); exhausted ladders with the guide's text; blind facts; and untouched risks (hardware checks the engine cannot change). Report the verdict honestly: 'ready' means the engine found nothing left to fix and everything it applied was measured; it is never 'every possibility was tested'. Say what was tried and what was measured, and what is only a guess (most knowledge-base rules are weak: relato, hipotese, nao verificado), and that no printer validated anything.",
      "Layout (automatic by default, layout: auto): after the printer retarget it checks that every object stands inside its plate on the TARGET printer's plate grid (outside the plate, straddling an edge, between plates, too close or overlapping, out of the nozzle's reach, too tall, a locked plate) and, when something is wrong or the project uses more plates than it needs, re-lays it out by a fixed policy: one colour (filament set) per plate and never mixed, split across plates, only 0 or 90 degree turns about Z (the authors' tilt is kept), a gap of max(8 mm, 2 x brim + 2 mm) between objects and 5 mm to the edge. The number of plates is decided by MEASURING: each candidate (the fewest plates, then +1 and +2 for the largest colour, and the project as authored moved onto the new grid, which is a measuring stick that wins only when more than 3% faster than every proposal) is sliced with the Studio CLI in one call and the lowest total predicted time over all plates wins (layouts within 3% are tied: smaller longest plate first). The report's `layout` section lists the issues with evidence, the policy, a table of every candidate (plates, objects per plate, total and longest time, weight, crossing travels per plate), the chosen layout plate by plate and what the slicer estimate cannot see (a failure ruins a whole plate, adhesion, real cooling). layout: check_only reports the issues and the plan and changes nothing; layout: off skips the stage. A locked plate or an object that fits no plate is not fixed and makes the verdict not_ready. The layout has its own slicing budget (layout_max_slices default 6, layout_max_minutes default 12), separate from max_slices. After a layout change the tuning loop measures the plate with the longest predicted time, unless plate_index is passed (then it means the NEW numbering).",
      "part_context: declare ONLY what the user told you about the part, in their own words, because no file says it. Set a key when the user said it (true when they said the part is so; false only when they said it is not) and LEAVE IT OUT otherwise: an undeclared key stays unknown, the actions that need it are skipped and listed in the report (skipped.declare_to_enable), never guessed. Do not infer anything from the file name, from how the model looks or from its size: the guide gives no threshold for large, tall-and-narrow or tiny parts, so ask the user (the report's part.questions_for_the_user has the numbers) and call again with the answer. Keys: kind (keychain, pix_plate, face_down_plate or other); load_class (none = decorative; functional = holds, fits or moves something; high_load = takes load or impact, such as a hook or bracket); mold_kind (rigid = plaster, cement or wax poured into it; silicone = a box that silicone is poured into; none ONLY if the user said it is not a mold); booleans is_large_part, is_tall_narrow, is_tiny_part, has_fit_pins_and_holes, has_tight_fit_male_part, is_cut_part, is_cut_pin.",
      "Budget: max_slices (default 12) counts every CLI slice, the baseline, an STL's one-off retarget slice and final all-plate verification included; max_minutes (default 20) is checked before each slice, using the last slice's duration. A stop by budget is a caveat, never 'ready'. dry_run builds the plan from the project's own data without slicing anything (needs a 3MF; nothing is delivered). apply 'recommended' writes preset, oficial, bug conhecido, teste de revisor and relato values; hipotese and nao verificado stay suggestions, except ladder steps that a measured trigger checks (reported as weak). 'strong_only' writes only preset, oficial and bug conhecido values, but ladder steps that a measured trigger checks are still applied (reported as weak). Slicing takes minutes per round on a big plate (and per layout candidate): the call reports progress, layout stage included. The output defaults to ~/.fatia-mcp/outputs (or FATIA_OUTPUT_DIR); set output_dir to keep it elsewhere.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Local .3mf project (also a .gcode.3mf) or .stl. Never modified." },
        plate_index: { type: "integer", minimum: 0, description: "0-based plate of a multi-plate 3MF to slice and judge. Default 0, or the plate with the longest predicted time after a layout change. When passed, it means the NEW numbering if the layout rewrote the plates." },
        bambu_model: { type: "string", description: "Printer the user will slice for (x2d, a1, h2d, ...). Default BAMBU_MODEL; the reference printer is the X2D. A project made for another printer is retargeted first." },
        part_context: {
          type: "object",
          additionalProperties: false,
          description: "What the user said about the part; leave a key out when they did not say it. Never infer from the file.",
          properties: {
            ...Object.fromEntries(Object.entries(PART_ENUMS).map(([key, values]) => [key, { type: "string", enum: [...values] }])),
            ...Object.fromEntries(PART_BOOLEANS.map(key => [key, { type: "boolean" }])),
          },
        },
        max_slices: { type: "integer", minimum: 2, maximum: 50, description: "Most CLI slices in all (retarget, baseline, tuned rounds and final verification). Default 12." },
        max_minutes: { type: "number", minimum: 1, maximum: 240, description: "Wall-clock budget in minutes. Default 20." },
        output_dir: { type: "string", description: "Folder for the new project. Default: ~/.fatia-mcp/outputs (or FATIA_OUTPUT_DIR)." },
        output_name: { type: "string", description: "File name of the new project (not a path). Default <source>_tuned.3mf; a name that exists gets a numeric suffix." },
        open_in_studio: { type: "boolean", description: "Open the new, unsliced project in Bambu Studio for review. Default true; a failure to open is a warning." },
        apply: { type: "string", enum: ["recommended", "strong_only"], description: "Which confidences are written. Default recommended." },
        dry_run: { type: "boolean", description: "Plan only: no slicing, nothing delivered (the layout is analysed and planned, its candidates unmeasured). Default false." },
        layout: { type: "string", enum: ["auto", "check_only", "off"], description: "auto (default): fix the layout, deciding the number of plates by measurement. check_only: report the issues and the plan, change nothing. off: skip the layout stage." },
        layout_gap_mm: { type: "number", minimum: 0, maximum: 100, description: "Edge-to-edge gap between objects on a plate. Default max(8, 2 x brim width + 2 when the project has a brim)." },
        layout_margin_mm: { type: "number", minimum: 0, maximum: 50, description: "Distance kept from the edge of the usable area. Default 5." },
        layout_max_slices: { type: "integer", minimum: 1, maximum: 20, description: "CLI slices the layout candidates may use (one per candidate, all its plates). Separate from max_slices. Default 6." },
        layout_max_minutes: { type: "number", minimum: 1, maximum: 240, description: "Wall-clock minutes the layout candidates may take. Separate from max_minutes. Default 12." },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
] as const;

export interface PrepareArgs {
  path: string;
  plateIndex: number;
  plateIndexExplicit: boolean;
  layout: LayoutInput;
  model?: string;
  partContext?: unknown;
  maxSlices: number;
  maxMinutes: number;
  outputDir?: string;
  outputName?: string;
  openInStudio: boolean;
  apply: "recommended" | "strong_only";
  dryRun: boolean;
}

const ALLOWED = Object.keys(PREPARE_TOOLS[0].inputSchema.properties);

/** Strict: a typo or a wrong type is an error that says what to send, never silently ignored. */
export function parsePrepareArgs(args: Record<string, unknown> | undefined): PrepareArgs {
  const a = args ?? {};
  for (const key of Object.keys(a)) if (!ALLOWED.includes(key)) throw new Error(`Unknown argument "${key}". Allowed: ${ALLOWED.join(", ")}.`);
  const text = (name: string, value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
    return value.trim();
  };
  const integer = (name: string, value: unknown, min: number, max: number, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const flag = (name: string, value: unknown, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new Error(`${name} must be true or false.`);
    return value;
  };
  const number = (name: string, value: unknown, min: number, max: number): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number from ${min} to ${max}.`);
    return value;
  };
  if (a.layout !== undefined && a.layout !== "auto" && a.layout !== "check_only" && a.layout !== "off") throw new Error('layout must be "auto", "check_only" or "off".');
  const filePath = text("path", a.path);
  if (!filePath) throw new Error("Missing required parameter: path");
  const maxMinutes = a.max_minutes === undefined ? 20 : a.max_minutes;
  if (typeof maxMinutes !== "number" || !Number.isFinite(maxMinutes) || maxMinutes < 1 || maxMinutes > 240) throw new Error("max_minutes must be a number from 1 to 240.");
  if (a.apply !== undefined && a.apply !== "recommended" && a.apply !== "strong_only") throw new Error('apply must be "recommended" or "strong_only".');
  return {
    path: filePath,
    plateIndex: integer("plate_index", a.plate_index, 0, 9999, 0),
    plateIndexExplicit: a.plate_index !== undefined,
    layout: {
      mode: (a.layout as LayoutInput["mode"] | undefined) ?? "auto", gapMm: number("layout_gap_mm", a.layout_gap_mm, 0, 100), marginMm: number("layout_margin_mm", a.layout_margin_mm, 0, 50),
      maxSlices: a.layout_max_slices === undefined ? undefined : integer("layout_max_slices", a.layout_max_slices, 1, 20, 6), maxMinutes: number("layout_max_minutes", a.layout_max_minutes, 1, 240),
    },
    model: text("bambu_model", a.bambu_model),
    partContext: a.part_context,
    maxSlices: integer("max_slices", a.max_slices, 2, 50, 12),
    maxMinutes,
    outputDir: text("output_dir", a.output_dir),
    outputName: text("output_name", a.output_name),
    openInStudio: flag("open_in_studio", a.open_in_studio, true),
    apply: (a.apply as PrepareArgs["apply"] | undefined) ?? "recommended",
    dryRun: flag("dry_run", a.dry_run, false),
  };
}
