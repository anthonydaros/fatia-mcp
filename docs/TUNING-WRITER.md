# Tuning writer: retarget and tuned project

`src/tuning/project-writer.ts` turns (source project, target printer, engine settings and per-object overrides) into a NEW unsliced project 3MF. The source is never written (its SHA-256 is taken before and after). `src/tuning/retarget.ts` builds the target-printer project (P0); `src/tuning/config-block.ts` reads a slice's CONFIG_BLOCK back. Everything below was measured with the Bambu Studio 02.08.04.57 CLI, headless, on macOS and an X2D target; Windows paths are written with `node:path` but not run.

## What the Studio CLI does with settings (measured)

`BambuStudio --help` states the priority: command line, then `--load-settings`/`--load-filaments`, then the 3MF. Slicing a project whose `project_settings.config` was edited (sparse_infill_pattern gyroid, z_hop 0.8, z_hop_types Slope Lift, filament_flow_ratio 0.93, outer_wall_speed 150 on the Bowden elements, object wall_loops 5):

| slice | process key | z_hop / z_hop_types | filament key | `elements` key | object override |
|---|---|---|---|---|---|
| CLI, 3MF only | gyroid | 0.8,0.8 / Slope Lift | 0.93 | 200,150 | 16 inner-wall moves (layer 25) |
| pipeline `keep`, before this work | gyroid | **0.4,0.4 / Auto Lift** | **0.98** | 200,150 | 16 |
| pipeline `keep`, now | gyroid | 0.8,0.8 / Slope Lift | 0.93 | 200,150 | 16 |
| unedited baseline | grid | 0.4,0.4 / Auto Lift | 0.98 | 200,50 | 4 |

The pipeline always passes `--load-settings machine;process` and `--load-filaments`, so the 3MF's machine and filament values were replaced by the presets (the 3MF's `different_settings_to_system` is not read by the CLI, which recomputes it: a slice of the tuned project reports `enable_prime_tower;;`). Process keys survived because the Phase-1 plan overlays them. A tuned printer or filament key was therefore silently dropped.

## How `keep` decides (src/slicer/project-settings.ts)

- Process: a project made for the target printer (`printer_settings_id` equals the preset) keeps every process key that differs from the process preset, plus every key it lists in `different_settings_to_system[0]` even when the sparse preset lacks it; a project from another printer keeps only the listed keys, mapped onto the target's extruder variants. This matters because the CLI does not always take a key the preset lacks from the 3MF: measured on the cube (X2D), 11 of the 54 process keys the engine can emit are in no process file of the chain (`alternate_extra_wall`, `brim_type`, `ensure_vertical_shell_thickness`, `filament_map_mode`, `flush_multiplier`, `initial_layer_flow_ratio`, `min_bead_width`, `min_feature_size`, `support_critical_regions_only`, `support_remove_small_overhang`, `wall_sequence`). With the plan overlaying only keys the preset has, `wall_sequence` was silently reset (tuned `inner-outer-inner wall`, G-code `inner wall/outer wall`) while the other nine reached the G-code; with the listed keys overlaid too, they all do. A key that is neither in the preset nor listed cannot be known as edited, so the writer always lists what it tunes. `post_process` (it runs a script) is never carried from a 3MF.
- Printer and filament edits (new): for a project made for the target printer, the keys it lists in the last entry (printer) and in each filament's entry are carried in `plan.machineOverlay` and `plan.filaments[].overlay`, and `sliceSTL` merges them onto the flattened machine and filament files before `isolateMachineSettings`. Printer keys are limited to the retraction family (`retract*`, `deretraction_speed`, `z_hop*`, `travel_slope`, `wipe`, `wipe_distance`); filament keys exclude G-code and preset identity; hardware and G-code keys stay with the preset because the 3MF is untrusted. A filament vector holds one value per slot, or per slot and extruder variant (12 for two X2D filaments): each slot takes its slice. A project from another printer still carries none of this (unchanged `not_kept` lines).
- So `different_settings_to_system` is the carrier: the writer lists every requested key in the entry of its scope, and the plan keeps what is listed. This includes a key whose value is already the project's: a hand-edited project holds its edits without listing them (repro: `z_hop` 0.8 and `filament_flow_ratio` 0.93 hand-edited into the X2D sample with the list left at `enable_prime_tower`; requested again, they were reported unchanged and not listed, the keep slice gave 0.4 and 0.98; listed, the plan carries `z_hop` and both slots' `filament_flow_ratio` and the CONFIG_BLOCK shows `0.8,0.8` and `0.93,0.93`). Listing a value equal to the preset is harmless: the plan skips it.

