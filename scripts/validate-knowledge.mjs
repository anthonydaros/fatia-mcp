#!/usr/bin/env node
// Knowledge-base contract validator (no dependencies), adapted from kb/validate.mjs "merged" mode to this repo's layout.
//   node scripts/validate-knowledge.mjs [knowledgeDir] [evalFile]
// Defaults: ./knowledge and tests/fixtures/knowledge/eval.json. Also checks knowledge/manifest.json against the files,
// and knowledge/tuning/ (the tuning actions of kb/tuning, CONTRACT-TUNING.md v2) against the rules, topics and facts, with
// tests/fixtures/tuning/eval.json as the tuning scenarios.
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
export const TUNING_FILES = ["tuning.json", "no_action.json", "tuning-facts.json"];
/** Keys of manifest.files: the knowledge files, then the tuning files under tuning/. */
export const MANIFEST_FILES = [...KB_FILES, ...TUNING_FILES.map((n) => `tuning/${n}`)];

const RISK = ["low", "medium", "high"];
const T_PHASE = ["pre-slice", "post-slice"];
const T_SCOPE = ["process", "filament", "printer", "object"];
const T_MODE = ["set", "at_least", "at_most"];
const T_KIND = ["definite", "choice", "ladder"];
const LADDER_COST = ["tempo", "material", "qualidade", "resistencia", "nenhum"];
const NO_ACTION = ["hardware", "manual", "not-a-setting", "no-measurable-trigger", "risk", "contradiction", "needs-user-context", "gcode-detector-only"];
const ACTION_ID = /^tune\.[a-z0-9-]+\.[a-z0-9-]+$/;
const T_FACT = /^(settings|printer|project|studio|mesh|gcode|blender|plate|filament|object|slicer)\.[a-z0-9_]+$/;
const T_FREE_NS = /^(settings|printer|project|studio|plate|slicer)\./; // facts the project, the installed Studio or the slice itself say: no declaration needed
const T_SRC = /^guide:\d+-\d+$/;
const VERSION_CLAUSE = /^\s*(<=|>=|<|>|=)?\s*(\d+|x)(\.(?:\d+|x)){0,3}\s*$/i;

/**
 * applies_to.bambu_studio forms on which src/knowledge/version.ts (used by the engine) and the reference engine agree. ">", "<=" and "=" with fewer
 * than four numeric segments count the missing segments as 0 in version.ts and are not compared in the reference, so they are rejected here.
 */
export function tuningVersionForm(predicate) {
  return String(predicate).split(",").every((part) => {
    const m = VERSION_CLAUSE.exec(part);
    if (!m) return false;
    const segs = part.replace(/^\s*(<=|>=|<|>|=)?\s*/, "").trim().split(".");
    const numeric = segs.every((x) => /^\d+$/.test(x));
    if (!m[1]) return true; // bare: both engines compare the segments the predicate names
    if (m[1] === ">=" || m[1] === "<") return numeric;
    return numeric && segs.length === 4;
  });
}

/** Text as hashed in the manifest: no BOM, LF line endings (same rule as src/knowledge/loader.ts). */
export const canonical = (text) => text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const strArr = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const words = (s) => s.trim().split(/\s+/).length;

