# Tuning facts: mesh analysis, declared part facts, and the per-round collector

`src/tuning/mesh-read.ts` and `mesh-facts.ts` measure the `mesh.*` facts from the geometry of one plate (3MF) or one STL. `src/tuning/part-context.ts` takes the `object.*` facts nobody can compute from the user or the agent. `src/tuning/facts.ts` merges everything one round knows into the flat fact map the engine takes. Spec: `kb/tuning/out/analyzer-spec.md` sections 3, 7 and 8. Measured on macOS with Node 24 and the Bambu Studio 02.08.04.57 sample; Windows paths are written with `node:path` but not run.

## Reading the mesh

- 3MF: the build items of the chosen plate (through `model_settings.config` plate instances, `printable` items only), the model parts only (modifier, negative and support volumes are skipped, like Studio's box), every component tree. Row vectors: `v' = v*M + t`, the component transform first and the build item last; a transform that mirrors (negative determinant) swaps two corners of each triangle so faces keep facing out. Limits: 3,000,000 triangles and 9,000,000 vertices over all instances (an instance copies every vertex of its object, referenced or not), 256 MiB per model entry, 8 levels of components, 10,000 instances, 64 KB per XML tag; a vertex that is not finite, a triangle that names a vertex that does not exist, a bad transform or an unterminated tag ends in a blind result with that reason. The reason never repeats text from the file (an object is named by its order, `object #2`): it reaches the report.
- Inside-out meshes: each model part of a 3MF, and the whole STL, is checked by its signed volume (a linear sum over the triangles); when it is negative the winding is reversed (two corners swapped), because Studio repairs a reversed winding and slices the part like a normal one. Without this a reversed low pyramid (100 x 100 x 10 mm, sides at 11 degrees) read as 10,198.039 mm2 of overhang (measured on the facts stage, which trusts the winding it is given). It is meaningful for closed meshes; an open surface has no sign and is left as it is when the volume is not negative.
- STL: binary through three's `STLLoader` (the parser `STLManipulator.loadSTL` wraps); ASCII by a linear scan for `vertex x y z` lines (three's ASCII regex is quadratic on a facet that never ends, and runs before any cap), with the triangle cap checked while scanning. A binary header count that does not fit the file size is not trusted. Units are taken as millimetres.
- A 3MF with no geometry (a GUI-sliced export) or without the chosen plate comes back with every `mesh.*` fact blind and the reason in the evidence, never as zeros.

## Facts

| Fact | How | Cost |
|---|---|---|
| `mesh.size_x_mm`, `size_y_mm`, `height_mm`, `max_object_height_mm`, `bbox_max_dim_mm`, `min_z_mm` | box of the transformed vertices, the largest over the plate's objects | linear |
| `mesh.footprint_area_mm2`, `height_to_footprint` | smallest XY box area over the objects; largest `height / sqrt(box area)`. The inputs of "tall and narrow"; they are numbers, never a verdict | linear |
| `mesh.triangle_count` | triangles read | linear |
| `mesh.flat_bottom_area_mm2` | downward faces within 2 degrees of horizontal whose centroid is within 0.02 mm of the object's lowest point | linear |
| `mesh.flat_bottom_share` (repo side, evidence only) | flat bottom over the XY box footprint (not the convex hull) | linear |
| `mesh.top_surface_levels` | upward faces within 2 degrees of horizontal, centroid Z chained at 0.05 mm, level area >= 1 mm2; the largest count over the objects | linear |
| `mesh.unsupported_overhang_area_mm2` | see below | linear + vertical rays |
| `mesh.flat_ceiling_area_mm2` (repo side, evidence only) | downward faces within the bridge band (2 degrees), not on the bed, not resting on lower geometry | linear + vertical rays |

`mesh.min_feature_mm`, `has_slender_protrusions`, `fit_hole_count`, `has_cylindrical_walls` and `object.flat_cut_or_pin_base_on_bed` (spec step 5) are not implemented: they come back blind with "not implemented".