Sweep of the engine's keys (every process, filament and printer key in `tuning.json`, 81 distinct; 71 written with a value different from the project's, 70 changed after the writer's no-op check, 10 skipped because every candidate equals the default): written, then sliced through `keep` for the X2D and read back with `checkBlockValue`. Before the fix 68 of 70 matched the CONFIG_BLOCK (`wall_sequence`, `filament_map_mode` did not); after it 69 of 70. The one left is `filament_map_mode` (tuned `Auto For Match`, G-code `Auto For Flush`): it is a per-plate setting, the CLI takes it from the `<plate>` of `model_settings.config` and ignores the project value, so the writer warns for it instead of claiming it. Writing the plate metadata was not tried. (`ensure_vertical_shell_thickness` with the engine's value `partial` matched; a hand-written `ensure_all` came back as `enabled`, so only the engine's own values are covered.)

## Retarget (P0)

When the project's printer differs, `studioRetargeter` runs the Phase-1 plan and then the pipeline with `--export-3mf` and no `--slice`: 0.24 s on the 17-plate H2D sample, no G-code. Only the export's `project_settings.config` is used; every other entry is the original's (the CLI re-serializes UUIDs and order). The writer then sets `print_settings_id` back to the plan's system preset (the export names it "... (project settings)") and adds the plan's overlay keys to `different_settings_to_system[0]`. The result keeps the retarget and the tuning apart: `retarget` (printer ids before/after, kept/not_kept, filament map, `changed_keys` original to P0), `changed_keys` (P0 to delivered, with scope), and `combined_diff` (original to delivered). Long values are abbreviated in the two diffs. A warning is added when the source bed is larger than the target's (H2D 350x320, X2D 256x256).

An STL, or a 3MF without settings, has no plan: a real slice with the printer's defaults writes the project, and the writer strips the slice results. The unsliced export was tried first and is not enough: its `extruder_nozzle_stats` is empty and the CLI cannot slice it ("No valid nozzle found"). The same fallback runs when a retarget export has no nozzle stats (plate 1 only).

## The written file

