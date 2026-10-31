#!/usr/bin/env node
// Knowledge-base contract validator (no dependencies), adapted from kb/validate.mjs "merged" mode to this repo's layout.
//   node scripts/validate-knowledge.mjs [knowledgeDir] [evalFile]
// Defaults: ./knowledge and tests/fixtures/knowledge/eval.json. Also checks knowledge/manifest.json against the files.
// Exit 1 and print one error per line when the contract is broken.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONF = ["preset", "oficial", "bug conhecido", "teste de revisor", "relato", "hipotese", "nao verificado"];
const AUTO_OK = new Set(["preset", "oficial"]); // only these may be applied without asking the user
const DOMAINS = ["bambu", "blender", "both"];
const SEVERITY = ["blocker", "warning", "tip"];
const STAGES = ["pre-slice", "project-settings", "post-slice-gcode", "blender-prep", "material", "hardware"];
const METHODS = ["settings", "gcode", "mesh", "3mf-structure", "blender", "manual", "none"];
const COST = ["free", "cheap", "expensive"];
const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "exists", "matches", "any_eq"];
const ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const FACT = /^(settings|printer|project|studio|mesh|gcode|blender|plate|filament|object)\.[a-z0-9_]+$/;
const SRC = /^(guide|playbook):\d+-\d+$/;
export const KB_FILES = ["rules.json", "facts.json", "bambu.topics.json", "blender.topics.json", "synonyms.json"];

/** Text as hashed in the manifest: no BOM, LF line endings (same rule as src/knowledge/loader.ts). */
export const canonical = (text) => text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const strArr = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const words = (s) => s.trim().split(/\s+/).length;

