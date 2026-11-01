# prepare_print_project: from a part to a tuned project

`prepare_print_project` takes a part (a 3MF project or an STL) and delivers a **new, unsliced project 3MF** with tuned slicing parameters. You open it in Bambu Studio, press slice and print yourself. The tool never prints, never contacts a printer, and never modifies the original (its SHA-256 is taken before and after). Internally it slices with the Bambu Studio CLI and reads the G-code, so the tuning is checked against what the slicer actually produced, not only against rules. Blender is not part of this loop.

Code: `src/tuning/prepare.ts` (the loop), `prepare-report.ts` (verdict and report), `prepare-slice.ts` (the real slice steps), `prepare-tool.ts` (the MCP definition), `layout.ts`, `layout-plan.ts`, `layout-writer.ts` and `layout-stage.ts` (the layout stage). It is built on the engine (`engine.ts`), the writer (`project-writer.ts`, [TUNING-WRITER.md](./TUNING-WRITER.md)), the G-code scanner and the fact collector ([TUNING-FACTS.md](./TUNING-FACTS.md)).

## The loop

1. **P0.** The project for the target printer with nothing tuned (a project made for the same printer is P0 as it is; another printer's project, an STL, or a 3MF without settings is retargeted first). Its settings are the engine's base.
1b. **Layout.** Between P0 and the baseline, [the layout stage](#layout) checks the objects against the target printer's plates and, when something is wrong or a better number of plates exists, writes a laid-out copy of P0 that the baseline and every later round are built on.
2. **Baseline.** P0 (laid out, if the layout stage changed it) is sliced once and scanned. This is the "before" of the report. It is not engine state: the engine never sees it, except when round 0 turns out to change nothing (the candidate is then P0 itself, and the baseline's measurements stand for it without another slice).
3. **Round 0.** Facts known before any slice (the project's settings, the mesh, the declared part facts) go to `applyTuning`. The result is written as a candidate project, sliced, scanned.
4. **Round k.** The facts of the last slice go to `nextRound`: ladders step one level (z-hop and travel, support, thin features), choices and definite actions stay as they were. The new settings are written, sliced, scanned.
5. **Stop** at the first of: `done` (no trigger fires and the engine has nothing to change), `stalled` (nothing to change and not done, for example a trigger that needs a fact nobody declared), `exhausted` (every ladder that still fires is out of steps), `cycle` (the next candidate has the settings hash of an earlier round, caught before it is sliced), `budget_slices`, `budget_minutes`, `cancelled`, `error` (a slice failed), or `dry_run`.
6. **Best round.** Of the measured rounds, the one with the fewest true triggers, then the fewest blockers, then the shortest print time, then the later round. If a later round is worse than an earlier one on triggers, the earlier one is delivered and the report says so (caveat `earlier_round_delivered`). A failed slice on round k stops the loop and delivers the best of the rounds before it, with the error in the report. A cancellation delivers nothing.
7. **Deliver.** The best round is written again to `output_dir` (default `~/.fatia-mcp/outputs` (or `FATIA_OUTPUT_DIR`); never beside the source; a name that exists gets a numeric suffix, nothing is overwritten). The source's SHA-256 is checked. `preflight_check` judges the deliverable too. It cannot read `mesh.size_*` from a 3MF, so the structure, volume and mesh blocker rules (for example `bambu.x2d.main-volume-exceeded`) are evaluated by the loop itself, on the mesh and project facts it already holds, in the same pass as the G-code blocker rules; a blocker rule whose facts are missing is listed under `unseen`, never passed silently. If the deliverable cannot be written (an unwritable `output_dir`), the run ends as `error` with the whole report and history, and nothing is delivered. The file is then opened, unsliced, in Bambu Studio unless `open_in_studio` is false; a failure to open is a warning.

Every candidate is written by `writeTunedProject` from the original source, re-opened and checked by the writer, and sliced through the existing pipeline (`planProjectSettings` plus `sliceSTL`, one folder per slice, cancellation kills the CLI). The sliced 3MF is deleted after the scan; only the report keeps the numbers. The knowledge-base overlay is always laid on top of the project's own settings: the original is never the only source.

## Layout

A project made for another printer (or by hand) keeps its objects at the world coordinates its author gave them, but Bambu Studio puts plate *i* of the **target** printer on its own grid: `cols = ceil(sqrt(plateCount))`, a cell of the bed size times 1.2, and the plate's origin at `(col x cellX, -row x cellY)`. The 17-plate H2D sample (bed 350 x 320, cell 420 x 384) retargeted to the X2D (256 x 256, cell 307.2) keeps every object where it was: 15 of the 17 lie outside their X2D plate, between plates or across an edge. The retarget alone never moved anything (it only warned), so the tool now has a layout stage, automatic by default, that detects this and fixes it.

Argument `layout`: `"auto"` (default), `"check_only"` (analysis and plan only: it reports the issues and the plan, slices nothing, writes nothing, and the delivered project keeps its layout) or `"off"` (skip the stage; the old string warning stays). `layout_gap_mm`, `layout_margin_mm`, `layout_max_slices` and `layout_max_minutes` below. A `dry_run` runs the analysis and the planner and never slices: the candidates are listed unmeasured, the choice is the planner's default and the report says so; the layout is not applied.

### 1. Analysis (`layout.ts`)

Every printable build item gets its world bounding box (item and component transforms applied, as `mesh-read.ts` does), its filament slots (the part-level extruder of each normal part, else the object's) and its colour class (the sorted slots, plus `+paint` for a painted object). The plate comes from `model_settings.config`; the target geometry comes from the retargeted project: `printable_area`, `printable_height`, `extruder_printable_area` and `extruder_printable_height` per nozzle, and the filament-to-nozzle map `filament_map`. The issues, each with evidence and its fix:

| kind | meaning |
|---|---|
| `outside_plate` | the object is on no part of its plate (it stands on another plate, or in no plate at all) |
| `straddling` | it sticks out of its plate's edge (the edges and millimetres are in the evidence) |
| `between_plates` | it touches only other plates, partly (in the gap between plates, at a corner) |
| `outside_nozzle_area` | inside the bed but outside the area its nozzle can reach (the X2D's second nozzle cannot reach x below 20.5) |
| `overlap` | two neighbours on a plate are closer than the minimum (2 mm, or twice the brim width when the project has a brim: brims touching) |
| `too_tall` | taller than the lowest height limit of its nozzles |
| `bed_changed` | the source printer's bed differs from the target's (the old "bed is larger" warning, now with its fix) |
| `locked_plate` | a plate is locked in `model_settings.config` |
| `plate_assignment` | an instance is on no plate or on two |
| `blocker` | the planner could not fit the object in any bin (below) |

The analysis also reports each plate's utilisation (the objects' bounding-box areas over the bed area). A locked plate is never touched and its objects are not judged; since the grid depends on the number of plates, the stage changes nothing at all while any plate is locked.

### 2. Policy and planner (`layout-plan.ts`)

- **One colour class per plate, never mixed.** The class is the set of filament slots; with `filament_map_mode` automatic a plate that mixed colours would also need filament swaps on every layer (the retargeted project has `enable_prime_tower` 0 in the sample).
- **Rotations: only 0 and 90 degrees about Z**, about the object's bounding-box centre. The authors' tilt (the sample's compartments are tilted 45 degrees about X) is kept.
- **Gap and margin.** Default gap `max(8 mm, 2 x brim width + 2 mm)` when the project has a brim (`brim_type` other than `no_brim` and a positive `brim_width`; the sample's `auto_brim` of 5 mm gives 12 mm), else 8 mm; default margin to the edge of the usable area 5 mm. Configurable: `layout_gap_mm`, `layout_margin_mm`.
- **The bin of a class** is the printable rectangle of the nozzle its filaments map to (the intersection when it uses several) and the lowest height limit of those nozzles. An object that fits no bin in either rotation, or is taller than the limit, is a `blocker`: reported, nothing moves, no layout is applied, and the verdict is `not_ready`.
- **Packing** is MaxRects with best-short-side-fit over four item orders (area, longest side, height, shortest side); the fewest plates any order finds is the minimum (the report also gives the area lower bound). Used extents are centred on the plate. At most 500 objects (more is refused as a failure, not a crash) and a work counter against hostile input.
- **Candidates** (default 3 whole-project layouts, plus the reference): the fewest plates; then +1 and +2 plates for the largest class (by footprint x height) with the objects spread by estimated print volume (longest first into the lightest plate that still has room); and the **reference**, the project as the authors laid it out moved onto the target's grid (each plate keeps its objects and their positions relative to the plate; one that no longer fits is centred; unavailable when it cannot be made valid), built when the project has at most 20 plates (past that a clean project is left alone and a project with problems gets no reference).

### 3. Cost-benefit by measurement

Every candidate is written (and proven, below) and sliced with the Studio CLI in **one call** (`--slice 0`, all its plates). Each plate's predicted time and weight come from the slice result, its G-code is scanned (`gcode.unprotected_travel_crossing_count`), and the nozzle each filament was sliced on is read from `slice_info.config` (`filament_maps`; a mismatch with the project's `filament_map` would show there). The choice:

1. the lowest **total** predicted time (the sum over plates is what one printer needs);
2. candidates within 3% of that total are tied: the smaller longest-plate time, then fewer objects on the fullest plate, then fewer plates, then the candidate's order;
3. the **reference** (the authors' layout moved onto the target's grid, one object per plate in the sample) is measured and listed, but it counts only when its total is more than 3% below every proposal's: with one object per plate its longest plate is the longest single object, so by construction it would win every tie, and the slicer's estimate does not price starting and clearing 17 plates or 17 first layers that must stick (measured on the sample, the 4, 5, 6 and 17 plate layouts differ by under 1% in total time);
4. a project that already has no layout problem keeps its layout (it is the incumbent) unless another candidate is more than 3% faster in total; with no problem and no more plates than the planner needs, nothing is sliced at all.

The report's `layout.candidates` lists all of them (plates, objects per plate, colour classes, per-plate time, total, longest plate, weight, crossing travels per plate, nozzle maps as sliced, and why one was not measured) and `layout.chosen.reason` says why the winner won.

**Budget.** The layout has its own slicing budget, separate from `max_slices`: `layout_max_slices` (default 6, one per candidate) and `layout_max_minutes` (default 12, checked before each slice with the last slice's duration, like the loop). If it stops candidate evaluation early the best measured candidate is applied and the report says so (`layout.budget.stopped_early`, caveat `layout_budget`). With no candidate measured (no slicer, every slice failed) the planner's default, the fewest plates, is applied and the report says it was not measured. The reference is measured last because it has the most plates.

**What the estimate does not capture** (it is in the report as `layout.not_verified` and `unseen.layout`): a failure ruins a whole plate, and more objects on one plate is more at risk when one detaches or a travel knocks one over; bed adhesion, warping and real cooling of tall thin walls on a crowded plate are not simulated; and if the filament-to-nozzle grouping is automatic, Studio may regroup at slice time.

### 4. The written project (`layout-writer.ts`)

The laid-out project is made from P0 by text splicing only: the `transform` of each `<item>` in `3D/3dmodel.model` (new `tx`, `ty`; for a quarter turn `M' = M x Rz(90)` in the row-vector convention with `t' = (t - c) x Rz + c'`, `c` the old bounding-box centre; `tz` never changes so every object stays on the bed) and the `<plate>` blocks of `Metadata/model_settings.config`, rebuilt from the first plate (new `plater_id` and `plater_name` such as "Frame - black" or "Filament 2 - grey (2/3)", `locked` false, `filament_map_mode` as in the template, the four picture lines dropped, each `model_instance` copied with its `identify_id`). The stale plate pictures (`plate_N.png`, `plate_no_light_N.png`, `top_N.png`, `pick_N.png`, `*_small.png`) are removed with their relationship entries, `filament_sequence.json` keeps one empty entry per plate, and every other entry keeps its bytes, place and compression. `wipe_tower_x/_y` are left alone (Studio keeps them too). The source is never written, an existing output is never overwritten, and a project that already holds slice results is refused.

The output is then **opened again and analysed again**: zero outside, straddling or overlapping objects, every object on exactly one plate, the plate count as planned, the object count and the total mesh volume unchanged (1e-6 relative), every object's centre, size and height where the plan put them, every other entry byte-identical. A failed check deletes the output and is an error.

### 5. In the loop

The loop's writer takes the laid-out copy as its source (`writeTunedProject({ source, origin })`): `origin` keeps the retarget summary, the combined diff and the SHA-256 checks against the user's file. The tuning loop still measures **one plate**: after a layout change it is the plate with the longest predicted time, unless the caller passed `plate_index`, which then means the new numbering (`part.plate_index` and `part.plate_why` say which). The verdict: a layout the tool could not fix (blocker, locked plate, `check_only` with issues standing) is `not_ready` (`layout_unfixed`); a layout chosen on slicer estimates is the caveat `layout_estimate_only` and a line under `predicted_only`; a stop by the layout budget is `layout_budget`; a locked plate is `layout_locked`. The Portuguese `resumo` has a short block ("17 mesas -> 4 mesas, ...").

### Not verified

No GUI was run: that Studio shows the plates as written, keeps the objects where they were put and does not complain about the missing plate pictures (the model's `Thumbnail_Middle` metadata still names `Metadata/plate_1.png`) follows from the file format and the CLI and is unconfirmed. The packer works on bounding boxes: a tilted object's box is larger than its footprint, so plates are less full than they could be. A bed that is not a rectangle is approximated by its bounding box (a note says so). The grid formula was measured on the 17-plate H2D sample and Studio's CLI output, not on every printer.

## Budget

- `max_slices` (default 12, 2 to 50) counts every CLI slice: the baseline, each tuned round, the final all-plate verification, and the one-off slice an STL (or a 3MF without settings) needs to be retargeted. A big plate takes minutes per slice.
- `max_minutes` (default 20) is checked before each slice: the loop starts another only if the time spent plus the last slice's duration still fits.
- A stop by budget is a caveat, never `ready`. The report lists what the engine wanted next and did not run (`pending_next_round`).
- `dry_run` builds the plan from the project's own data (settings, mesh, declared facts), writes nothing that is kept and slices nothing. It needs a project the Studio export can retarget without slicing (a 3MF with settings); it delivers no file and its verdict is always `not_ready`.
- `apply: "recommended"` (default) writes values of confidence `preset`, `oficial`, `bug conhecido`, `teste de revisor` and `relato`; `hipotese` and `nao verificado` stay suggestions (`suggestions_not_applied`), except ladder steps, which a measured trigger checks every round and which are reported as weak when applied. `"strong_only"` writes only `preset`, `oficial` and `bug conhecido` values; ladder steps that a measured trigger checks are still applied (reported as weak).

## What the caller declares (`part_context`)

No file says whether a part is functional, a mold, tall and narrow, or a keychain. The user does. The tool description tells the calling agent to put in `part_context` only what the user said, in their words, and to leave out the rest: an undeclared key stays unknown, the actions that need it are skipped, and the report lists them with the facts that would enable them (`skipped.declare_to_enable`). The guide gives no threshold for "large", "tall and narrow" or "tiny", so geometry is never turned into a declaration; `part.questions_for_the_user` shows the numbers for the user to judge. Keys: `kind`, `load_class`, `mold_kind` (`none` only if the user said it is not a mold), and the booleans `is_large_part`, `is_tall_narrow`, `is_tiny_part`, `has_fit_pins_and_holes`, `has_tight_fit_male_part`, `is_cut_part`, `is_cut_pin`. A declaration is plate-wide. Declared facts that decided a change are listed as an unchecked-declaration caveat, because nothing measures them.

## The verdict

`not_ready` when any of: a blocker-severity rule fires (one decided by the delivered round's G-code, mesh or project facts, or one `preflight_check` found in the deliverable), a slice failed, the call was cancelled, nothing was measured, the source changed during the run, or it was a dry run.

`ready` only when the loop ended `done`, none of the above holds, **and** none of these caveats applies. Otherwise `ready_with_caveats`. The caveats:

| code | meaning |
|---|---|
| `budget` | stopped by `max_slices` or `max_minutes` |
| `not_converged` | stopped `stalled` or `cycle` |
| `earlier_round_delivered` | the best round is not the last measured one |
| `exhausted_ladders` | a ladder ran out of steps and its trigger still fires (the guide's `exhausted` text is in `ladders.exhausted`) |
| `unresolved_trigger` | a trigger still fires in the delivered round |
| `predicted_only_applied` | a change was applied by a rule or a part fact and no measurement can confirm its effect |
| `weak_steps_applied` | a `hipotese` or `nao verificado` ladder step was applied |
| `slicer_warnings` | Bambu Studio itself warned about the delivered slice (the messages are in the caveat and in `verified.measured.slicer_warnings`) |
| `blind_facts` | a fact no analyzer can give is holding a decision back |
| `declared_unchecked` | a change rests on a fact you declared, which nothing measures |
| `preflight_unavailable` | `preflight_check` could not judge the deliverable |

So `ready` means: in the last measured slice the engine found nothing left that it can see, and everything it applied was measured. It does not mean the print will succeed. With most of the knowledge-base rules weak (computed from the shipped base: 165 of the 213 Bambu Studio rules, 77%, carry `relato`, `hipotese` or `nao verificado`; 81% of all 320 are `relato` or `hipotese`) and no printer to validate anything, most real runs end `ready_with_caveats`, and the report never says every possibility was tested: it says what was tried, what was measured, and what is only a guess.

## Reading the report

JSON, plus `resumo`: a short Portuguese markdown summary to show the user.

- `verdict`, `reasons` (each `not_ready` reason and caveat, with its code), `stop` (reason, detail, rounds measured, slices used split into loop, retarget and final verification, minutes), `delivered` (path, round, why this round, whether it was opened), `source` (SHA-256 before and after).
- `diff`: `retarget` (printer ids before and after, what the plan kept and could not keep, the keys that changed original to P0), `tuning` (P0 to delivered), `combined_vs_original`. Each tuning entry has `key`, `from` (the original's value), `to`, `scope`, `action`, `why`, `confidence`, `risk`, guide `src`, `rules`, `round` (the round that wrote the final value), `first_round`, `verified`, `verification` and `reached_slice`.
- `verification.status` is `verified` when a measurement bears on the change: for a ladder step, the trigger fact measured after the step (`outcome` `cleared` or `not_cleared`, with the fact's value before and after); a choice is always `predicted_only` (the engine does not compare its evaluating facts with a target, and a file cannot show the real effect), and the facts are named in the note. Anything else is `predicted_only`, with the facts that fired it. `reached_slice` is true when the slice's own CONFIG_BLOCK shows the tuned value, false when the slicer used another, and null when it cannot be lined up (an unverified key is never reported as ok).
- `metrics`: before (baseline) and after (delivered) for print time, weight, unprotected travels, crossing travels, support weight and others, with the delta. The weight may or may not include purge and tower: compare it only between slices of the same project.
- `history`: per round the settings hash, whether the slice ran or reused the baseline, time, weight, the metrics, the engine's changes, which triggers were true, unknown and false, exhausted ladders, blockers.
- `verified`, `predicted_only`, `unseen`: the three buckets. VERIFIED is what was measured on the G-code, the slice result, the mesh or the 3MF. PREDICTED ONLY is what fired from part facts or guide rules. UNSEEN is what the engine cannot see: blind facts and why, blocker rules the facts cannot decide (and `preflight_unchecked`, the rules `preflight_check` could not judge, with its reasons), actions skipped for lack of a part description, the share of weak rules, and the fact that no printer validated warping, adhesion or surface quality.
- `suggestions_not_applied`, `skipped`, `ladders` (unresolved and exhausted), `pending_next_round`, `blockers` (`preflight`: what `preflight_check` found; `gcode`: blocker rules decided on the run's own facts, which despite the name also covers the structure, volume and mesh ones), `untouched_risks` (the rules with no setting to change for this printer: hardware checks such as nozzle clearance, loose screws, wet filament; filtered by printer, not by material; tips are counted, not listed), `warnings`.

## Limits

- No printer is owned: nothing here was validated on a real print. The reference printer is the X2D; other models work through the same path but the knowledge base is written for the X2D, A1 and H2D.
- Only the X2D-relevant facts the scanner has seen in a real file are measured; a fact it cannot stand behind is left out and named in `unseen`. Several mesh facts and six project facts are not implemented (listed in TUNING-FACTS.md), so some ladders cannot move.
- `plate_index` above 0 slices that plate with the CLI's `--slice N` and reads `Metadata/plate_N.gcode`; this was not run on a real multi-plate project beyond plate 1.
- An STL, or a 3MF without settings, costs one real retarget slice before the baseline. `dry_run` refuses it.
- Delivered projects persist in `~/.fatia-mcp/outputs` (or `FATIA_OUTPUT_DIR` / per-call `output_dir`). Automatically created `TEMP_DIR` scratch is removed at server exit.
- Absent list-valued keys: the engine's `studio-keys.json` is not shipped, so a tuned key missing from the project is written as a scalar with a warning from the writer.
- The new file is not opened in a GUI by the tests; that Studio shows the tuned keys as modified follows from `different_settings_to_system` and is unconfirmed.
- Windows: paths use `node:path`; no POSIX command is run; not run on Windows.

## Measured

On macOS with Bambu Studio 02.08.04.57 and Node 24:

- `dry_run` on the 17-plate H2D sample (retarget H2D to X2D by the Studio export, 193 changed keys, mesh and plan): 2.6 s through the MCP server. On the X2D-sliced sample (41 MB plate): 1.2 s. Neither slices.
- The layout stage on the 17-plate H2D sample retargeted to the X2D (through the MCP server, 5.0 to 5.6 minutes in all in three runs, of which the 4 layout slices took 63 to 80 s each): 15 of the 17 objects outside, straddling or between plates, `bed_changed` for 350 x 320 against 256 x 256. Predicted time over all plates, untuned: 4 plates (the frame alone, 4, 5 and 7 compartments) 71 h 22 min with the longest plate 28 h 03 min; 5 plates 71 h 43 min, longest 19 h 09 min; 6 plates (frame, then 3, 3, 4, 3 and 3 compartments) 71 h 54 min, longest 12 h 55 min; the 17 plates of the authors, moved onto the X2D grid, 71 h 41 min, longest 11 h 04 min (the frame). Totals differ by under 1%; by the rule the 6-plate layout was chosen (the 17-plate one sits out of the tie as the reference). Repeated slices of the same file vary by a few seconds in the estimate. Weight 2077 g to 2104 g over all plates. The nozzle map as sliced was `[1, 1]` on every plate.
- A cube STL (`test/sample_cube.stl`) through the real CLI: the retarget slice and the baseline slice, then `done` at round 0 with no change (nothing pre-slice applied without a part description), 546 s estimated, 0.66 g, 49 z-hop lifts, 1 unprotected travel.
- `tests/prepare-loop.test.mjs` plays scripted scenarios (the layout stage included) against the real writer, engine, collector and report with a fake slicer. `tests/prepare-e2e.test.mjs` is the real-CLI case (skipped without the CLI): an STL declared as a rigid mold (its `relato` rules are written by default; the strength rules are `hipotese`, so only suggestions), `max_slices` 3, then a fourth slice of the delivered project to compare its CONFIG_BLOCK with the tuned values.

## Choosing the delivered round, and the check of every plate
- The delivered round is the one with the fewest true triggers, then the fewest blockers, then the least problem left under the triggers (the measured values of the facts the true triggers read, added up), then the shortest print time, then the later round. A round that is faster but keeps 1,228 unprotected travels no longer wins over one that has 1.
- The loop slices and judges one plate. When the delivered project has more than one plate, the tool slices every plate once more and reports it as `verification_all_plates` (per plate: time, weight, unprotected travels that cross extrusion, slicer warnings). This check never creates new adjustments: a plate that still has crossing travels is the caveat `other_plates_unresolved`, so the verdict cannot be `ready`.
