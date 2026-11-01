# Fatia MCP

This file is the repository's shared source of truth for local agents, GitHub Codex review, and scheduled maintenance. Read it before changing or reviewing code. CLAUDE.md and .claude/agents.md defer to these rules.

## Release and review

- This is the independently maintained Fatia MCP fork at anthonydaros/fatia-mcp. Preserve GPL-2.0, original authorship, history, and contributor credit. The original repository is `upstream`; this fork is `origin`.
- Initial distribution is GitHub Releases and `fatia-mcp.mcpb`; package identity is `@anthonydaros/fatia-mcp`, executable `fatia-mcp`. Do not publish to npm unless the user explicitly requests it.
- Use a codex/ branch and a reviewed PR for changes to an existing main. Initial creation of this new fork may publish the reviewed local history directly to its empty main; complete local independent review and verify current-head CI before tagging a release.
- Run the installed ponytail-review skill against the full change and obtain an independent read-only regression/security review before integration. Resolve substantive findings locally. Request GitHub Codex review when it is available; local review does not replace required CI.
- CI must pass on the current head for Linux, macOS, and Windows. POSIX-only fake-executable cases explicitly skip on Windows; report those skips separately from native-platform evidence.
- Prioritize substantive defects and supported workflows; defer speculative hardening, cosmetics and removal of legacy exported methods.
- Never add AI attribution, Co-Authored-By trailers for assistants, generated-by footers, or agent session links to commits, PRs, comments or release notes.
- Keep present-tense CHANGELOG.md notes under `## Unreleased` during work. Run `npm version patch --no-git-tag-version` once for the release; its hook promotes those notes and synchronizes package.json, package-lock.json and manifest.json. Commit these together with synchronized dist/.
- Tag the final release commit `v<version>` without moving an existing published tag. Verify the GitHub release, MCPB asset and fresh installed initialization before declaring release completion. Preserve validation limits in the release notes.

## Build and test

- `npm run build` must finish with zero TypeScript errors before committing. Keep tracked dist/ output synchronized with source.
- `node --test tests/behavior.test.mjs` must pass all current tests before pushing. Do not rely on an old fixed test count.
- `npm test` builds and runs the full suite, including the exact tool list, slicer safety, the tuning loop, the knowledge base, Blender MCP, real npm installation layouts, and desktop packaging. It must pass before release; CI uses Node.js 24 on Linux, macOS and Windows.
- Tests use compiled dist/ files, so build before focused test commands. Optional tests against an installed BambuStudio profile tree may skip when that tree or model is unavailable; report those skips separately from failures.
- For installation changes, test the actual tarball in local-hoisted, global, and npm-exec layouts and start the installed server. For desktop changes, inspect and initialize the extracted MCPB archive.
- Do not launch the Bambu Studio GUI or mutate the user's live Blender scene during routine tests. Mock the slicer boundary and use isolated headless Blender. Set BAMBU_MODEL explicitly to an empty string in tests of missing-model behavior so dotenv cannot supply a real configuration.

## Architecture and installation

- Bambu-only fork of mcp-3D-printer-server. Do not add OctoPrint, Klipper, Duet, Repetier, Prusa, or Creality printer integrations.
- This fork never contacts or controls a printer. Do not add MQTT, FTPS, camera, cloud, Bambu Connect, native-helper or any other code that talks to a printer, uploads a file to one, or starts, pauses, cancels or otherwise controls a print. The user prints from the Bambu Studio GUI. `tests/tool-surface.test.mjs` pins the exact tool list and fails if a printer transport is imported.
- Keep runtime diagnostics on stderr so stdout carries only MCP protocol messages.
- MCP transports: stdio by default and streamable-http.
- Package only intended runtime, source, licenses, and contributor files. Build MCPB in isolated staging without pruning the developer checkout. Never package credentials, local configuration, or private models.
- Use a private OS temporary directory per process and distinct generated profile paths for differing content. Deliver artifacts to ~/.fatia-mcp/outputs (or FATIA_OUTPUT_DIR); output_dir overrides prepare_print_project only. Shutdown removes scratch, never delivered files.

## Slicer safety

- The server has no printer to protect at run time, but G-code sliced for the wrong model can damage the user's printer when it is printed from the GUI. BAMBU_MODEL (or the explicit tool model) is required for every slice. Elicit it when missing. Never skip validation.
- X2D slicing uses its own installed preset. Resolve the model before slicing.
- Resolve both inherits and include dependencies recursively before Bambu Studio CLI slicing. Require the exact model/nozzle machine preset from the selected installation; never borrow a missing machine profile from another tree. Preserve configured user directories for custom process/filament dependencies. Missing references, cycles, malformed profiles, or incomplete slot mappings must stop preparation.
- Validate the selected bundled model's BBL/cli_config.json entry. Apply machine_limits when supplied; official P1S/H2D entries may intentionally contain only downward_check. Distinguish a validated no-overlay entry from missing/malformed configuration. The internal flattenForCli sourceProfiles.machine API preserves standalone explicit machine settings. Public Bambu-compatible CLI tools still require the selected model's bundled machine preset: slicer_profile supplies process settings, not a replacement machine configuration, and must not bypass that safety gate.
- Preserve custom overrides and filament-slot ordering. One explicit filament override replaces every declared project slot; partial positional lists must not silently reuse foreign profiles.
- Prepare one filament colour per slot, preserving explicit colours, project colours, and custom profile values in that order. Apply required colour overlays to standalone custom filament files without replacing their unrelated settings. Preserve an input project's saved prime-tower coordinates unless the caller explicitly overrides them; automatic multi-nozzle placement is only a fallback for an unset position.
- Never swallow an auto-slice failure and fall back to the original unsliced project. Preserve the actionable error. A .gcode.md5 checksum is not printable G-code.
- Reject duplicate/case-colliding ZIP names and inconsistent central/local records before JSZip can collapse them; read every 3MF through src/safety/archive.ts.
- Do not infer a successful physical print from a successful slice or a mocked run; this server never observes one.

## Blender MCP

- Standard Blender integration uses a stdio MCP client configured by trusted BLENDER_MCP_COMMAND and BLENDER_MCP_ARGS. Discover remote tool schemas, validate arguments, preserve MCP content/errors, and propagate addon-disconnected failures.
- Standard edit previews and execution require an explicit new output_path. Legacy-only custom bridge configuration may keep it optional and must not claim output verification.
- Standard STL edits preserve the existing scene, validate the export receipt and finite geometry, and never overwrite an existing output. Keep all processes on a shared local filesystem and require Blender Object Mode.
- Enforce deadlines/cancellation, close child processes, and never automatically replay a mutation. On an interrupted dispatched edit, report that execution may still be running. Test actual PID termination independently of graceful-shutdown logging.
- MCP process discovery does not prove the Blender addon is running; headless tests do not prove a live scene succeeded. State the evidence accurately.

## Repository hygiene

- `.gitignore` excludes agent scratch plans, progress logs, handoff notes, and draft comments with `*.md`, while explicitly allowing shared AGENTS/CLAUDE rules and public README, CHANGELOG, CONTRIBUTORS, and docs/SLICING documentation. Keep public docs and rules tracked and current; leave private agent notes local. Add an explicit exception for intentional new public documentation.
- Keep real credentials and private artifacts out of Git. Do not print secrets from .env or local configuration.
