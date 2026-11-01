# Setup reference for agents and manual configuration

[Back to README](../README.md#set-up-with-your-agent) · [Slicing guide](./SLICING.md)

The README provides the copy-and-paste setup request. Use this reference for exact environment variables, manual installation, and troubleshooting. This server never connects to a printer, so there is no printer address, serial number, access code or LAN setting to configure. Preserve the user's existing MCP configuration and use the current harness's supported configuration format.

## Installation

### Prerequisites

- Node.js 24 (the version used by CI and release workflows)
- npm
- **Bambu Studio** *(needed to slice and to print)*: [download](https://bambulab.com/en/download/studio). The CLI slices; you review the result and print from the Bambu Studio GUI.


**Bambu Studio CLI slicing** requires the exact machine preset and matching BBL profile tree. See the [slicing guide](./SLICING.md).

### Install this fork

Download `fatia-mcp.mcpb` from [GitHub Releases](https://github.com/anthonydaros/fatia-mcp/releases) for Claude Desktop, or build from source:

```bash
git clone https://github.com/anthonydaros/fatia-mcp.git
cd fatia-mcp
npm ci
npm run build
```

Configure your MCP client to run `node /absolute/path/to/fatia-mcp/dist/index.js` with stdio. `npm link` optionally exposes the `fatia-mcp` command locally. Initial distribution is through GitHub Releases and source; the package identity is `@anthonydaros/fatia-mcp`.


---

## Configuration

Create a `.env` file in the directory where you run the server, or pass environment variables directly in your MCP client config.

```env
# --- Printer model (selects the machine profile to slice for) ---
BAMBU_MODEL=p1s                   # Your printer model: p1s, p1p, p2s, x1c, x1e, a1, a1mini, h2d, h2dpro, h2s, h2c, x2d
# Alias also accepted: BAMBU_PRINTER_MODEL
BED_TYPE=textured_plate           # Bed plate type: textured_plate, cool_plate, engineering_plate, hot_plate, supertack_plate
NOZZLE_DIAMETER=0.4               # Nozzle diameter in mm (default: 0.4)

# --- Slicer configuration (required for slice_stl and prepare_print_project) ---
SLICER_TYPE=bambustudio           # Also: prusaslicer, cura, slic3r
SLICER_PATH=/Applications/BambuStudio.app/Contents/MacOS/BambuStudio
                                  # Default on macOS. Adjust for your OS and install path.
# BAMBU_STUDIO_PATH supplies the BambuStudio executable default only
SLICER_PROFILE=                   # Optional: path to a slicer profile/config file

# --- Temporary file directory ---
# TEMP_DIR=                      # Leave unset for a private OS temp directory per server instance.

# --- MCP transport ---
MCP_TRANSPORT=stdio               # Options: stdio (default), streamable-http

# --- Streamable HTTP transport (only used when MCP_TRANSPORT=streamable-http) ---
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3000
MCP_HTTP_PATH=/mcp
MCP_HTTP_STATEFUL=true
MCP_HTTP_JSON_RESPONSE=true
MCP_HTTP_ALLOWED_ORIGINS=http://localhost

# --- Optional standard Blender MCP server ---
BLENDER_MCP_COMMAND=uvx          # Executable or full path; no shell command string
BLENDER_MCP_ARGS='["blender-mcp"]'
BLENDER_MCP_TIMEOUT_MS=120000
# Start the matching MCP addon inside Blender.
# Legacy custom executable bridge (optional): BLENDER_MCP_BRIDGE_COMMAND=
```

### Environment variables reference

| Variable | Default | Required | Description |
|---|---|---|---|
| `BAMBU_MODEL` | | **Slicing** | Printer model: `p1s`, `p1p`, `p2s`, `x1c`, `x1e`, `a1`, `a1mini`, `h2d`, `h2dpro`, `h2s`, `h2c`, `x2d`. **Required** to select the machine preset to slice for; G-code sliced for the wrong model can damage the printer when you print it. Alias: `BAMBU_PRINTER_MODEL`. If omitted and the MCP client supports elicitation, the server will ask you interactively. Use `h2dpro` for H2D Pro, `h2c` for H2C and `x2d` for X2D; do not use `h2d` as a fallback. |
| `BED_TYPE` | `textured_plate` | No | Bed plate type: `textured_plate`, `cool_plate`, `engineering_plate`, `hot_plate`, `supertack_plate` |
| `NOZZLE_DIAMETER` | `0.4` | No | Nozzle diameter in mm. Used to select the correct model/nozzle machine preset. |
| `BAMBU_NOZZLE_TYPE` | model preset's stock nozzle | No | Installed nozzle for slicing: `stainless_steel`, `hardened_steel`, `tungsten_carbide`, or `brass`. Set it if you replaced the stock nozzle; the slice is written for that nozzle. |
| `BAMBU_NOZZLE_VOLUME_TYPE` | `standard` | No | Installed nozzle flow type for slicing: `standard` or `high_flow`. Set `high_flow` if a High Flow nozzle is installed; the slice is written for that flow type. |
| `BAMBU_CONFIRMATION_TIMEOUT_MS` | `600000` | No | How long the printer-model and project-settings prompts wait for an answer (1000 to 3600000 ms). Nothing is sliced when it expires. |
| `SLICER_TYPE` | `bambustudio` | No | `bambustudio`, `prusaslicer`, `cura`, or `slic3r` |
| `SLICER_PATH` | Platform default for the selected slicer | No | Full path to the slicer executable. `BAMBU_STUDIO_PATH` supplies the BambuStudio default only |
| `SLICER_PROFILE` | | No | Process profile/config file; `BAMBU_SLICER_PROFILE` takes precedence. Does not replace the required machine preset for BambuStudio |
| `MCP_ALLOW_EXECUTABLE_ARG` | disabled | No | Enables per-call executable overrides; normally configure executables in server environment instead |
| `BAMBU_TEMPLATE_DIR` | `~/Sync/bambu/templates` | No | Named slicing-template registry |
| `BAMBU_TEMPLATE_3MF_PATH` | | No | Default template 3MF for slicing |
| `TEMP_DIR` | private folder under the system temporary directory | No | Scratch files only; removed at process exit when automatically created. Relative paths resolve from the server working directory |
| `FATIA_OUTPUT_DIR` | `~/.fatia-mcp/outputs` | No | Persistent delivered models and slices. Never removed on server shutdown; `prepare_print_project.output_dir` overrides it for one call |
| `MCP_TRANSPORT` | `stdio` | No | Transport mode: `stdio` or `streamable-http` |
| `MCP_HTTP_HOST` | `127.0.0.1` | No | HTTP bind address (HTTP transport only) |
| `MCP_HTTP_PORT` | `3000` | No | HTTP port (HTTP transport only) |
| `MCP_HTTP_PATH` | `/mcp` | No | HTTP endpoint path (HTTP transport only) |
| `MCP_HTTP_STATEFUL` | `true` | No | Enable stateful HTTP sessions |
| `MCP_HTTP_JSON_RESPONSE` | `true` | No | Return structured JSON alongside text responses |
| `MCP_HTTP_ALLOWED_ORIGINS` | | No | Comma-separated list of allowed CORS origins |
| `BLENDER_MCP_COMMAND` | | No | Trusted executable for a standard stdio Blender MCP server, e.g. full path to `uvx` |
| `BLENDER_MCP_ARGS` | `[]` | No | JSON array of server arguments, e.g. `["blender-mcp"]`; no shell parsing |
| `BLENDER_MCP_TIMEOUT_MS` | `120000` | No | Connection/discovery/call deadline, 100–300000 ms; interrupted edits are never retried automatically |
| `DISABLE_TELEMETRY` | | No | Passed to the Blender MCP child process (the only variable besides `BLENDER_*` ones), so `DISABLE_TELEMETRY=1` turns off the upstream server's telemetry on any platform without an `/usr/bin/env` wrapper |
| `BLENDER_MCP_BRIDGE_COMMAND` | | No | Legacy custom executable receiving `MCP_BLENDER_PAYLOAD`; separate from the standard MCP integration |
| `BAMBU_CLI_FLATTEN` | automatic | No | Legacy setting; BBL profile resolution now always runs when profiles contain inheritance or includes. A false/unset value cannot bypass required machine G-code. Standalone custom files without dependencies pass through. See [slicing guide](https://github.com/anthonydaros/fatia-mcp/blob/main/docs/SLICING.md). |
| `BAMBU_PROFILES_ROOT` | derived from `SLICER_PATH` | No | Override path to the selected slicer's `Resources/profiles` directory containing `BBL`. BambuStudio uses this tree exclusively for bundled profiles. Useful for non-standard installs or dev environments. |
| `SLICER_STATE_FILE` | `~/.bambu-printer-mcp/slicers.json` | No | JSON file where `slicer_info` records the Bambu Studio app and profile versions you last approved (`acknowledge: true`), so it can report `changed_since_last_seen`. The folder is created on first write |

BambuStudio CLI slicing currently fails fast for `supertack_plate` because the accepted CLI bed identifier is not verified. Slice SuperTack projects in the Bambu Studio GUI until this is confirmed.

---

Delivered artifacts persist in `~/.fatia-mcp/outputs`. `FATIA_OUTPUT_DIR` selects another durable folder; `output_dir` on `prepare_print_project` selects it for one call. `TEMP_DIR` is scratch only and is resolved against the server working directory.

HTTP defaults to loopback. Host headers must match a local alias or the configured bind address and port. Browser Origins must match the endpoint, or an explicit `MCP_HTTP_ALLOWED_ORIGINS` entry. Native clients without Origin remain supported. Each stateful client has its own session; stateless requests use fresh transports. This local transport is not an authenticated public hosting service.

## MCP client configuration

Add this server to your MCP client's config (Claude Desktop, Claude Code, Cursor, Codex CLI, or any MCP-compatible client). The example below uses the `mcpServers` JSON format supported by Claude Desktop and Claude Code. Other clients may use a different format; configure the same command, arguments, and environment in their MCP settings:

```json
{
  "mcpServers": {
    "fatia": {
      "command": "node",
      "args": ["/absolute/path/to/fatia-mcp/dist/index.js"],
      "env": {
        "BAMBU_MODEL": "p1s",
        "SLICER_TYPE": "bambustudio",
        "SLICER_PATH": "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"
      }
    }
  }
}
```

Where this config lives depends on your client:

| Client | Config location |
|--------|----------------|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code (project) | `.mcp.json` in project root |
| Claude Code (user scope) | `~/.claude.json`; see [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp) |
| Cursor | MCP settings in Cursor preferences |
| Codex CLI / app | `~/.codex/config.toml` uses TOML; see [Codex MCP configuration](https://developers.openai.com/codex/mcp/) |

Restart your client after editing the config.

### Alternative: Claude Desktop extension (.mcpb)

You can install this server into Claude Desktop without editing JSON by using the `.mcpb` extension bundle. Download `fatia-mcp.mcpb` from the [latest release](https://github.com/anthonydaros/fatia-mcp/releases), double-click it, and Claude Desktop's extension wizard will register the server. You'll be prompted for your printer model, plus the optional Blender and slicer settings -- the same values as the `mcpServers` config above.

For local extension development, if your Claude Desktop installation permits it:

1. Clone the repo and run `npm ci && npm run build`.
2. Open Claude Desktop -> **Settings** -> **Extensions** -> **Advanced Settings** -> **Extension Developer** -> **Install Unpacked**.
3. Select the repo's root directory (the one containing `manifest.json`).

To build the bundle yourself instead of downloading a release asset:

```bash
npm ci
npm run package:mcpb
```

This produces `fatia-mcp.mcpb` in the repo root using a pinned packaging tool. Packaging installs production dependencies in a temporary directory, retains licenses and source, excludes local credentials and models, and leaves your development dependencies intact.

### Optional code mode

Use the harness's built-in code mode or equivalent when available. Otherwise, suggest a compatible, maintained integration as an optional way to discover and compose tools. Check that integration's current setup instructions before recommending it. Direct MCP use is fully supported; code mode is not required to install or use this server. See [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) for the approach.
