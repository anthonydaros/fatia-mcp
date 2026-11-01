import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appBundleFor } from "./open-in-slicer.js";
import { detectProfilesRoot } from "./profile-flatten.js";
const execFileAsync = promisify(execFile);
const RELEASES_URL = "https://api.github.com/repos/bambulab/BambuStudio/releases?per_page=30";
const STATE_KEY = "bambustudio";
/** CFBundleShortVersionString from `plutil -convert json` output; null when absent or not JSON. */
export function versionFromPlistJson(json) {
    try {
        const version = JSON.parse(json)?.CFBundleShortVersionString;
        return typeof version === "string" && version.trim() ? version.trim() : null;
    }
    catch {
        return null;
    }
}
/** Installed app version: macOS Info.plist, Windows file ProductVersion, null elsewhere or on any failure. */
export async function readAppVersion(executable) {
    try {
        if (process.platform === "darwin") {
            const bundle = appBundleFor(executable);
            if (!bundle)
                return null;
            const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", path.join(bundle, "Contents", "Info.plist")], { timeout: 10000 });
            return versionFromPlistJson(stdout);
        }
        if (process.platform === "win32") {
            // The path travels in the environment, never inside the command text.
            const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item -LiteralPath $env:SLICER_EXE).VersionInfo.ProductVersion"], { timeout: 15000, windowsHide: true, env: { ...process.env, SLICER_EXE: executable } });
            return stdout.trim() || null;
        }
    }
    catch {
        // An unreadable version is reported as null.
    }
    return null;
}
/** "version" of BBL.json in the installation's profiles root; a different number from the app version. */
export function readProfileVersion(executable) {
    try {
        const version = JSON.parse(fs.readFileSync(path.join(detectProfilesRoot(executable), "BBL.json"), "utf8")).version;
        return typeof version === "string" ? version : null;
    }
    catch {
        return null;
    }
}
/** Published (non-draft) releases of bambulab/BambuStudio, newest first; null on any failure or after 5 s. */
export async function fetchReleases(fetchImpl = fetch) {
    try {
        const response = await fetchImpl(RELEASES_URL, {
            signal: AbortSignal.timeout(5000),
            headers: { Accept: "application/vnd.github+json", "User-Agent": "bambu-printer-mcp" },
        });
        if (!response.ok)
            return null;
        const list = await response.json();
        if (!Array.isArray(list))
            return null;
        return list
            .filter(r => r && !r.draft && typeof r.tag_name === "string")
            .map(r => ({ tag: r.tag_name, published_at: r.published_at ?? null, url: String(r.html_url ?? ""), prerelease: Boolean(r.prerelease) }));
    }
    catch {
        return null;
    }
}
// "v02.08.04.57" and "2.8.4.57" name the same build.
export const normalizeVersion = (v) => v.trim().replace(/^v/i, "").replace(/\b0+(?=\d)/g, "");
export const sameVersion = (a, b) => normalizeVersion(a) === normalizeVersion(b);
/** Keeps the first real answer of a version lookup (it spawns plutil or PowerShell); a null (slicer unreadable just now) is asked again. */
export function keepVersion(read) {
    let version = null;
    return async () => (version ?? (version = await read()));
}
export function stateFilePath() {
    return path.resolve(process.env.SLICER_STATE_FILE?.trim() || path.join(os.homedir(), ".bambu-printer-mcp", "slicers.json"));
}
function readState(file) {
    try {
        const state = JSON.parse(fs.readFileSync(file, "utf8"));
        return state && typeof state === "object" && !Array.isArray(state) ? state : {};
    }
    catch {
        return {}; // Missing or corrupt: no baseline yet.
    }
}
export async function slicerInfo(options) {
    const { executable } = options;
    // shortcut: a bare command name (Linux PATH lookup) reads as not installed; macOS and Windows use full paths.
    const installed = fs.existsSync(executable);
    const appVersion = installed ? await readAppVersion(executable) : null;
    const profileVersion = installed ? readProfileVersion(executable) : null;
    const releases = options.checkUpdates === false ? null : await fetchReleases(options.fetchImpl);
    const pick = (prerelease) => {
        const found = releases?.find(r => r.prerelease === prerelease);
        return found ? { tag: found.tag, published_at: found.published_at, url: found.url } : null;
    };
    const stateFile = options.stateFile ?? stateFilePath();
    const state = readState(stateFile);
    const previous = state[STATE_KEY] ?? null;
    const changed = previous !== null && (previous.app_version !== appVersion || previous.profile_version !== profileVersion);
    if (options.acknowledge) {
        if (appVersion === null && profileVersion === null) {
            throw new Error(`Cannot acknowledge: no Bambu Studio version could be read from ${executable}. Set SLICER_PATH or BAMBU_STUDIO_PATH.`);
        }
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        const seen = { app_version: appVersion, profile_version: profileVersion, recorded_at: new Date().toISOString() };
        fs.writeFileSync(stateFile, `${JSON.stringify({ ...state, [STATE_KEY]: seen }, null, 2)}\n`);
    }
    return {
        slicer: STATE_KEY,
        installed,
        executable,
        app_version: appVersion,
        profile_version: profileVersion,
        latest_release: releases ? { stable: pick(false), prerelease: pick(true) } : null,
        is_prerelease_installed: releases && appVersion ? releases.some(r => r.prerelease && sameVersion(r.tag, appVersion)) : null,
        changed_since_last_seen: changed,
        previous_version: previous?.app_version ?? null,
        previous_profile_version: previous?.profile_version ?? null,
        last_seen_at: previous?.recorded_at ?? null,
        acknowledged: Boolean(options.acknowledge),
        state_file: stateFile,
    };
}
