import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OPENABLE = /\.(?:3mf|stl|step|stp|obj|gcode)$/i;

/** ".../BambuStudio.app/Contents/MacOS/BambuStudio" -> ".../BambuStudio.app"; null when not inside a bundle. */
export function appBundleFor(executable: string): string | null {
  const match = /^(.*?\.app)(?:\/|$)/.exec(executable);
  return match ? match[1] : null;
}

/** Opens a model or sliced project in the slicer's GUI so a person can review it. Never slices or prints. */
export async function openInSlicer(rawPath: string, executable: string): Promise<Record<string, unknown>> {
  const filePath = path.resolve(rawPath.trim());
  if (!OPENABLE.test(filePath)) throw new Error("open_in_slicer accepts .3mf, .stl, .step, .stp, .obj or .gcode files.");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  if (!executable || !fs.existsSync(executable)) throw new Error(`Slicer executable not found: ${executable || "(none configured)"}. Set SLICER_PATH.`);

  const bundle = process.platform === "darwin" ? appBundleFor(executable) : null;
  if (bundle) {
    // open -a reuses a running instance instead of starting a second copy.
    await execFileAsync("open", ["-a", bundle, filePath], { timeout: 30000 });
  } else {
    spawn(executable, [filePath], { detached: true, stdio: "ignore" }).unref();
  }
  return { opened: true, app: bundle ?? executable, file_path: filePath };
}