export function validateKnowledge(dir = path.join(ROOT, "knowledge"), evalFile = path.join(ROOT, "tests/fixtures/knowledge/eval.json"), { checkManifest = true } = {}) {
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);

  function checkCond(c, where, used) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return err(where, "condition must be an object");
    const keys = Object.keys(c);
    if (keys.length === 1 && (keys[0] === "all" || keys[0] === "any")) {
      if (!Array.isArray(c[keys[0]]) || !c[keys[0]].length) return err(where, `${keys[0]} needs a non-empty array`);
      return c[keys[0]].forEach((x, i) => checkCond(x, `${where}.${keys[0]}[${i}]`, used));
    }
    if (keys.length === 1 && keys[0] === "not") return checkCond(c.not, `${where}.not`, used);
    if (!("fact" in c) || !("op" in c)) return err(where, "leaf needs fact and op");
    if (!FACT.test(c.fact)) err(where, `bad fact name ${c.fact}`);
    else used.add(c.fact);
    if (!OPS.includes(c.op)) err(where, `bad op ${c.op}`);
    if (c.op !== "exists" && !("value" in c)) err(where, "leaf needs value");
    if (c.op === "in" && !Array.isArray(c.value)) err(where, "op in needs an array value");
  }

  function checkSrc(item, where) {
    if (!strArr(item.src) || !item.src.length || !item.src.every((s) => SRC.test(s))) err(where, "src must be [\"guide:12-30\" | \"playbook:5-9\", ...]");
  }

  function checkTopic(t, where) {
    if (!ID.test(t.id ?? "")) err(where, `bad id ${t.id}`);
    if (!DOMAINS.includes(t.domain)) err(where, "bad domain");
    if (!isStr(t.title)) err(where, "title missing");
    if (!strArr(t.tags) || !t.tags.length) err(where, "tags must be a non-empty string array");
    if (!strArr(t.symptoms) || t.symptoms.length < 2) err(where, "symptoms need at least 2 user phrases");
    if (!strArr(t.printers)) err(where, "printers must be a string array (empty = all)");
    if (t.applies_to !== null && (typeof t.applies_to !== "object" || Array.isArray(t.applies_to))) err(where, "applies_to must be an object or null");
    if (!CONF.includes(t.confidence)) err(where, `bad confidence ${t.confidence}`);
    if (!isStr(t.body)) err(where, "body missing");
    else if (words(t.body) < 15 || words(t.body) > 450) err(where, `body has ${words(t.body)} words (15-450)`);
    checkSrc(t, where);
  }

  function checkRule(r, where) {
    if (!ID.test(r.id ?? "")) err(where, `bad id ${r.id}`);
    if (!["bambu", "blender"].includes(r.domain)) err(where, "bad domain");
    if (!isStr(r.title)) err(where, "title missing");
    if (!SEVERITY.includes(r.severity)) err(where, "bad severity");
    if (!STAGES.includes(r.stage)) err(where, "bad stage");
    const d = r.detect;
    const used = new Set();
    if (!d || typeof d !== "object") err(where, "detect missing");
    else {
      if (!METHODS.includes(d.method)) err(where, "bad detect.method");
      if (!isStr(d.when_text)) err(where, "detect.when_text missing");
      if (!strArr(d.facts)) err(where, "detect.facts must be a string array");
      else d.facts.forEach((f) => FACT.test(f) || err(where, `bad fact name ${f}`));
      if (d.when !== null && d.when !== undefined) {
        if (["manual", "none"].includes(d.method)) err(where, "manual/none rules cannot have a machine condition");
        checkCond(d.when, `${where}.detect.when`, used);
        for (const f of used) if (!(d.facts ?? []).includes(f)) err(where, `condition uses ${f} not listed in detect.facts`);
      } else if (!["manual", "none", "blender", "gcode", "mesh"].includes(d.method)) {
        err(where, `method ${d.method} needs a machine-evaluable detect.when`);
      }
    }
    if (!isStr(r.problem)) err(where, "problem missing");
    const s = r.solution;
    if (!s || typeof s !== "object") err(where, "solution missing");
    else {
      if (s.settings !== null && (typeof s.settings !== "object" || Array.isArray(s.settings) || !Object.values(s.settings).every((v) => typeof v === "string"))) err(where, "solution.settings must be null or {key: \"string value\"}");
      if (!strArr(s.steps)) err(where, "solution.steps must be a string array");
      if (!isStr(s.message)) err(where, "solution.message missing");
      if (s.settings === null && !s.steps?.length) err(where, "solution needs settings or steps");
    }
    if (!CONF.includes(r.confidence)) err(where, `bad confidence ${r.confidence}`);
    if (typeof r.auto_apply !== "boolean") err(where, "auto_apply must be boolean");
    else if (r.auto_apply) {
      if (!r.solution?.settings || !Object.keys(r.solution.settings).length) err(where, "auto_apply needs solution.settings");
      if (!AUTO_OK.has(r.confidence)) err(where, `auto_apply not allowed for confidence ${r.confidence}`);
      if (r.stage === "blender-prep") err(where, "auto_apply not allowed for Blender steps");
    }
    if (!strArr(r.printers)) err(where, "printers must be a string array");
    if (r.applies_to !== null && (typeof r.applies_to !== "object" || Array.isArray(r.applies_to))) err(where, "applies_to must be an object or null");
    if (!ID.test(r.topic ?? "")) err(where, "topic must be a topic id");
    checkSrc(r, where);
  }

  function checkFacts(facts) {
    const names = new Set();
    if (!Array.isArray(facts)) return err("facts", "facts must be an array"), names;
    facts.forEach((f, i) => {
      const w = `facts[${i}]`;
      if (!FACT.test(f.name ?? "")) err(w, `bad name ${f.name}`);
      if (names.has(f.name)) err(w, `duplicate fact ${f.name}`);
      names.add(f.name);
      if (!isStr(f.description)) err(w, "description missing");
      if (!isStr(f.source_of_truth)) err(w, "source_of_truth missing");
      if (!COST.includes(f.cost)) err(w, "bad cost");
    });
    return names;
  }

  function dupes(items, where) {
    const seen = new Set();
    for (const it of items) { if (seen.has(it.id)) err(where, `duplicate id ${it.id}`); seen.add(it.id); }
    return seen;
  }

  const raw = {};
  const load = (n) => (raw[n] = canonical(fs.readFileSync(path.join(dir, n), "utf8")), JSON.parse(raw[n]));
  const topics = [...load("bambu.topics.json"), ...load("blender.topics.json")];
  const rules = load("rules.json"), facts = load("facts.json"), synonyms = load("synonyms.json");
  const ev = JSON.parse(canonical(fs.readFileSync(evalFile, "utf8")));
  const tIds = dupes(topics, "topics"), rIds = dupes(rules, "rules");
  const declared = checkFacts(facts);
  topics.forEach((t, i) => checkTopic(t, `topics[${i}] ${t.id}`));
  rules.forEach((r, i) => {
    const w = `rules[${i}] ${r.id}`;
    checkRule(r, w);
    if (!tIds.has(r.topic)) err(w, `topic ${r.topic} does not exist`);
    for (const f of r.detect?.facts ?? []) if (!declared.has(f) && !/^(settings|printer|project|studio)\./.test(f)) err(w, `fact ${f} not in facts.json`);
  });
  if (!Array.isArray(synonyms) || !synonyms.every((g) => strArr(g) && g.length >= 2)) err("synonyms.json", "must be an array of groups of at least two strings");
  (ev.questions ?? []).forEach((q, i) => {
    if (!isStr(q.q)) err(`eval.questions[${i}]`, "q missing");
    for (const t of q.expect_topics ?? []) if (!tIds.has(t)) err(`eval.questions[${i}]`, `unknown topic ${t}`);
    for (const r of q.expect_rules ?? []) if (!rIds.has(r)) err(`eval.questions[${i}]`, `unknown rule ${r}`);
  });
  (ev.scenarios ?? []).forEach((s, i) => {
    const w = `eval.scenarios[${i}] ${s.name}`;
    if (!isStr(s.name) || typeof s.facts !== "object" || !strArr(s.expect_rules) || !strArr(s.expect_not)) err(w, "needs name, facts{}, expect_rules[], expect_not[]");
    for (const r of [...(s.expect_rules ?? []), ...(s.expect_not ?? [])]) if (!rIds.has(r)) err(w, `unknown rule ${r}`);
    for (const f of Object.keys(s.facts ?? {})) if (!FACT.test(f)) err(w, `bad fact name ${f}`);
  });
  if (!Array.isArray(ev.questions) || !Array.isArray(ev.scenarios)) err("eval.json", "needs questions[] and scenarios[]");

  if (checkManifest) {
    try {
      const manifest = JSON.parse(canonical(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")));
      for (const n of KB_FILES) if (manifest.files?.[n] !== sha256(raw[n])) err("manifest.json", `sha256 of ${n} differs; run npm run kb:build`);
    } catch (e) {
      err("manifest.json", `unreadable (${e.message}); run npm run kb:build`);
    }
  }
  return {
    errors,
    summary: { topics: topics.length, rules: rules.length, facts: facts.length, synonym_groups: Array.isArray(synonyms) ? synonyms.length : 0, questions: ev.questions?.length ?? 0, scenarios: ev.scenarios?.length ?? 0 },
  };
}

export function report({ errors, summary }) {
  console.log(Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(" "));
  if (errors.length) {
    console.error(errors.slice(0, 60).join("\n") + (errors.length > 60 ? `\n... ${errors.length - 60} more` : ""));
    return false;
  }
  console.log("OK");
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [dir, evalFile] = process.argv.slice(2);
    if (!report(validateKnowledge(dir && path.resolve(dir), evalFile && path.resolve(evalFile)))) process.exitCode = 1;
  } catch (e) {
    console.error(`fatal: ${e.message}`);
    process.exitCode = 1;
  }
}
