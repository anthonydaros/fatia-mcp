# Slicing Guide

[Back to README](../README.md) · [Agent setup](../README.md#set-up-with-your-agent)

H2D Pro uses `BAMBU_MODEL=h2dpro` and requires the selected slicer installation’s exact `Bambu Lab H2D Pro <nozzle> nozzle` preset. Offline tests cover model selection and preset preparation. Do not substitute `h2d`.

## TL;DR

This server never prints and never contacts a printer. It slices with the Bambu Studio CLI, tunes project 3MFs, checks them against the knowledge base, and opens the result in the Bambu Studio GUI. You review the preview there and print from the GUI.

Archives with duplicate, case-colliding, hidden, or inconsistent entries are rejected when the server reads a 3MF. The reader accepts files up to 256 MiB and archives up to 512 MiB uncompressed; ZIP64 is unsupported.

Mixed-diameter dual-nozzle projects need GUI slicing: the CLI preset path supports a uniform nozzle diameter.

| Use case | Path | Status |
|---|---|---|
| Single-colour BambuStudio CLI slicing | MCP slices via CLI with automatic BBL profile resolution | ✅ Works (verified H2S, H2D, X1C, P1S on 02.06.01.55). H2C requires Bambu Studio 2.4.0+ and `BAMBU_MODEL=h2c`. |
| Multi-color BambuStudio CLI slicing | MCP prepares every filament slot's colour and a fallback tower position | Contributor-verified on Windows BambuStudio 02.08.02.60, including four-colour X2D slicing. See version limits below. |
| X2D slicing | `BAMBU_MODEL=x2d` with an installed X2D preset | Available. |
| Other slicing combinations | Slice in the Bambu Studio GUI | Inspect the preview before you print. |

Choose GUI slicing or CLI slicing.

**Path A — slice in Bambu Studio:**

```
Mesh ──► Bambu Studio GUI ──► slice + preview ──► print from the GUI
```

**Path B — let the MCP slice via the Bambu Studio CLI (BBL printers only):**

```
STL/3MF ──► MCP slice_stl / prepare_print_project ──► (auto-flatten profiles) ──► Bambu Studio CLI ──► sliced 3MF ──► open_in_slicer ──► review and print in the GUI
```

Path B works because the MCP now flattens BBL profile inheritance before
calling the CLI — a workaround for several upstream bugs in BambuStudio's
CLI mode (issues
[#9636](https://github.com/bambulab/BambuStudio/issues/9636) and
[#9968](https://github.com/bambulab/BambuStudio/issues/9968)). Verified
on H2S, H2D, X1C, and P1S with stock BBL profiles for single-colour slicing.
The newer multi-colour evidence and version limits are described below.
H2C is accepted as `BAMBU_MODEL=h2c`; use Bambu Studio 2.4.0 or newer for
the H2C printer preset and do not substitute `h2d`.

BBL profile resolution now runs automatically for CLI slicing.
`BAMBU_CLI_FLATTEN` is no longer required and cannot disable resolution.
Missing parents, missing or malformed includes, cycles, and unresolved filament
slots stop the slice before the CLI runs; the MCP does not fall back to partial
profiles. Standalone custom process and filament configs remain usable, and
custom BBL-derived profiles retain their settings on top of resolved parents.
For the Bambu Studio CLI, `slicer_profile` supplies process settings; the
selected model's bundled machine preset must still be available. It is not a
replacement machine configuration or a way to bypass model validation.
Machine settings carried by a template's `project_settings`, a custom process
file, or a custom filament file (for example another printer's start G-code,
`printer_model`, or nozzle values) are dropped and logged before the CLI runs;
the selected machine preset keeps them.

Profile discovery follows the active executable: macOS app bundles, Windows
`resources/profiles`, and Linux `share/BambuStudio/profiles` layouts are
recognized. For AppImages or other layouts whose profiles are not accessible
beside the executable, set `BAMBU_PROFILES_ROOT` to the matching installation's
directory containing `BBL`. An unavailable tree produces an error rather than
using another installation's settings.

## Multi-colour CLI support and version limits

The CLI can crash when a project uses a filament after the first but its
loaded profiles leave `filament_colour` at a single-entry default. The MCP
now supplies one colour per slot. Explicit `filament_colours` values take
priority, then the input 3MF's colours, each profile's own colour, and finally
the BambuStudio default. Custom filament settings remain intact.

For multi-nozzle printers, an unset tower position is placed within the
shared nozzle area. Saved project positions and explicit process positions
are preserved. This does not guarantee a collision-free layout: inspect the
slicer preview for the actual model and tower geometry.

[Sebastian's contribution](https://github.com/DMontgomery40/bambu-printer-mcp/pull/18)
includes real Windows BambuStudio `02.08.02.60` bisection and a successful
four-colour X2D slice. This is slicing evidence, not a physical-print test.

Older H2D failures remain separate evidence: `02.06.00.51` crashed during
slicer setup, and `02.06.01.55` reported `No valid nozzle found` / code `-100`
on an exported multi-colour project. These were filed in
[BambuStudio#10408](https://github.com/bambulab/BambuStudio/issues/10408).
The colour fix does not establish that every older-version or multi-material
failure is resolved. Use a GUI-sliced project when a CLI combination fails.

X2D has its own preset and slicing support (`BAMBU_MODEL=x2d`). Do not choose H2D as a substitute model.

## Why Path A is still recommended

GUI slicing lets you inspect supports, colours, tool changes, and tower placement before you print. It is also the fallback when a CLI build rejects flags, cannot resolve the selected profiles, or crashes.

Bambu-compatible CLI preparation supports bundled BBL presets and standalone custom process/filament overrides; custom BBL-derived settings are retained after dependency resolution. The selected model's bundled machine preset is still required.

A failed profile preparation or slice stops with the slicer's error. The server never deliberately substitutes the original unsliced project for a failed slice.

## Path B mechanics (CLI auto-flatten)

Before Bambu Studio CLI slicing, the MCP:

1. Requires the exact model/nozzle machine preset in the selected installation's BBL tree, validates its identity, and reads each leaf profile JSON.
2. Resolves `inherits` and `include` recursively: inherited settings first,
   include templates in order, then the profile's own keys. Cycles and
   unresolved references are errors, including within templates.
3. Sets `from: "User"`, `inherits: <leaf machine name>`, and
   `printer_settings_id` / `print_settings_id` / `filament_settings_id`
   so the CLI's compatibility check passes.
4. Derives nozzle settings from the selected machine profile and nozzle configuration. `nozzle_volume_type` (`standard` or `high_flow`) sets the machine's `nozzle_volume_type`, which selects each profile's Standard or High Flow values; a flow type the preset does not declare in `extruder_variant_list` is refused. Use the exact model preset; a successful slice for another model does not validate the target printer.
5. Auto-extends `compatible_printers` to include the chosen machine
   when the user picked a non-default printer/process combo.
6. Removes every key the resolved machine preset defines, other than profile
   metadata such as `name`, `inherits`, and `compatible_printers`, from the
   process and filament configs, because the CLI applies every key in every
   loaded file.
7. Writes flattened temp configs and passes those paths to
   `--load-settings` / `--load-filaments`.

For project 3MF input, a single filament override is repeated across all
declared project slots. An explicit list preserves order and duplicate paths
and must provide one profile per slot. This prevents later slots from retaining
a foreign printer's filament settings; it does not change object assignments.
A geometry-only 3MF without project settings has no embedded
slot list to replace.

Without `slicer_profile` or a template, a project 3MF is sliced with the printer's default process and filaments unless the user chooses to keep the creator's settings (`project_settings: "keep"`; see the `slice_stl` section of the README). Keeping reads `Metadata/project_settings.config`: `different_settings_to_system` holds one semicolon-separated key list for the process, one per filament slot, and one for the printer, in that order. The process keys are overlaid on the target printer's process preset (for a 3MF made for the target printer itself that list is not trusted: Bambu Studio rewrites it on save, so every process value that differs from the preset is overlaid), per-extruder-variant values where the target has the same extruder and variant, and each `filament_settings_id` is mapped to the target-compatible preset with the same base name. The remainder is reported in `settings_report`.

Implementation: [`src/slicer/profile-flatten.ts`](../src/slicer/profile-flatten.ts), [`src/slicer/project-settings.ts`](../src/slicer/project-settings.ts).
Optional installed-slicer smoke test: `node scripts/test-cli-slice.mjs --model h2s` (substitute the supported target model). This slices a fixture; it does not print.

## Why the sliced file matters

The slicer supplies model-specific start G-code, filament declarations, and plate metadata. Renaming a geometry-only `.3mf` to `.gcode.3mf` does not create those contents. Use an exported sliced project, or let the configured CLI finish successfully. A `.gcode.md5` checksum entry is not printable G-code.

## The right input file

After slicing in your chosen GUI, export the **sliced plate** (in Bambu Studio, **File → Export → Export plate sliced file**, or "Export all sliced files"). A typical `.gcode.3mf` contains the following; the required printable content is a `Metadata/plate_<n>.gcode` entry, while the available metadata depends on the exporter:

```
Metadata/
  plate_1.gcode               ← the actual machine instructions
  plate_1.json                ← { "filament_ids": [...], ... }
  slice_info.config           ← <filament id="..."> declarations
  filament_sequence.json      ← per-plate filament order
```

Check that you exported the sliced plate, not the geometry project. Without a `Metadata/plate_<n>.gcode` entry the file is a project, not a sliced plate; slice it again.

<a id="slicing-recipe-bambu-studio"></a>

## Slicing recipe (Bambu Studio)

1. Open Bambu Studio and load the mesh.
2. Pick the **printer profile that matches the target machine** (H2S, H2D, H2C, X1C, P1S, A1, ...). The start g-code differs per series; a plate sliced for X1 will heat-soak wrong on H2, and an H2C should not be treated as H2D.
3. Pick the **filament** you will load for each slot.
4. Slice the plate.
5. Review the preview and print from Bambu Studio. To check the result with this server first, export the sliced plate (**File → Export → Export plate sliced file**) and call `preflight_check` on it.

> ⚠️ Avoid re-using an old `Cube.gcode.3mf` from a different printer/AMS setup.
> Stale multi-filament declarations in the file will not match your current
> setup. When in doubt, re-slice fresh.

## Quick troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| A file has no `Metadata/plate_<n>.gcode` | It is a mesh or project `.3mf`, not a sliced one | Slice it again and export the sliced plate |
| CLI slicing fails | Missing profiles, unsupported flags, or slicer-version failure | Preserve the error; use matching presets or slice in the Bambu Studio GUI |