The repo-side facts are declared in `REPO_MESH_FACTS` (`mesh-facts.ts`), not in the shipped knowledge base (`knowledge/` is a copy of `kb/`, which is read-only here). No tuning action reads them.

## `mesh.unsupported_overhang_area_mm2` and the false-positive guard

The spec's first definition counted every downward face flatter than `support_threshold_angle` (30 degrees from horizontal), not on the bed, with a minimum region span. On plate 1 of the desk-organizer sample that is **1422.8 mm2** (reproduced: `details.classicOverhangAreaMm2` = 1422.761, 35 regions), yet Studio sliced the plate with `enable_support = 0` and no support (the G-code scan of the real plate: 0 support lines, 2241 `Bridge` segments of 0.617 g, 471 `Overhang wall` segments of 0.206 g), so `tune.support.enable-for-overhangs` (`mesh.unsupported_overhang_area_mm2 > 0` and no support lines) would have switched supports on in round 1. `tests/mesh-facts.test.mjs` runs the shipped ladder on both numbers.

**What the sample really is.** The spec read the 3 large regions as flat ceilings (648, 262 and 78 mm2 at z 172, 150 and 147). They are not flat. By angle from horizontal the 1422.8 mm2 split into 7.5 degrees: 217.2 mm2, 22.5 degrees: 1200.4 mm2 and about 5 mm2 spread over 18.7 to 29.1 degrees. Those two angles are the midpoints of 15 degree steps, which is what a tessellated curve gives (an interpretation, not checked against the source model); the part is printed tilted 45 degrees. The 3 large regions are 2, 50 and 19 faces, 100 mm long, with a rise (Z extent) of 2.48, 1.2 and 0.7 mm; the 32 small ones are 13.6 mm2 with a rise of 0.3 to 0.4 mm. **The sample has no flat ceiling at all** (`mesh.flat_ceiling_area_mm2` = 0). A guard that only separated flat ceilings from the rest would have left the false positive in place.

**What Studio itself does with those faces (measured).** The plate was retargeted to the X2D and sliced headless with the Studio 02.08.04.57 CLI, twice, only `enable_support` changed. Support off: 0 support lines, 2228 `Bridge` segments (0.548 g), 471 `Overhang wall` segments (0.203 g). Support on (`tree(auto)`, 30 degrees): **60,613 support lines, 20.0 g, from z 0.2 up to 173 mm**. So by Studio's own 30 degree rule these faces ARE overhangs, and the sample is only proof that this part prints without support (its designer says "No supports"; the user's slice has none). Geometry alone cannot tell the two apart, which is why the fact is not allowed to answer "0" or "needs support" for them.

