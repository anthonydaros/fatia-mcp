# prepare_print_project: from a part to a tuned project

`prepare_print_project` takes a part (a 3MF project or an STL) and delivers a **new, unsliced project 3MF** with tuned slicing parameters. You open it in Bambu Studio, press slice and print yourself. The tool never prints, never contacts a printer, and never modifies the original (its SHA-256 is taken before and after). Internally it slices with the Bambu Studio CLI and reads the G-code, so the tuning is checked against what the slicer actually produced, not only against rules. Blender is not part of this loop.

Code: `src/tuning/prepare.ts` (the loop), `prepare-report.ts` (verdict and report), `prepare-slice.ts` (the real slice step), `prepare-tool.ts` (the MCP definition). It is built on the engine (`engine.ts`), the writer (`project-writer.ts`, [TUNING-WRITER.md](./TUNING-WRITER.md)), the G-code scanner and the fact collector ([TUNING-FACTS.md](./TUNING-FACTS.md)).

## The loop

1. **P0.** The project for the target printer with nothing tuned (a project made for the same printer is P0 as it is; another printer's project, an STL, or a 3MF without settings is retargeted first). Its settings are the engine's base.
2. **Baseline.** P0 is sliced once and scanned. This is the "before" of the report. It is not engine state: the engine never sees it, except when round 0 turns out to change nothing (the candidate is then P0 itself, and the baseline's measurements stand for it without another slice).
3. **Round 0.** Facts known before any slice (the project's settings, the mesh, the declared part facts) go to `applyTuning`. The result is written as a candidate project, sliced, scanned.
4. **Round k.** The facts of the last slice go to `nextRound`: ladders step one level (z-hop and travel, support, thin features), choices and definite actions stay as they were. The new settings are written, sliced, scanned.
5. **Stop** at the first of: `done` (no trigger fires and the engine has nothing to change), `stalled` (nothing to change and not done, for example a trigger that needs a fact nobody declared), `exhausted` (every ladder that still fires is out of steps), `cycle` (the next candidate has the settings hash of an earlier round, caught before it is sliced), `budget_slices`, `budget_minutes`, `cancelled`, `error` (a slice failed), or `dry_run`.
6. **Best round.** Of the measured rounds, the one with the fewest true triggers, then the fewest blockers, then the shortest print time, then the later round. If a later round is worse than an earlier one on triggers, the earlier one is delivered and the report says so (caveat `earlier_round_delivered`). A failed slice on round k stops the loop and delivers the best of the rounds before it, with the error in the report. A cancellation delivers nothing.
7. **Deliver.** The best round is written again to `output_dir` (default `prepared/` under the server's `TEMP_DIR`; never beside the source; a name that exists gets a numeric suffix, nothing is overwritten). The source's SHA-256 is checked. `preflight_check` judges the deliverable too. It cannot read `mesh.size_*` from a 3MF, so the structure, volume and mesh blocker rules (for example `bambu.x2d.main-volume-exceeded`) are evaluated by the loop itself, on the mesh and project facts it already holds, in the same pass as the G-code blocker rules; a blocker rule whose facts are missing is listed under `unseen`, never passed silently. If the deliverable cannot be written (an unwritable `output_dir`), the run ends as `error` with the whole report and history, and nothing is delivered. The file is then opened, unsliced, in Bambu Studio unless `open_in_studio` is false; a failure to open is a warning.

Every candidate is written by `writeTunedProject` from the original source, re-opened and checked by the writer, and sliced through the existing pipeline (`planProjectSettings` plus `sliceSTL`, one folder per slice, cancellation kills the CLI). The sliced 3MF is deleted after the scan; only the report keeps the numbers. The knowledge-base overlay is always laid on top of the project's own settings: the original is never the only source.

## Budget

- `max_slices` (default 12, 2 to 50) counts every CLI slice: the baseline, each tuned round, and the one-off slice an STL (or a 3MF without settings) needs to be retargeted. A big plate takes minutes per slice.
- `max_minutes` (default 20) is checked before each slice: the loop starts another only if the time spent plus the last slice's duration still fits.
- A stop by budget is a caveat, never `ready`. The report lists what the engine wanted next and did not run (`pending_next_round`).
- `dry_run` builds the plan from the project's own data (settings, mesh, declared facts), writes nothing that is kept and slices nothing. It needs a project the Studio export can retarget without slicing (a 3MF with settings); it delivers no file and its verdict is always `not_ready`.
- `apply: "recommended"` (default) writes values of confidence `preset`, `oficial`, `bug conhecido`, `teste de revisor` and `relato`; `hipotese` and `nao verificado` stay suggestions (`suggestions_not_applied`), except ladder steps, which a measured trigger checks every round and which are reported as weak when applied. `"strong_only"` writes only `preset`, `oficial` and `bug conhecido`.

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

- `verdict`, `reasons` (each `not_ready` reason and caveat, with its code), `stop` (reason, detail, rounds measured, slices used split into loop and retarget, minutes), `delivered` (path, round, why this round, whether it was opened), `source` (SHA-256 before and after).
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
- The default output folder is under `TEMP_DIR`; when the server made that folder itself it is deleted when the server exits. Set `TEMP_DIR` or `output_dir` to keep the file.
- Absent list-valued keys: the engine's `studio-keys.json` is not shipped, so a tuned key missing from the project is written as a scalar with a warning from the writer.
- The new file is not opened in a GUI by the tests; that Studio shows the tuned keys as modified follows from `different_settings_to_system` and is unconfirmed.
- Windows: paths use `node:path`; no POSIX command is run; not run on Windows.

## Measured

On macOS with Bambu Studio 02.08.04.57 and Node 24:

- `dry_run` on the 17-plate H2D sample (retarget H2D to X2D by the Studio export, 193 changed keys, mesh and plan): 2.6 s through the MCP server. On the X2D-sliced sample (41 MB plate): 1.2 s. Neither slices.
- A cube STL (`test/sample_cube.stl`) through the real CLI: the retarget slice and the baseline slice, then `done` at round 0 with no change (nothing pre-slice applied without a part description), 546 s estimated, 0.66 g, 49 z-hop lifts, 1 unprotected travel.
- `tests/prepare-loop.test.mjs` plays 25 scripted scenarios against the real writer, engine, collector and report with a fake slicer. `tests/prepare-e2e.test.mjs` is the real-CLI case (skipped without the CLI): an STL declared as a rigid mold (its `relato` rules are written by default; the strength rules are `hipotese`, so only suggestions), `max_slices` 3, then a fourth slice of the delivered project to compare its CONFIG_BLOCK with the tuned values.
