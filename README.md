# bambu-printer-mcp

[![npm version](https://img.shields.io/npm/v/bambu-printer-mcp.svg)](https://www.npmjs.com/package/bambu-printer-mcp)
[![License: GPL-2.0](https://img.shields.io/badge/License-GPL%20v2-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue)](https://www.typescriptlang.org/)
[![Tested with Node.js 24](https://img.shields.io/badge/tested%20with-Node.js%2024-green.svg)](https://nodejs.org/en/download/)
[![GitHub stars](https://img.shields.io/github/stars/DMontgomery40/bambu-printer-mcp.svg?style=social&label=Star)](https://github.com/DMontgomery40/bambu-printer-mcp)
[![Downloads](https://img.shields.io/npm/dm/bambu-printer-mcp.svg)](https://www.npmjs.com/package/bambu-printer-mcp)


An MCP server that prepares models for Bambu Studio, for Claude Desktop, Claude Code, or any MCP-compatible client: it edits STL files, slices with the Bambu Studio CLI, tunes project 3MFs, answers print-settings questions from a shipped knowledge base, opens files in Bambu Studio and bridges to Blender.

**It never prints and never talks to a printer.** There is no MQTT, FTPS, camera, cloud or Bambu Connect code in this fork, and no printer address, serial number or access code to configure. You review the sliced result in the Bambu Studio GUI and press print there.

Built with help from our [contributors](./CONTRIBUTORS.md). This is a stripped-down, Bambu-only fork of [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server). All OctoPrint, Klipper, Duet, Repetier, Prusa Connect and Creality Cloud support was removed first; the printer-contact paths (printer status and control, file upload, camera, the X2D native helper and the Bambu Connect hand-off) were removed later.

---

## Set up with your agent

Tell your agent your printer's **model**, if you know it, then copy and paste this:

```text
Install bambu-printer-mcp in the agent/harness I'm using now.

Read https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SETUP.md
for the current setup instructions and supported workflows.

Detect my OS and harness, then use its native MCP configuration or installer.
Preserve my existing servers and settings. Prefer the published npm package
(npx -y bambu-printer-mcp, stdio); use Node.js 24 if a runtime is needed.

Ask me for my printer model (BAMBU_MODEL) and never guess it: it selects the
machine profile to slice for. This server does not connect to a printer, so
do not ask for an address, serial number or access code.

Find my installed Bambu Studio before suggesting an install. For Bambu Studio
CLI slicing, require its matching installed profile tree (see the guide).

If this harness does not already provide code mode or an equivalent, suggest
a compatible code-mode integration as an optional addition. It is not required;
finish ordinary MCP setup without it unless I choose to add it.

Verify that the MCP initializes and lists its tools, then call slicer_info
with check_updates false. Do not slice or change anything as a setup test.
Tell me what worked and whether I need to restart or reload the harness.
```

[Setup reference](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SETUP.md) · [Optional code mode](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SETUP.md#optional-code-mode)

## What to ask your agent

Ask for the result you want, not the steps. Current models plan across tools: they search the web, read photos, look up exact dimensions, edit models and slice. Expect a question or two when a choice matters, such as the printer model or which settings to keep.

This server provides the slicing, tuning, knowledge and mesh tools. Web search, photos and Blender edits come from your agent and its other connections, such as a [Blender MCP server](#blender-mcp). Slicing uses the Bambu Studio CLI with your installed presets; see the [slicing guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md).

### Start from anything

- **"Here's a phone stand on MakerWorld. Make it fit the new iPhone."**\
  Your agent looks up Apple's published dimensions, adjusts the stand in Blender, checks it with `preflight_check` and slices it for your printer model.
- **"I want one of these."** *(with a photo of a planter you saw at a café)*\
  It works out the shape and size from the photo, finds or models a matching design, and asks about anything the photo can't show.

### Before you slice

- **"Get this bracket ready to slice."**\
  `prepare_print_project` slices it, reads the G-code, adjusts the settings and slices again within a budget, then opens a new, unsliced project in Bambu Studio. You press slice and print yourself.
- **"Why does the first layer keep lifting?"**\
  It looks up the shipped knowledge base with `consult_knowledge` and cites the topics it used, with a confidence tag on each.
- **"Is this downloaded 3MF safe to slice for my X1C?"**\
  `preflight_check` evaluates the project's settings and geometry against the rules and lists blockers, warnings and what it could not check.

<details>
<summary><strong>Start here</strong></summary>

## Start here

| I want to… | Read next |
|---|---|
| Connect this MCP to my agent | [Copy the setup request](#set-up-with-your-agent) |
| See what my agent can do with it | [What to ask your agent](#what-to-ask-your-agent) |
| Troubleshoot setup or configure it manually | [Installation and environment variables](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SETUP.md) |
| Prepare a file or troubleshoot slicing | [Slicing guide and model routing](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md) |
| Edit an STL through Blender | [Blender MCP setup](#blender-mcp) |
| See release changes or contributor credit | [Changelog](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/CHANGELOG.md), [releases](https://github.com/DMontgomery40/bambu-printer-mcp/releases), and [contributors](./CONTRIBUTORS.md) |

</details>

<details>
<summary><strong>What's new in bambu-printer-mcp</strong></summary>

## What's new in bambu-printer-mcp

See the [changelog](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/CHANGELOG.md) for versioned changes. This fork no longer contacts or controls a printer: the printer status, control, upload, camera, X2D native-helper and Bambu Connect tools were removed, and 21 slicing, tuning, knowledge, STL/3MF and Blender tools remain.

</details>

<details>
<summary><strong>Table of Contents</strong></summary>

## Table of Contents

- [Start here](#start-here)
- [Description](#description)
- [Features](#features)
- [Set up with your agent](#set-up-with-your-agent)
- [What to ask your agent](#what-to-ask-your-agent)
- [Available Tools](#available-tools)
  - [STL Manipulation Tools](#stl-manipulation-tools)
  - [Slicing Tools](#slicing-tools)
  - [Advanced Tools](#advanced-tools)
- [General Limitations and Considerations](#general-limitations-and-considerations)
  - [Memory usage](#memory-usage)
  - [STL manipulation limitations](#stl-manipulation-limitations)
  - [Performance considerations](#performance-considerations)
- [Acknowledgements](#acknowledgements)
- [License](#license)

</details>

<details>
<summary><strong>Description</strong></summary>

## Description

`bambu-printer-mcp` is a Model Context Protocol server that prepares models for Bambu Studio. A straightforward workflow is: **check the file with `preflight_check`, slice it (or let `prepare_print_project` tune and slice it), open the result in Bambu Studio with `open_in_slicer`, review it there and print from the GUI**. See the [slicing guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md) for the supported routes.

**What this is not.** This package does not connect to a printer, upload files to one, start or control a print, or read its camera or AMS. It also does not include adapters for OctoPrint, Klipper (Moonraker), Duet, Repetier, Prusa Connect, or Creality Cloud. If you need printer control or multi-printer support, use the parent project [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server) instead.

**Note on resource usage.** STL manipulation loads entire mesh geometry into memory. For large or complex STL files (greater than 10 MB), these operations can be memory-intensive. See [General Limitations and Considerations](#general-limitations-and-considerations) for details.

</details>

<details>
<summary><strong>Features</strong></summary>

## Features

- STL manipulation: scale, rotate, extend base, merge vertices, center at origin, lay flat, and inspect model info
- Slice through the Bambu Studio CLI with automatic BBL inheritance/include resolution, per-slot filament colours, and fallback prime-tower placement for multi-nozzle printers. Missing dependencies stop the slice; custom settings and saved project tower positions are preserved. The exact machine preset for the chosen model and nozzle is required; see the [slicing guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md).
- Slice for the X2D with its own installed Bambu Studio preset (`BAMBU_MODEL=x2d`)
- Slice directly from a named template via `slice_with_template`; inspect, enumerate and save templates with `get_slice_settings`, `list_templates` and `save_template`
- Open a model or project in the Bambu Studio GUI with `open_in_slicer`
- List the objects of a sliced 3MF plate with `list_3mf_plate_objects`
- Report the installed Bambu Studio and profile versions, the latest GitHub releases, and whether they changed since you last approved them via `slicer_info`
- Look up the shipped Bambu Studio and Blender knowledge base (symptoms, causes, fixes, each with a confidence tag) via `consult_knowledge`
- Check a 3MF's project settings against the knowledge-base rules before slicing, with proposals, confidence tags and an explicit list of what could not be checked, via `preflight_check`
- Turn a part (3MF or STL) into a new, unsliced project 3MF with tuned slicing parameters via `prepare_print_project`: it slices with the Bambu Studio CLI, reads the G-code, adjusts and slices again within a budget, and reports what was verified, what is only predicted and what the engine cannot see (it never prints)
- Optional Blender MCP bridge for advanced mesh operations
- Dual transport: stdio (default, for Claude Desktop / Claude Code) and Streamable HTTP

</details>

<details>
<summary><strong>Available Tools</strong></summary>


<details>
<summary><strong>STL Manipulation Tools</strong></summary>

### STL Manipulation Tools

All STL tools load the full mesh geometry into memory. For files larger than 10 MB, monitor memory usage and prefer testing on smaller files first.

#### get_stl_info

Inspect an STL or 3MF file without modifying it. Returns bounding box dimensions, face count, vertex count, and model center. For a 3MF, the rotation and translation of each build item and component are applied, and `objects` lists every mesh with its own bounding box in the slicer's placement.

```json
{
  "stl_path": "/path/to/model.stl"
}
```

#### scale_stl

Scale an STL model along individual axes. Omit any axis to leave it unchanged (defaults to 1.0).

```json
{
  "stl_path": "/path/to/model.stl",
  "scale_x": 1.5,
  "scale_y": 1.5,
  "scale_z": 1.0
}
```

For uniform scaling, set all three axes to the same value:

```json
{
  "stl_path": "/path/to/model.stl",
  "scale_x": 2.0,
  "scale_y": 2.0,
  "scale_z": 2.0
}
```

#### rotate_stl

Rotate an STL model around one or more axes. Angles are in degrees. Omitted axes default to 0.

```json
{
  "stl_path": "/path/to/model.stl",
  "angle_x": 0,
  "angle_y": 0,
  "angle_z": 90
}
```

#### extend_stl_base

Add a slab underneath the model to increase its base height. The model moves up along Z (the printing axis) and the slab fills the gap, so the result is exactly `extension_height` taller and its bottom stays where it was. Useful for improving bed adhesion on models with a small or unstable footprint.

```json
{
  "stl_path": "/path/to/model.stl",
  "extension_height": 3.0
}
```

`extension_height` is in millimeters and must be greater than 0. The slab covers the model's bounding rectangle.

#### merge_vertices

Weld vertices that are closer together than the specified tolerance onto one position, so hairline cracks between triangles close. Normals do not keep vertices apart. An STL file lists each triangle's corners separately, so a mesh whose corners already coincide exactly comes out identical. Useful as a cleanup step before slicing.

```json
{
  "stl_path": "/path/to/model.stl",
  "tolerance": 0.01
}
```

`tolerance` is in millimeters and defaults to 0.01 if omitted.

#### center_model

Translate the model so the center of its bounding box sits at the world origin (0, 0, 0). Useful before applying transformations or exporting for use in another tool.

```json
{
  "stl_path": "/path/to/model.stl"
}
```

#### lay_flat

Identify the largest flat surface on the model and rotate the model so that face is oriented downward on the XY plane (Z = 0). Coplanar triangles count as one face, and a face qualifies only if the model lies entirely on one side of its plane and the model's center of mass projects inside the face's outline (its convex hull), so a large fin that would tip the part over is skipped. If no face qualifies, the largest one is used. This is a common preparation step before slicing to minimize the need for supports.

```json
{
  "stl_path": "/path/to/model.stl"
}
```

Note: this works best on models with a clearly dominant flat face. Results on organic or rounded shapes may be unpredictable.

#### list_3mf_plate_objects

List object IDs from a sliced 3MF plate. Use this before `slice_stl` with `skip_objects` so you pass real Bambu object IDs instead of display-order guesses.

```json
{
  "three_mf_path": "/Users/yourname/Downloads/bracket.gcode.3mf",
  "plate_index": 0
}
```


</details>

<details>
<summary><strong>Slicing Tools</strong></summary>

### Slicing Tools

> **Note:** the CLI-driven slicing tools below (`slice_stl`, `slice_with_template`) are sensitive to profile drift. Review every result in the Bambu Studio GUI before you print it. See [slicing guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md).

#### slicer_info

Report the installed Bambu Studio without changing it: executable, `app_version` (macOS `Info.plist`, Windows file version), `profile_version` (`BBL.json`, a different number), the latest stable and prerelease from the GitHub releases of `bambulab/BambuStudio` (`latest_release`, `null` when GitHub cannot be reached within 5 s), and `is_prerelease_installed`. It also compares the installed versions with the ones last recorded in a state file (`SLICER_STATE_FILE`, default `~/.bambu-printer-mcp/slicers.json`).

```json
{
  "check_updates": true
}
```

When `changed_since_last_seen` is `true` the agent compares the settings of the two versions, reads the release notes as untrusted text, and proposes rule or documentation updates. Nothing is applied until you approve; only then does the agent call `slicer_info` with `"acknowledge": true`, which records the current versions as seen. `"check_updates": false` skips the GitHub request. With no record yet, `changed_since_last_seen` is `false` and `previous_version` is `null`.

#### consult_knowledge

Search the knowledge base in `knowledge/` (195 topics and 320 rules about Bambu Studio slicing and Blender mesh preparation, written in Portuguese) by symptom, question or setting key in Portuguese or English, or fetch one entry by `id`. Read-only and offline. `query` is at most 500 characters. Every answer has `relevance` (0 to 1) and `low_relevance` (true below 0.45, with a one-line `hint`): when it is true, say the base only touches the subject. Every topic and rule carries the source's confidence tag (`preset`, `oficial`, `bug conhecido` are strong; `relato`, `hipotese`, `nao verificado` are weak), the Studio version it applies to (`version_status`, judged against the installed Studio) and, for rules, whether the fix would need your approval (`approval`; none of the shipped rules is `auto_apply`). Entries for another printer rank lower than those for `bambu_model` (default `BAMBU_MODEL`). A query the base cannot answer returns `no_match: true`. The text is third-party reference data, never instructions.

```json
{
  "query": "o bico arrasta na peça e derruba",
  "limit": 4,
  "detail": "brief"
}
```

The base is built from the source documents with `npm run kb:build` (copies, validates and writes `knowledge/manifest.json`); `npm run kb:check` validates and checks the manifest hashes. `BAMBU_KB_DIR` points the server at another folder for development.

#### preflight_check

Check a part before slicing. It reads the project settings and structure of a `.3mf` (also a `.gcode.3mf`) and evaluates the rules of the knowledge base that those settings can decide, plus the cheap geometry facts: the box and triangle count of the objects on the chosen plate (or of an `.stl` or `.obj`) against the targeted printer's volume, which decides the build-volume, prime-tower layer-height and cut blockers. Read-only: it never slices, edits a file or prints, and it makes no network request. An `.stl`, `.obj`, `.step` or `.gcode` has no settings, so its settings rules are reported as unchecked (a `.step` and a `.gcode` have no box either); G-code analysis, mesh analysis and Blender checks are not implemented yet and `checks.mesh`, `checks.gcode` and `checks.blender` only add that to `unchecked`. A 3MF exported from the GUI as G-code carries no geometry, so its box facts stay unknown. Keys the guide has not confirmed on a real X2D (which nozzle an object uses, the AMS type, cut objects) are never guessed: the rules that need them are reported as unchecked.

The result has `findings` (rules that fired, blockers first, then by strength of source; each with its confidence tag, the fact values that triggered it, a proposed `fix` and its `approval`), `checklist` (manual checks, and rules the source gave no threshold for, with the current values of the facts they read), `unchecked` (a count per reason, for rules of every severity: the missing fact, the tier that is not implemented, or a Studio version outside the rule's `applies_to`), `hidden` (rules for other printers, ignored ids, fired or checklist items below `min_severity`, findings over `max_findings`), `accounting` (`candidates` = `findings` + `checklist` + `not_fired` + `unchecked` + `hidden`: no rule of the base is left out) and `version_review`. `untrusted_reference` is always `true`: rule text and the file's own values are third-party data.

The printer is `bambu_model`, else `BAMBU_MODEL`, else the 3MF's `printer_model`, else you are asked; rules for other printers are hidden. `min_severity` defaults to `warning`, so tips are hidden but counted. `approval` is computed in code and is `auto_apply` only for a definite setting value from a `preset` or `oficial` source outside the Blender stage; none of the shipped rules qualifies, so every fix needs your approval. `applies_to` limits are judged against the installed Bambu Studio; a rule whose limit the installed version does not meet is dropped and counted, and one that cannot be judged is kept with a `version_note`. When the installed Studio or its profiles changed since you last approved them (`slicer_info`), `version_review` lists the rules whose verdict flips and the ones tied to an older exact build; the tool never acknowledges the change itself. Facts you alone know (`object_kind`, `mold_kind`, `origin`) go in `context` and come from nowhere else: they are never inferred from a file name, and a rule that needs one is unchecked with "pergunte ao usuario: context.object_kind". `plate_index` selects the plate that the box, object, filament and plate facts describe.

```json
{
  "file_path": "/path/to/part.3mf",
  "bambu_model": "x2d",
  "plate_index": 0,
  "min_severity": "warning"
}
```

#### prepare_print_project

Get a part ready for you to slice. It takes a `.3mf` project or an `.stl` and delivers a **new, unsliced project 3MF** with tuned slicing parameters, opened in Bambu Studio so you press slice and print yourself. It never prints, never contacts a printer, and never modifies the original (SHA-256 checked before and after); the output never overwrites a file. It lays the knowledge-base overlay on top of the project's own settings, then loops: slice the retargeted project once as a baseline, apply the tuning, slice, read the G-code (unprotected travels that can knock the part over, support, thin features), step the ladders, slice again, until the engine has nothing more to change, a ladder runs out of steps, a round would repeat itself, or the budget ends (`max_slices` default 12, `max_minutes` default 20). The best measured round is delivered. Slicing goes through the Bambu Studio CLI only; Blender is not part of the loop. How it works, the budget, the verdict rules and how to read the report: [docs/TUNING.md](./docs/TUNING.md).

The report separates **VERIFIED** (measured on the G-code, slice result, mesh or 3MF), **PREDICTED ONLY** (fired from part facts or guide rules) and **UNSEEN** (what the engine cannot see), and gives the verdict `ready`, `ready_with_caveats` or `not_ready` with the reasons. Every change carries its confidence tag, guide source and rule ids, and the diff against the original is split into the printer retarget and the tuning. `ready` means the engine found nothing left that it can see and everything it applied was measured; most runs end `ready_with_caveats`, and the tool never claims every possibility was tested. `part_context` takes only what you said about the part (`load_class`, `mold_kind`, `kind`, `is_tall_narrow`, ...): an undeclared fact stays unknown, the actions that need it are skipped and listed, never guessed. `dry_run` plans without slicing. `apply: "strong_only"` writes only `preset`, `oficial` and `bug conhecido` values.

```json
{
  "path": "/path/to/part.3mf",
  "bambu_model": "x2d",
  "part_context": { "load_class": "functional" },
  "max_slices": 8,
  "open_in_studio": true
}
```

#### list_templates

List saved templates from the local registry directory. You can override the registry root with `BAMBU_TEMPLATE_DIR`.

```json
{}
```

Each result includes the template `name`, absolute `path`, source type, and relative path inside the registry. You can then pass `template_name` to `get_slice_settings` or `slice_stl` instead of a raw path.

#### save_template

Copy a local `3mf`, `json`, or `.config` file into the template registry and register it under a reusable template name.

```json
{
  "source_path": "/path/to/sliced_project.3mf",
  "template_name": "collars/p1p_petg_default"
}
```

This creates the destination under the template registry directory and makes it available immediately to `list_templates`, `get_slice_settings`, `slice_with_template`, and `slice_stl`.

#### get_slice_settings

Inspect the slicer settings embedded in a saved 3MF template or in an extracted JSON/config profile without slicing anything.

```json
{
  "template_name": "h2s_template"
}
```

This returns a compact summary of the high-signal settings such as printer preset, default print profile, filament profiles, layer height, infill density, shell counts, support mode, and bed type. It accepts either `source_path` or `template_name`. For 3MF inputs it also writes the extracted settings blob to a temp path so the result can be reused directly.

#### slice_with_template

Slice an STL or 3MF using a named template from the local registry. This is a higher-level wrapper over `slice_stl` for template-based workflows and returns the same `output_path` and `plates` result.

```json
{
  "stl_path": "/path/to/model.stl",
  "template_name": "collars/p1p_petg_default",
  "bambu_model": "p1p"
}
```

This uses the named template as the slicing profile source. The template settings are applied at slice time.

#### slice_stl

Slice an STL or 3MF file using an external slicer. The output is a sliced 3MF (for BambuStudio) or a G-code file (for PrusaSlicer, Cura, Slic3r).

The result is JSON. `output_path` is the output file. For a sliced 3MF, `plates` lists what the slicer recorded for each plate (empty for G-code output):

```json
{
  "output_path": "/tmp/bambu-printer-mcp-ab12/slice-Xy7Kq2/model_sliced.3mf",
  "plates": [
    {
      "index": 1,
      "prediction_s": 35464,
      "weight_g": 234.76,
      "filaments": [{ "type": "PLA", "color": "#000000", "used_g": 234.76, "used_m": 77.46 }],
      "warnings": [{ "msg": "bed_temperature_too_high_than_filament", "level": 3, "error_code": "1000C001" }]
    }
  ]
}
```

**Keeping a 3MF creator's settings.** A downloaded 3MF carries its creator's changes (infill pattern, speeds) and filament presets, and the Bambu Studio CLI replaces them with whatever it is given. For a 3MF with no `slicer_profile` or template, the server therefore builds a plan for the target `bambu_model` and asks the user, per file, to choose between the two:

- `keep`: the project's own process preset where the target printer has it, else the one with the same base name (else the printer's default process), the project's changed process settings on top (for a 3MF made for the target printer itself, every process value that differs from the preset, because Bambu Studio rewrites the changed-keys list when it saves), and each filament slot mapped to the target-compatible preset with the same base name (for example `Generic PLA @BBL H2D` becomes `Generic PLA @BBL X2D 0.4 nozzle`). Settings that exist per extruder variant are carried over where the target has the same extruder and variant, and the rest are listed. A slot with no equivalent uses the printer's default filament and is listed. Machine settings and edits to a filament preset are never carried over.
- `printer_default`: the printer's default process and default filament in every slot.

The prompt shows the differences (`key: project value -> printer default`, `filament N: from -> to`). Pass `project_settings: "keep"` or `"printer_default"` to skip it. If the client cannot ask and the argument is missing, the call fails with the differences so the agent can ask the user. A 3MF that differs from the printer's defaults in nothing that could be kept is not asked about. STL input, an explicit `slicer_profile` and a template are unchanged. The result gains a `settings_report`:

```json
"settings_report": {
  "mode": "keep",
  "kept": ["sparse_infill_pattern: gyroid -> grid"],
  "not_kept": ["outer_wall_speed: no X2D equivalent for extruder 2 Direct Drive Standard"],
  "filament_map": [{ "slot": 1, "from": "Generic PLA @BBL H2D", "to": "Generic PLA @BBL X2D 0.4 nozzle" }]
}
```

With `printer_default`, `kept` is empty and `not_kept` lists what the project would have kept.

Every Bambu Studio slice writes into a fresh `slice-*` folder under `TEMP_DIR`, so repeated or concurrent slices never share files. The folder keeps only the sliced 3MF (the `plate_N.gcode` files are inside it). A `slicer_profile` path that does not exist is an error and the slicer does not run. Cancelling the request stops the slicer process.

```json
{
  "stl_path": "/path/to/model.stl",
  "slicer_type": "bambustudio",
  "bambu_model": "p1s"
}
```

`slicer_type` options: `bambustudio`, `prusaslicer`, `cura`, `slic3r`. When omitted, the value from the `SLICER_TYPE` environment variable is used (default: `bambustudio`).

**Bambu Studio CLI safety:** the exact model/nozzle preset from the selected installation is required, and slicing stops on profile preparation failures. A process override cannot bypass that gate. With `arrange: false`, an STL that is not already on the plate fails to slice. A failure names the slicer's own reason.

`slicer_path` and `slicer_profile` fall back to the `SLICER_PATH` and `SLICER_PROFILE` environment variables when omitted. Per-call `slicer_path` overrides require `MCP_ALLOW_EXECUTABLE_ARG=1`.

You can provide either `template_3mf_path` or `template_name` when you want to slice from a saved template. `template_name` resolves through the local template registry directory configured for the server.

To print, open the sliced output with `open_in_slicer`, review it in the Bambu Studio GUI and print from there.

#### BambuStudio Slicer Options

When `slicer_type` is `bambustudio` (the default), these additional parameters are available on `slice_stl`:

| Parameter | Type | Description |
|-----------|------|-------------|
| `uptodate` | boolean | Update 3MF configs to latest BambuStudio presets |
| `repetitions` | number | Number of copies to print |
| `orient` | boolean | Auto-orient model for optimal printability |
| `arrange` | boolean | Auto-arrange objects on the build plate |
| `ensure_on_bed` | boolean | Lift floating models onto the bed |
| `clone_objects` | string | Clone counts per object, comma-separated (e.g. `"1,3,1,10"`) |
| `skip_objects` | string | Object indices to skip, comma-separated (e.g. `"3,5,10"`) |
| `load_filaments` | string | Filament profile paths, semicolon-separated |
| `load_filament_ids` | string | Filament-to-object mapping, comma-separated |
| `project_settings` | string | `keep` or `printer_default`: whether a 3MF without `slicer_profile`/template keeps its creator's settings or uses the printer defaults. Asked per file when omitted. Also on `slice_with_template`. |
| `nozzle_volume_type` | string | Installed nozzle flow type: `standard` or `high_flow` (default: `BAMBU_NOZZLE_VOLUME_TYPE`, else the preset's Standard default). `high_flow` uses the presets' High Flow values, such as the filament's High Flow max volumetric speed, and is refused if the machine preset declares no High Flow variant. Also on `slice_with_template`. |
| `filament_colours` | string | Slot colours, one `#RRGGBB` per filament slot, semicolon-separated. Explicit values take priority, followed by input 3MF colours, each custom profile's colour, then the BambuStudio default. |
| `enable_timelapse` | boolean | Enable timelapse-aware slicing |
| `allow_mix_temp` | boolean | Allow mixed-temperature filaments on one plate |
| `scale` | number | Uniform scale factor |
| `rotate` | number | Z-axis rotation in degrees |
| `rotate_x` | number | X-axis rotation in degrees |
| `rotate_y` | number | Y-axis rotation in degrees |
| `min_save` | boolean | Produce smaller output 3MF |
| `skip_modified_gcodes` | boolean | Ignore stale custom gcodes in the 3MF |
| `slice_plate` | number | Which plate to slice (0 = all plates, default: 0) |

**Example: Slice with auto-orient and 3 copies**
```json
{
  "stl_path": "/path/to/model.stl",
  "bambu_model": "p1s",
  "orient": true,
  "arrange": true,
  "repetitions": 3
}
```

</details>

<details>
<summary><strong>Advanced Tools</strong></summary>

### Advanced Tools

#### Blender MCP

Use a standard stdio Blender MCP server with `BLENDER_MCP_COMMAND` and
`BLENDER_MCP_ARGS`. For the common Blender MCP server, install `uv` and its
matching Blender addon, enable the addon, and start its connection inside
Blender. Set the command to your full `uvx` path and the argument array to
`["blender-mcp"]`. The Claude Desktop extension also offers these two optional
settings. The other tools work without Blender configured. The Blender child
process gets only the default safe environment plus `BLENDER_*` variables
(except the three command settings) and `DISABLE_TELEMETRY`; set
`DISABLE_TELEMETRY=1` in the server's environment to turn off the upstream
server's telemetry without wrapping its command in `/usr/bin/env`, which Windows
lacks. Other server variables are never passed on.

1. Call `blender_mcp_status` with `{"connect": true}` to initialize the server
   and discover its tools and input schemas. A connected MCP server does not
   by itself prove that the Blender addon is running.
2. Call `blender_mcp_call` with a discovered tool name and its arguments. The
   full MCP result, including images and errors, is returned. For example:

```json
{
  "tool_name": "get_scene_info",
  "arguments": {"user_prompt": "Inspect the scene before preparing a print."}
}
```

For advanced Blender operations, forward `execute_blender_code` with `code`
and the user's original `user_prompt`. These calls may edit the active scene.
Use the discovered schema rather than assuming a tool exists.

#### blender_mcp_edit_model

The standard MCP edit helper imports an STL, applies ordered edits, and exports
an STL without replacing the input or an existing output. Supported operations
are `decimate:<ratio>` (greater than 0 through 1), `remesh:<voxel size>` (positive,
in STL coordinate units), and `boolean_union:<STL path>`. Other operations can
use `blender_mcp_call`. Both processes must have access to the same file paths.
When `BLENDER_MCP_COMMAND` selects standard MCP, the advertised tool schema
requires an explicit `output_path` for both preview and execution. Legacy-only
bridge configurations keep `output_path` optional for compatibility.

```json
{
  "stl_path": "/path/to/model.stl",
  "output_path": "/path/to/model-edited.stl",
  "operations": ["decimate:0.5"],
  "user_prompt": "Reduce the triangle count of this model for printing.",
  "execute": false
}
```

The default preview returns the plan and generated Python without launching
Blender. Set `execute` to `true` to run it. A successful standard edit returns
`output_verified: true`, `output_path`, byte count, and triangle count after
checking the matching export receipt and a valid finite mesh. The helper
preserves existing scene objects and requires Object Mode. Inspect the result
before slicing; a valid STL is not a guarantee of printability.

The bridge enforces request deadlines, closes child connections, and never
replays interrupted editing requests. After a timeout, inspect Blender before
trying the edit again because execution may already have started.

Existing custom executables still work through `BLENDER_MCP_BRIDGE_COMMAND`.
They receive `MCP_BLENDER_PAYLOAD` with the requested file and operations;
their results explicitly report `output_verified: false`. A missing executable
configuration is an error when execution is requested. Per-call legacy
`bridge_command` overrides remain disabled unless `MCP_ALLOW_EXECUTABLE_ARG=1`.

</details>

</details>

<details>
<summary><strong>General Limitations and Considerations</strong></summary>

## General Limitations and Considerations

### Memory usage

STL manipulation tools load the entire mesh into memory as Three.js geometry. For large files:

- Files over 10 MB can consume several hundred MB of RAM during processing.
- Running multiple operations sequentially on large files may cause memory to accumulate between garbage collection cycles.
- If you encounter out-of-memory errors, try splitting large operations or working with smaller/simplified meshes.
- The server has no built-in memory cap. On constrained systems, set the `TEMP_DIR` to a fast local path and avoid processing multiple large files concurrently. Each Bambu Studio slice keeps its sliced 3MF in its own `slice-*` folder there; delete old folders when you no longer need them.

### STL manipulation limitations

- `lay_flat` groups coplanar triangles into faces and picks the largest one that supports the center of mass (assumes a closed mesh). It works reliably on mechanical parts with clear flat faces and less reliably on organic or curved models where no single dominant face exists.
- `extend_stl_base` adds a new rectangular slab beneath the model, spanning its bounding rectangle. For models with complex or non-planar undersides, the result may include gaps or intersections at the join. Review the modified STL before slicing it.
- `merge_vertices` uses a distance tolerance to identify near-duplicate vertices. Setting the tolerance too high can alter model geometry. The default of 0.01 mm is safe for most models.
- Non-manifold meshes (meshes with holes, overlapping faces, or internal geometry) may produce unpredictable results for any transformation operation. Use a mesh repair tool (Meshmixer, PrusaSlicer's repair function, or Bambu Studio's repair option) before working with problematic files.

### Performance considerations

- Slicing with BambuStudio CLI can take 30 seconds to several minutes depending on model complexity, layer height, and your system's CPU. The `slice_stl` call is synchronous and will block until the slicer process completes.

</details>

<details>
<summary><strong>License</strong></summary>

## License

GPL-2.0. See [LICENSE](./LICENSE) for the full text.

This project is a fork of [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server) by David Montgomery, also GPL-2.0.

</details>

<details>
<summary><strong>Acknowledgements</strong></summary>

## Acknowledgements

See the [contributor credits](./CONTRIBUTORS.md).

Printer command surfaces and workflow priorities of earlier releases (since removed from this fork) were informed by [Bambuddy](https://github.com/maziggy/bambuddy), an AGPL-3.0 Bambu Lab printer management project. This project did not vendor Bambuddy code.

</details>