The fact has three answers:
1. **A number**: the area of downward **sloped** faces strictly between the bridge band and the threshold angle (from `support_threshold_angle`; 30 when absent, or 0, which is automatic in Studio), not on the bed (centroid more than 0.05 mm above the object's lowest point), joined into regions by shared welded vertices, **keeping only regions** whose largest XY extent is at least `minRegionSpanMm` **and** whose Z extent is at least `minRiseMm`, minus the faces that rest on lower geometry (a vertical ray down from the face centroid meets a surface within `support_top_z_distance + layer_height`). A positive number is a clear overhang.
2. **Zero**: no sloped face of that kind at all (tiny regions under the span are bridges and small holes and do not count).
3. **Unknown (blind, with the reason)**: no clear overhang, and either (a) a **free flat ceiling** of at least `minRegionSpanMm` squared (9 mm2) exists, or (b) short sloped regions exist (span ok, rise under `minRiseMm`). (a) is an anchored bridge, which Studio bridges, or a flat cantilever (a mushroom cap, a T, a shelf), which needs support, and the mesh cannot tell which (that needs the anchoring of the region's edges, not implemented). A 0 there would be wrong in the dangerous direction: three shipped actions read the fact with `eq 0` (`tune.walls.fit-parts-order`, `tune.materials.pla-x2d-aux-fan`, and the wall-order choice's guard), and with a mushroom and `has_fit_pins_and_holes` declared the engine APPLIED the wall-order change that its own text forbids for a part with a face that asks for support. The reason names the ceiling area, or the short regions' area and tallest rise. A blind fact does not hold `done` back; it reaches the report as UNSEEN.

Flat ceilings are reported apart in `mesh.flat_ceiling_area_mm2` and are never counted in the number: with a clear sloped overhang next to a cap the fact still gives that overhang's area. The (a) test compares the TOTAL free flat-ceiling area with 9 mm2, not each connected region: many tiny free ceilings (a lattice of small hole tops) add up to blind, the safe side. Below 9 mm2 in total (a small hole top) the fact stays a known 0.

Implementation constants (`MESH_CONSTANTS`; **chosen, not guide values; none validated on a printer**; they are repeated in the evidence notes of the fact):

| Constant | Value | Why |
|---|---|---|
| `horizontalDeg` | 2 | the spec's own "horizontal" tolerance for top levels and the flat bottom |
| `bridgeBandDeg` | 2 | a downward face this close to horizontal is a flat ceiling Studio bridges, not an overhang; equal to `horizontalDeg` so no new tolerance appears |
| `minRegionSpanMm` | 3 | the spec's proposal for "a bridge or hole too small to matter" |
| `minRiseMm` | 5 | the line between a clear overhang and an undecidable one. Below 30 degrees a region's horizontal reach is at least `rise / tan(30)` = 1.7 times its rise, so 5 mm is a reach of 8.7 mm or more. It only decides when the fact is willing to give a number: the tallest sloped region of the sample rises 2.48 mm. Chosen above that single known print, not fitted on a printer |
| rest distance | `support_top_z_distance + layer_height` (0.4 on the sample) | the spec's starting point |
| ray grid cell, ray epsilon | 3 mm, 0.001 mm | geometry bookkeeping |

Result on the sample: `mesh.unsupported_overhang_area_mm2` is **unknown** (`ambiguous: 1422.761 mm2 of sloped faces ... the tallest rises 2.477 mm`), so the ladder cannot move; with the spec's number it would have. The ladder also depends on `project.support_painted`, which this task does not compute (see the collector).

**What the guard costs, and what the report must say.**
- A flat **cantilever** (a mushroom cap, a T, a shelf) is a flat ceiling, so it is not counted in the number, and with no sloped overhang the fact is **unknown**, not 0 (see answer 3a). Its area appears in `mesh.flat_ceiling_area_mm2`. The synthetic test shows it: a 50 x 50 flat cap on a 10 x 10 pillar gives 2400 mm2 of flat ceiling and an unknown overhang; `tests/tuning-facts-collector.test.mjs` shows that `tune.walls.fit-parts-order` then stays quiet while a naive 0 applies it. The same holds for an anchored bridge: a part with a large flat ceiling is UNSEEN for support until it is sliced and the G-code is read (the report reads the blind reason; nothing else reads `mesh.flat_ceiling_area_mm2`).
- A sloped overhang that rises less than 5 mm is not counted either (a 20 degree wing of 10 mm reach has a 3.6 mm rise): next to a clear overhang it is named in the notes (`droppedByRiseMm2`), alone it makes the fact unknown. A real but short overhang is therefore never a number; the report must carry the `UNSEEN` reason.
- The fact is a **prediction from geometry** (`predictive: true` in the evidence), not a measurement of a slice.
- `support_on_build_plate_only = 1` is noted, not modelled.

**Sampling.** Rays are one per face centroid, capped at 200,000 per call (`maxRays`) and shared between the flat ceilings and the kept sloped regions; over the cap the faces are stride-sampled, each ray stands for `stride` faces, and the evidence says `approx: true` and "stride-sampled". More than 2,000,000 triangles in an object, more than 3e8 triangle tests (charged before each ray's loop, so a ray that hits early cannot skip the budget), or more than 32,000,000 grid entries (128 MB, counted before the grid is filled) make the two ray facts blind (`mesh.top_surface_levels` is linear and stays) (`malha grande` / "work budget"); a sampled number or zero is still reported with `approx: true`. The grid has at most 2001 x 2001 cells whatever the shape or the coordinates of the part (the cell grows past 3 mm for a box longer than 6 m). Measured on hostile meshes (one process, Node 24, macOS): 10,000 and 40,000 stacked 180 mm triangles end blind in about 40 ms with +13 and +16 MB; a 1e9 x 0.01 mm ceiling, a 4e9 mm one and a 1e12 mm coordinate take under 1 ms; a 2 mm wide sloped face 1e10 mm long takes under 1 ms (one ray); and a 3MF that fans 100,000 unreferenced vertices out over 2,000 instances is refused by the vertex budget (`tests/mesh-facts.test.mjs` bounds the memory growth of each of these).

**`mesh.top_surface_levels`.** The spec also proposed dropping faces covered by geometry above (a vertical ray up) to avoid counting a closed cavity floor. Its own validated count keeps them: with that filter the sample gave 1 level, without it 3 (z 179.246: 484.7 mm2, z 13.201: 237.2 mm2, z 6.6: 60.2 mm2; the spec's validated 179.25 / 484.7, 13.2 / 237.2, 6.6 / 60.2). The filter is not applied; a closed internal cavity floor would count as a level.

## Numbers measured

Sample `models/desk-organizer.3mf` (17 plates, made for the H2D), plate 1 (object 18, tilted 45 degrees), settings of the project:

| Fact | Value |
|---|---|
| box | x 115.373 to 234.627, y 100.375 to 219.625, z 0 to 179.248 (the spec's validated box); size 119.254 x 119.251 x 179.248 |
| triangles | 10,432 |
| `mesh.footprint_area_mm2`, `height_to_footprint` | 14221.09, 1.503 |
| `mesh.flat_bottom_area_mm2` | 1685.021 |
| `mesh.top_surface_levels` | 3 |
| spec's overhang definition | 1422.761 mm2 (35 regions) |
| `mesh.flat_ceiling_area_mm2` | 0 |
| `mesh.unsupported_overhang_area_mm2` | unknown (blind: 1422.761 mm2 in short sloped regions, tallest 2.477 mm) |

Time on plate 1, the plate with the most triangles (the other 16 have 1,226 to 4,078): `openProject` 35 ms (180 ms for the sliced 3MF, which also holds the 41 MB G-code), mesh read + parse + analysis about 28 ms the first time in a fresh process (28.4, 27.4, 27.6 ms in three runs), 10 to 14 ms warm. All 17 plates together in one process: about 110 ms (37 ms for plate 1, 2 to 9 ms for the others). All 17 plates give the same answer for the same reason (only short sloped regions, no flat ceiling at all): unknown.

Synthetic ruffled sheet, facing down so the ray path runs (STL read included, one process): 125,000 triangles 0.65 s with 102,400 rays, exact; 980,000 triangles 1.8 s, 199,733 rays, sampled; 2,000,000 triangles 2.5 s, 179,953 rays, sampled, +665 MB RSS.

## Declared part facts (`part-context.ts`)

`parsePartContext` validates a plain object of: `kind` (keychain, pix_plate, face_down_plate, other), `load_class` (none, functional, high_load), `mold_kind` (rigid, silicone, none), and the booleans `is_large_part`, `is_tall_narrow`, `is_tiny_part`, `has_fit_pins_and_holes`, `has_tight_fit_male_part`, `is_cut_part`, `is_cut_pin`. Unknown keys, values outside the vocabulary and non-booleans throw with the key and the allowed values; nothing is coerced. The vocabulary is the data's own (a test checks every literal `tuning.json` compares these facts with). The one addition is `mold_kind: "none"`, the way to say "not a mold": without it the five `mold.*` actions and `walls.fit-parts-order` stay unknown instead of false. A declaration is plate-wide; per-object declarations are not represented.

`partContextFacts` gives `object.*` facts with provenance `declared`. `declarationImpact(actions, provided)` lists, per declarable fact, the actions that read it (14 for `object.load_class`) with the other non-settings facts each still needs, so "declare this" is not promised where it would not be enough. `skippedByUndeclared(roundResult)` turns an engine result into "N actions were skipped because the part was not described: ...". `suggestDeclarations(meshFacts)` offers questions for `is_tall_narrow`, `is_tiny_part` and `is_large_part` with the numbers behind them and **no value and no threshold** (the guide gives none).

## The collector (`facts.ts`)

`collectFacts({ project, plateIndex, targetModel, settingsBase, gcode, slice, mesh, declared, extra, wanted | actions, installedStudio })` returns `{ facts, unavailable, evidence }`.

- Sources: `printer.*`, `filament.*`, `project.*`, `studio.*` come from the existing providers (`settingsProvider`, `structureProvider`) with the project's `config` replaced by the engine's base settings, except `project.source_printer` and `project.printer_changed`, which read the original project (the retarget changes its printer). `filament.profile_name` (23 actions read it, no provider derives it) is `filament_settings_id` of the base. An STL job has no project files, but when it passes `settingsBase` the provider still runs on a project that holds only that base, for `printer.*` and `filament.*` (so `printer.nozzle_count`, `nozzle_diameter` and `nozzle_diameters_differ`, read by seven actions, are known); `project.*` and `studio.*` stay unavailable ("needs a 3MF project"). `mesh.*` come from the mesh analysis passed in; `plate.*` and `slicer.*` from `sliceFacts` and `gcode.*` from the scan, both of THIS call; `object.*` from the declaration. A declaration wins over a value in `extra` (analyzers the caller ran, e.g. the 3MF structure facts), with a note.
- Not carried between rounds: round 0 has no `gcode.*`, `plate.*` or `slicer.*` even when the opened project is itself a sliced 3MF (`sliceProvider` is deliberately not used), and a later call without a scan has none either. `settings.*` are left to the engine, which builds them from its own base; a copy from another source would override it.
- `unavailable`: every fact in `wanted` (default: every fact the actions read) that is not known and that this input can never give: the blind analyses (reason in `evidence[name].notes`), facts of an analyzer that was not run, 3MF facts of an STL, and, after a slice, every `gcode.*` when no scan was given. Never in it: a declarable `object.*` fact (the user can still describe the part) and, before the first slice, `gcode.*`, `plate.*`, `slicer.*` (they will be measured). Passed as `TuningOptions.unavailable` they come back as blind in the engine and do not hold `done` back (tested with the support ladder).
- Evidence per fact: `provenance` (`project`, `mesh`, `slice`, `gcode`, `declared`, `extra`, `unavailable`), source, method, `approx`, notes, and `predictive` for geometry predictions. The report maps these to measured / predicted / unseen.
- Not collected here (analyzer A of the spec, nobody supplies them yet, so they are `unavailable` until the caller passes them in `extra`): `project.support_painted`, `project.has_cut_objects`, `project.nozzle2_used`, `project.speed_lowered_without_temp_drop`, `object.top_shell_stack_mm`, `object.support_top_z_ratio_rounded`. With `project.support_painted` unknown, `tune.support.enable-for-overhangs` is blind and never moves.

End to end on the sliced sample (real 41 MB plate scan, real tuning data): mesh 23 ms, scan 0.5 s; round 0 has 29 facts, 0 post-slice facts and 12 unavailable (the four unimplemented mesh facts, `object.flat_cut_or_pin_base_on_bed`, the ambiguous overhang and the six analyzer-A facts); round 1 advances `tune.travel.unprotected-ladder`, `mesh.unsupported_overhang_area_mm2` unknown and `gcode.support_line_count` = 0; 7 actions are skipped for lack of a part description.
