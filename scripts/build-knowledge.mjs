#!/usr/bin/env node
// Builds knowledge/ (shipped, read at runtime) from the knowledge-base source of truth, which lives outside this repo.
//   node scripts/build-knowledge.mjs [sourceDir] [tuningDir]     default: ../kb/out (or KB_SRC_DIR) and ../kb/tuning/out (or KB_TUNING_SRC_DIR)
// Copies rules/facts/topics and the tuning data (tuning.json, no_action.json, tuning-facts.json into knowledge/tuning/), validates,
// writes knowledge/manifest.json and refreshes tests/fixtures/knowledge/eval.json and tests/fixtures/tuning/eval.json.
// knowledge/synonyms.json is authored here, not copied. The manifest holds names and hashes only, never absolute paths.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KB_FILES, MANIFEST_FILES, TUNING_FILES, canonical, report, sha256, validateKnowledge } from "./validate-knowledge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KNOWLEDGE = path.join(ROOT, "knowledge");
const EVAL = path.join(ROOT, "tests/fixtures/knowledge/eval.json");
const TUNING = path.join(KNOWLEDGE, "tuning");
const TUNING_EVAL = path.join(ROOT, "tests/fixtures/tuning/eval.json");
const COPIED = KB_FILES.filter((n) => n !== "synonyms.json");

export function buildKnowledge(source = process.env.KB_SRC_DIR || path.join(ROOT, "..", "kb", "out"), tuningSource = process.env.KB_TUNING_SRC_DIR || path.join(ROOT, "..", "kb", "tuning", "out")) {
  source = path.resolve(source);
  tuningSource = path.resolve(tuningSource);
  fs.mkdirSync(TUNING, { recursive: true });
  fs.mkdirSync(path.dirname(EVAL), { recursive: true });
  fs.mkdirSync(path.dirname(TUNING_EVAL), { recursive: true });
  const read = (name, dir = source) => canonical(fs.readFileSync(path.join(dir, name), "utf8"));
  for (const name of COPIED) fs.writeFileSync(path.join(KNOWLEDGE, name), read(name));
  fs.writeFileSync(EVAL, read("eval.json"));
  for (const name of TUNING_FILES) fs.writeFileSync(path.join(TUNING, name), read(name, tuningSource));
  fs.writeFileSync(TUNING_EVAL, read("eval.json", tuningSource));

  // The manifest comes after validation, which is why the manifest check is off here.
  const result = validateKnowledge(KNOWLEDGE, EVAL, { checkManifest: false });
  if (!report(result)) throw new Error("Knowledge base failed validation; knowledge/ holds the rejected copy (git checkout knowledge restores the last good one).");

  const files = Object.fromEntries(MANIFEST_FILES.map((n) => [n, sha256(canonical(fs.readFileSync(path.join(KNOWLEDGE, n), "utf8")))]));
  const manifest = {
    // Content-derived, so rebuilding unchanged sources changes nothing.
    kb_version: createHash("sha256").update(Object.values(files).join("")).digest("hex").slice(0, 12),
    counts: result.summary,
    files,
    sources: Object.fromEntries([...COPIED.map((n) => [n, "kb/out"]), ["synonyms.json", "authored in this repo"], ...TUNING_FILES.map((n) => [`tuning/${n}`, "kb/tuning/out"])]),
  };
  fs.writeFileSync(path.join(KNOWLEDGE, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = buildKnowledge(process.argv[2], process.argv[3]);
    console.log(`knowledge/ built, kb_version ${manifest.kb_version}`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
