# bambu-printer-mcp

This file is the repository's shared source of truth for local agents, GitHub Codex review, and scheduled maintenance. Read it before changing or reviewing code. CLAUDE.md and .claude/agents.md defer to these rules.

## Release and review

- Every update to main requires an npm patch version bump and publication, including code, documentation, and configuration. Run `npm version patch` once for the release, and include its package.json, package-lock.json, and manifest.json changes in the same integration to main.
- Before opening or updating a PR, run Matt Pocock's `code-review` skill against the main merge base. Resolve substantive standards and spec findings locally; keep its issue-tracker note as ignored agent scratch rather than adding another required public template.
- Run the local `code-review` gate before pushing PR updates so problems are caught before spending on GitHub Actions. Use a PR to main, include `@codex review` in change commit messages, and request `@codex review` on the PR. After each update, wait at least five minutes and for Codex review plus CI to complete on the current head. Inspect inline findings as well as summary comments, fix actionable findings, and repeat. Local review supplements GitHub review and CI; it does not disable or replace either. A stale review or passing local test does not authorize ignoring current CI failures.
- Prioritize substantive defects and regressions in supported workflows. Document and defer obscure edge cases, speculative hardening, and cosmetic objections instead of extending a sound release into an endless review loop.
- Never add AI or agent attribution anywhere in Git or GitHub: no `Co-Authored-By` trailers for Claude, Codex, or other assistants, no "Generated with" footers, and no agent session links in commits, PR titles or bodies, review replies, issue comments, or release notes.
- Preserve original authorship when integrating contributor PRs. Credit code, issue reports, hardware evidence, and useful superseded proposals in CONTRIBUTORS.md. Clearly distinguish merged changes, superseded proposals, and deferred work.
- The main-branch Publish Package workflow runs the checks and `npm publish` using trusted publishing. Verify that workflow and the exact npm version before claiming publication; do not publish an unmerged release ahead of review.
- Create a `v<version>` tag on the final merged release commit and a GitHub Release. The tag workflow builds and uploads the `.mcpb` extension. Verify npm, package/manifest versions, the release asset, and fresh installed startup before declaring the release complete. Never move a published tag.
- After merging and verifying the release, switch back to main and delete the merged temporary integration branch locally and from origin.
- Changes to src/, scripts/, or slicing behavior need a present-tense CHANGELOG.md entry under `## Unreleased` while preparing the release. Run `npm version patch` only after accumulating the release notes: its version hook promotes that heading to the new version and date. If review adds notes after the bump, place them in that release's section. Released changes must never remain under `Unreleased` on main. Use that version's entries in GitHub release notes, with contributor credit and validation limits. Supply multiline notes via a body file.

## Build and test

- `npm run build` must finish with zero TypeScript errors before committing. Keep tracked dist/ output synchronized with source.
- `node --test tests/behavior.test.mjs` must pass all current tests before pushing. Do not rely on an old fixed test count.
- `npm test` builds and runs the full suite, including the exact tool list, slicer safety, the tuning loop, the knowledge base, Blender MCP, real npm installation layouts, and desktop packaging. It must pass before release; CI uses Node.js 24 on Linux.
- Tests use compiled dist/ files, so build before focused test commands. Optional tests against an installed BambuStudio profile tree may skip when that tree or model is unavailable; report those skips separately from failures.
- For installation changes, test the actual tarball in local-hoisted, global, and npm-exec layouts and start the installed server. For desktop changes, inspect and initialize the extracted MCPB archive.
- Do not launch the Bambu Studio GUI or mutate the user's live Blender scene during routine tests. Mock the slicer boundary and use isolated headless Blender. Set BAMBU_MODEL explicitly to an empty string in tests of missing-model behavior so dotenv cannot supply a real configuration.

## Architecture and installation

- Bambu-only fork of mcp-3D-printer-server. Do not add OctoPrint, Klipper, Duet, Repetier, Prusa, or Creality printer integrations.
- This fork never contacts or controls a printer. Do not add MQTT, FTPS, camera, cloud, Bambu Connect, native-helper or any other code that talks to a printer, uploads a file to one, or starts, pauses, cancels or otherwise controls a print. The user prints from the Bambu Studio GUI. `tests/tool-surface.test.mjs` pins the exact tool list and fails if a printer transport is imported.
- Keep runtime diagnostics on stderr so stdout carries only MCP protocol messages.
- MCP transports: stdio by default and streamable-http.
- Package only intended runtime, source, licenses, and contributor files. Build MCPB in isolated staging without pruning the developer checkout. Never package credentials, local configuration, or private models.
- Use a private OS temporary directory per server instance and distinct generated profile paths for differing content.

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