export function validateKnowledge(dir = path.join(ROOT, "knowledge"), evalFile = path.join(ROOT, "tests/fixtures/knowledge/eval.json"), { checkManifest = true, tuningEvalFile = path.join(ROOT, "tests/fixtures/tuning/eval.json") } = {}) {
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

  const tuning = checkTuning({ load: (n) => (raw[`tuning/${n}`] = canonical(fs.readFileSync(path.join(dir, "tuning", n), "utf8"))), evalFile: tuningEvalFile, rules, topics, facts, err });

  if (checkManifest) {
    try {
      const manifest = JSON.parse(canonical(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")));
      for (const n of MANIFEST_FILES) if (manifest.files?.[n] !== sha256(raw[n])) err("manifest.json", `sha256 of ${n} differs; run npm run kb:build`);
    } catch (e) {
      err("manifest.json", `unreadable (${e.message}); run npm run kb:build`);
    }
  }
  return {
    errors,
    summary: { topics: topics.length, rules: rules.length, facts: facts.length, synonym_groups: Array.isArray(synonyms) ? synonyms.length : 0, questions: ev.questions?.length ?? 0, scenarios: ev.scenarios?.length ?? 0, ...tuning },
  };
}

/** knowledge/tuning/: the contract of kb/tuning/CONTRACT-TUNING.md that the engine and the report rely on. Returns the counts for the summary. */
function checkTuning({ load, evalFile, rules, topics, facts, err }) {
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  let actions, noAction, tFacts;
  try {
    actions = JSON.parse(load("tuning.json"));
    noAction = JSON.parse(load("no_action.json"));
    tFacts = JSON.parse(load("tuning-facts.json"));
  } catch (e) {
    err("tuning", `unreadable (${e.message}); run npm run kb:build`);
    return { actions: 0, no_action: 0, tuning_facts: 0, tuning_scenarios: 0, tuning_sequences: 0 };
  }
  if (![actions, noAction, tFacts].every(Array.isArray)) {
    err("tuning", "tuning.json, no_action.json and tuning-facts.json must each be an array");
    return { actions: 0, no_action: 0, tuning_facts: 0, tuning_scenarios: 0, tuning_sequences: 0 };
  }
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const declared = new Set(facts.map((f) => f.name));
  tFacts.forEach((f, i) => {
    const w = `tuning-facts[${i}]`;
    if (!T_FACT.test(f?.name ?? "")) err(w, `bad name ${f?.name}`);
    else if (f.name.startsWith("blender.")) err(w, "blender.* facts are not allowed in tuning (Blender is on demand only)");
    else if (declared.has(f.name)) err(w, `fact ${f.name} is already in facts.json`);
    declared.add(f?.name);
    if (!isStr(f?.description)) err(w, "description missing");
    if (!isStr(f?.source_of_truth)) err(w, "source_of_truth missing");
    if (!COST.includes(f?.cost)) err(w, "bad cost");
  });

  function cond(c, where, used, { top = false, settingsOnly = false } = {}) {
    if (!isObj(c)) return err(where, "condition must be an object");
    const keys = Object.keys(c);
    if (keys.length === 1 && (keys[0] === "all" || keys[0] === "any")) {
      const list = c[keys[0]];
      if (!Array.isArray(list)) return err(where, `${keys[0]} needs an array`);
      if (!list.length) return top && keys[0] === "all" && !settingsOnly ? undefined : err(where, `${keys[0]} needs a non-empty array (only a top-level when {"all":[]} means unconditional)`);
      return list.forEach((x, i) => cond(x, `${where}.${keys[0]}[${i}]`, used, { settingsOnly }));
    }
    if (keys.length === 1 && keys[0] === "not") return cond(c.not, `${where}.not`, used, { settingsOnly });
    if (!("fact" in c) || !("op" in c)) return err(where, "leaf needs fact and op");
    if (!T_FACT.test(c.fact)) err(where, `bad fact name ${c.fact}`);
    else {
      used.add(c.fact);
      if (settingsOnly && !c.fact.startsWith("settings.")) err(where, `only_if may use settings.* only, not ${c.fact}`);
    }
    if (!OPS.includes(c.op)) return err(where, `bad op ${c.op}`);
    if (c.op !== "exists" && !("value" in c)) err(where, "leaf needs value");
    if (c.op === "in" && !Array.isArray(c.value)) err(where, "op in needs an array value");
    if (c.op === "matches") try { new RegExp(c.value); } catch { err(where, `bad regex ${c.value}`); }
  }
  function spec(v, where) {
    if (typeof v === "string" && v.length) return;
    if (isObj(v) && typeof v.ref === "string" && v.ref.startsWith("settings.") && ["mul", "add", "round"].every((k) => v[k] === undefined || Number.isFinite(v[k]))) return;
    err(where, "a value must be a non-empty string or {ref: \"settings.<key>\", mul?, add?, round?}");
  }
  function setMap(m, where) {
    if (!isObj(m) || !Object.keys(m).length) return err(where, "set must be a non-empty object {key: value}");
    for (const [k, v] of Object.entries(m)) spec(v, `${where}.${k}`);
  }
  function used(names, w, what) {
    for (const f of names) {
      if (f.startsWith("blender.")) err(w, `${what} uses ${f}: no tuning action may depend on blender.* facts`);
      else if (!T_FREE_NS.test(f) && !declared.has(f)) err(w, `fact ${f} (${what}) is not declared in facts.json or tuning-facts.json`);
    }
  }

  const ids = new Set(), covered = new Set();
  actions.forEach((a, i) => {
    const w = `tuning[${i}] ${a?.id}`;
    if (!isObj(a)) return err(w, "action must be an object");
    if (!ACTION_ID.test(a.id ?? "")) err(w, `bad id ${a.id}`);
    if (ids.has(a.id)) err(w, `duplicate action id ${a.id}`);
    ids.add(a.id);
    const kind = a.kind ?? "definite";
    if (!T_KIND.includes(kind)) return err(w, `bad kind ${a.kind}`);
    if (!isStr(a.title)) err(w, "title missing");
    if (!strArr(a.rules) || !a.rules.length) err(w, "rules must list at least one rule id");
    else for (const r of a.rules) { covered.add(r); if (ruleById.get(r)?.domain !== "bambu") err(w, `rule ${r} is not a bambu rule of rules.json`); }
    if (!["bambu", "both"].includes(topicById.get(a.topic)?.domain)) err(w, `topic ${a.topic} does not exist (or is a Blender topic)`);
    if (!T_PHASE.includes(a.phase)) err(w, `bad phase ${a.phase}`);
    if (!T_SCOPE.includes(a.scope)) err(w, `bad scope ${a.scope}`);
    if (!CONF.includes(a.confidence)) err(w, `bad confidence ${a.confidence}`);
    if (!RISK.includes(a.risk)) err(w, `bad risk ${a.risk}`);
    else if (a.risk === "high" && !AUTO_OK.has(a.confidence)) err(w, "risk high needs confidence preset or oficial");
    if (!Number.isInteger(a.priority) || a.priority < 1 || a.priority > 100) err(w, "priority must be an integer 1-100");
    if (!strArr(a.printers)) err(w, "printers must be a string array (empty = all)");
    if (a.applies_to !== null) {
      if (!isObj(a.applies_to) || Object.keys(a.applies_to).some((k) => k !== "bambu_studio" && k !== "blender")) err(w, "applies_to must be null or {bambu_studio?: predicate}");
      else if (a.applies_to.bambu_studio !== undefined && !tuningVersionForm(a.applies_to.bambu_studio)) err(w, `applies_to.bambu_studio "${a.applies_to.bambu_studio}" is not a form the engine and the reference agree on (use >=, < or <, or a full 4-segment version)`);
    }
    if (!isStr(a.rationale)) err(w, "rationale missing");
    if (!isStr(a.when_text)) err(w, "when_text missing");
    if (!strArr(a.src) || !a.src.length || !a.src.every((x) => T_SRC.test(x))) err(w, "src must be [\"guide:12-30\", ...]");
    const names = new Set();
    cond(a.when, `${w}.when`, names, { top: true });
    if (kind === "definite") {
      if (!T_MODE.includes(a.mode)) err(w, `bad mode ${a.mode}`);
      setMap(a.set, `${w}.set`);
      if (a.elements !== undefined && !(isObj(a.elements) && isStr(a.elements.index_by) && isStr(a.elements.starts_with))) err(w, "elements must be {index_by, starts_with}");
    } else if (a.elements !== undefined || a.set !== undefined) err(w, `${kind} actions have no set/elements`);
    if (kind === "choice") {
      if (!isStr(a.key)) err(w, "key missing");
      if (!Array.isArray(a.candidates) || !a.candidates.length) err(w, "candidates must be a non-empty array");
      else {
        a.candidates.forEach((c, j) => spec(c, `${w}.candidates[${j}]`));
        if (!Number.isInteger(a.start) || a.start < 0 || a.start >= a.candidates.length) err(w, "start must be an index of candidates");
      }
      if (!strArr(a.evaluated_by)) err(w, "evaluated_by must be a string array (empty if nothing measures the choice)");
      else for (const f of a.evaluated_by) names.add(f);
    }
    if (kind === "ladder") {
      cond(a.trigger, `${w}.trigger`, names);
      if (!isStr(a.exhausted)) err(w, "exhausted text missing");
      if (a.relax !== undefined && typeof a.relax !== "boolean") err(w, "relax must be boolean");
      if (!Array.isArray(a.steps) || !a.steps.length) err(w, "steps must be a non-empty array");
      else a.steps.forEach((s, j) => {
        const sw = `${w}.steps[${j}]`;
        setMap(s?.set, `${sw}.set`);
        if (!isStr(s?.why)) err(sw, "why missing");
        if (!LADDER_COST.includes(s?.cost)) err(sw, `bad cost ${s?.cost}`);
        if (!isStr(s?.expect)) err(sw, "expect missing");
        if (!CONF.includes(s?.confidence)) err(sw, `bad confidence ${s?.confidence}`);
        if (!strArr(s?.src) || !s.src.length || !s.src.every((x) => T_SRC.test(x))) err(sw, "src must be [\"guide:12-30\", ...]");
        if (s?.only_if !== undefined) cond(s.only_if, `${sw}.only_if`, names, { settingsOnly: true });
      });
    }
    used(names, w, "a condition or evaluated_by");
  });

  const naRules = new Set();
  noAction.forEach((n, i) => {
    const w = `no_action[${i}] ${n?.rule}`;
    if (!ruleById.has(n?.rule)) err(w, `rule ${n?.rule} does not exist`);
    if (naRules.has(n?.rule)) err(w, "duplicate no_action rule");
    naRules.add(n?.rule);
    if (!NO_ACTION.includes(n?.reason)) err(w, `bad reason ${n?.reason}`);
    if (!isStr(n?.note)) err(w, "note missing");
  });
  for (const r of rules) if (r.domain === "bambu" && !covered.has(r.id) && !naRules.has(r.id)) err("tuning", `bambu rule ${r.id} is neither in an action's rules nor in no_action.json`);

  let scenarios = 0, sequences = 0;
  if (evalFile) {
    try {
      const ev = JSON.parse(canonical(fs.readFileSync(evalFile, "utf8")));
      const known = (list, w) => { for (const id of list ?? []) if (!ids.has(id)) err(w, `unknown action ${id}`); };
      const factNames = (o, w) => { for (const f of Object.keys(o ?? {})) if (!T_FACT.test(f) || f.startsWith("blender.")) err(w, `bad fact name ${f}`); };
      scenarios = ev.scenarios?.length ?? 0;
      sequences = ev.sequences?.length ?? 0;
      (ev.scenarios ?? []).forEach((s, i) => {
        const w = `tuning eval.scenarios[${i}] ${s?.name}`;
        if (!isStr(s?.name) || !isObj(s.facts)) err(w, "needs name and facts{}");
        factNames(s?.facts, w);
        for (const k of ["expect_applied", "expect_suggested", "expect_unchanged"]) known(s?.[k], `${w}.${k}`);
      });
      (ev.sequences ?? []).forEach((q, i) => {
        const w = `tuning eval.sequences[${i}] ${q?.id}`;
        if (!isStr(q?.id) || !isObj(q.base_settings) || !Array.isArray(q.rounds) || !q.rounds.length) err(w, "needs id, base_settings{} and rounds[]");
        (q?.rounds ?? []).forEach((rd, j) => { factNames(rd?.facts, `${w}.rounds[${j}]`); known(rd?.expect?.exhausted_ids, `${w}.rounds[${j}]`); });
      });
      if (!Array.isArray(ev.scenarios) || !Array.isArray(ev.sequences)) err("tuning eval.json", "needs scenarios[] and sequences[]");
    } catch (e) {
      err("tuning eval.json", `unreadable (${e.message}); run npm run kb:build`);
    }
  }
  return { actions: actions.length, no_action: noAction.length, tuning_facts: tFacts.length, tuning_scenarios: scenarios, tuning_sequences: sequences };
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
