#!/usr/bin/env node
// Builds knowledge/ (shipped, read at runtime) from the knowledge-base source of truth, which lives outside this repo.
//   node scripts/build-knowledge.mjs [sourceDir]     default: ../kb/out (or KB_SRC_DIR)
// Copies rules/facts/topics, validates, writes knowledge/manifest.json and refreshes tests/fixtures/knowledge/eval.json.
// knowledge/synonyms.json is authored here, not copied. The manifest holds names and hashes only, never absolute paths.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KB_FILES, canonical, report, sha256, validateKnowledge } from "./validate-knowledge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KNOWLEDGE = path.join(ROOT, "knowledge");
const EVAL = path.join(ROOT, "tests/fixtures/knowledge/eval.json");
const COPIED = KB_FILES.filter((n) => n !== "synonyms.json");

export function buildKnowledge(source = process.env.KB_SRC_DIR || path.join(ROOT, "..", "kb", "out")) {
  source = path.resolve(source);
  fs.mkdirSync(KNOWLEDGE, { recursive: true });
  fs.mkdirSync(path.dirname(EVAL), { recursive: true });
  const read = (name) => canonical(fs.readFileSync(path.join(source, name), "utf8"));
  for (const name of COPIED) fs.writeFileSync(path.join(KNOWLEDGE, name), read(name));
  fs.writeFileSync(EVAL, read("eval.json"));

  // The manifest comes after validation, which is why the manifest check is off here.
  const result = validateKnowledge(KNOWLEDGE, EVAL, { checkManifest: false });
  if (!report(result)) throw new Error("Knowledge base failed validation; knowledge/ holds the rejected copy (git checkout knowledge restores the last good one).");

  const files = Object.fromEntries(KB_FILES.map((n) => [n, sha256(canonical(fs.readFileSync(path.join(KNOWLEDGE, n), "utf8")))]));
  const manifest = {
    // Content-derived, so rebuilding unchanged sources changes nothing.
    kb_version: createHash("sha256").update(Object.values(files).join("")).digest("hex").slice(0, 12),
    counts: result.summary,
    files,
    sources: Object.fromEntries([...COPIED.map((n) => [n, "kb/out"]), ["synonyms.json", "authored in this repo"]]),
  };
  fs.writeFileSync(path.join(KNOWLEDGE, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = buildKnowledge(process.argv[2]);
    console.log(`knowledge/ built, kb_version ${manifest.kb_version}`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