- Same entry names, order and stored/deflated choice; every entry the run does not mean to change is byte-identical (`dropped_entries`, `rewritten_entries` list the rest).
- `project_settings.config` and `model_settings.config` are edited as text: only the changed list elements, scalars or XML attributes are replaced (BOM, CRLF, indent, key order stay). A scalar fills every element of a list key, or only those whose label in `elements.index_by` starts with `elements.starts_with`; a list must keep its length; a key the project lacks is appended with a warning.
- `different_settings_to_system` is `[process, filament 1..N, printer]`, each entry the keys joined with `;` in byte order (the sample: `outer_wall_speed;sparse_infill_pattern`,,,). A filament key goes to every slot (a scalar fills them all, and the keep slice drops a slot's value that is not listed). Created if missing, rebuilt with a warning if its length is wrong.
- Per-object overrides are `<metadata key=".." value=".."/>` lines inside the `<object>` (how Studio stores an object's own config), escaped, for the objects named by id or exact name (default all).
- Stale slice results: dropped `Metadata/plate_N.gcode`, `.gcode.md5`, `plate_N.json` and the relationship entry that points at the G-code; `slice_info.config` keeps its header only (what an unsliced Studio save carries); `gcode_file` in `model_settings.config` becomes empty (what the CLI writes for an unsliced plate); `Metadata/filament_sequence.json` (the slicer's filament-to-nozzle grouping per plate) goes back to Studio's unsliced form for every plate, `{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]}`. Measured on the 17-plate H2D sample, the CLI's unsliced export against its `--slice 1` export: the entries that differ for the slice itself are `plate_1.gcode`, `.gcode.md5`, `plate_1.json`, the `.rels` entry, `slice_info.config`, `gcode_file` and `filament_sequence.json` (plate 1 empty before, `nozzle_sequence [1]`, `optimal_assignment [0,0]` after); the rest differ because `--slice 1` exports plate 1 only. A `filament_sequence.json` that is not a JSON object is copied as it is, with a warning. Thumbnails (`plate_N.png`, `plate_N_small.png`, `plate_no_light_N.png`, `top_N.png`, `pick_N.png`) stay: they render geometry, not toolpaths (the sliced and the unsliced export of the same cube produce byte-identical ones).
- The metadata text is scanned in one forward pass (no regex that backtracks over the whole file): measured on hostile 2 MB inputs (whitespace runs, 300k unclosed `<plate>` or `<Relationship`, 80k nested `<object>`) every scan takes under 120 ms, and `writeTunedProject` on 2-5 KB archives expanding to 2 MB took 64-117 ms. A `model_settings.config` with more than 5000 `<object>` is refused.
- The new file is written to a temp file and renamed onto a name reserved with `wx` (a numeric suffix when taken; the source always exists, so it is never chosen). Then it is re-opened: archive integrity (CRC, names, traversal), entry list, every untouched entry byte-identical, `project_settings.config` equal to P0 plus exactly the intended values, `model_settings.config` well-formed with the same object count. A failure deletes the output and throws.

## Not verified

- No GUI was run. That Studio opens the file and shows the tuned keys as modified (from `different_settings_to_system`) follows its saved-file format but is unconfirmed; the CLI loads and slices the file.
- A retargeted file mixes versions: `project_settings.config` is written by the installed CLI (`version` 02.08.04.57), `3D/3dmodel.model` still says the original's Application. Whether Studio cares was not tested.
- A single-nozzle source retargeted to a dual-nozzle target (or the reverse) was not tried.
- Keys outside the printer allowlist or G-code keys are reported in `not_kept`, never carried; a tuning that needs one must widen `MACHINE_EDITS` on purpose.
- `expectedBlockElements` lines a project list up with the extruders and filaments in the G-code; a list that does not line up is reported as unverified, never as ok.

## A laid-out source (`origin`)

When the layout stage has written a laid-out copy of P0 (see "Layout" in TUNING.md), the loop builds every candidate on that copy: `writeTunedProject({ source: laidOut, origin: { path: original, retarget } })`. The copy is already for the target printer, so nothing is retargeted again; `origin` makes the SHA-256 checks (before and after) cover the user's file as well as the copy, the combined diff go from the user's original to the delivered project, and the retarget summary be the one the first P0 write produced.

## Use

```ts
const retarget = studioRetargeter({ slicerPath, tempDir, printerPreset: "Bambu Lab X2D 0.4 nozzle", modelCode: "X2D" });
const result = await writeTunedProject({ source, output, target: { printerPreset }, retarget,
  changes: [{ key: "z_hop", value: "0.8", scope: "printer" }], objectOverrides: { settings: { wall_loops: "5" } } });
```
Engine items map one to one: `{ key, value: item.to, scope: item.scope }` for process, filament and printer; `object_overrides` goes to `objectOverrides.settings`. To check a delivered file: slice it (keep, same model), `readConfigBlock` the G-code and `checkBlockValue(config, block, key, scope)` per changed key.
