import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appBundleFor, openInSlicer } from "../dist/slicer/open-in-slicer.js";

test("appBundleFor finds the .app bundle of a macOS executable", () => {
  assert.equal(appBundleFor("/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"), "/Applications/BambuStudio.app");
  assert.equal(appBundleFor("/usr/bin/bambu-studio"), null);
});

test("openInSlicer validates the file before launching anything", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-in-slicer-"));
  const txt = path.join(dir, "notes.txt");
  fs.writeFileSync(txt, "x");
  await assert.rejects(openInSlicer(txt, process.execPath), /accepts \.3mf/);
  await assert.rejects(openInSlicer(path.join(dir, "missing.3mf"), process.execPath), /File not found/);
  fs.mkdirSync(path.join(dir, "folder.3mf"));
  await assert.rejects(openInSlicer(path.join(dir, "folder.3mf"), process.execPath), /Not a regular file/);
  const model = path.join(dir, "model.3mf");
  fs.writeFileSync(model, "x");
  await assert.rejects(openInSlicer(model, path.join(dir, "NoSlicer")), /executable not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("openInSlicer rejects instead of crashing the process when the executable cannot start", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-in-slicer-"));
  const model = path.join(dir, "model.3mf");
  fs.writeFileSync(model, "x");
  // A folder passes existsSync but cannot be spawned; an unhandled 'error' event would kill the server.
  await assert.rejects(openInSlicer(model, dir), /EACCES|ENOENT|EFTYPE|UNKNOWN/);
  fs.rmSync(dir, { recursive: true, force: true });
});
