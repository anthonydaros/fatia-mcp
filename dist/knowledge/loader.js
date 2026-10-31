// Locates, reads, validates and indexes knowledge/ (built by scripts/build-knowledge.mjs). Loaded on first use.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPS } from "./condition.js";
import { parseVersionPredicate } from "./version.js";
export const KB_FILES = ["rules.json", "facts.json", "bambu.topics.json", "blender.topics.json", "synonyms.json"];
/** Facts a rule may name although no provider can supply them yet. Empty: every fact in the shipped KB is declared. */
export const UNSUPPORTED_FACTS = new Set();
const FACT_PREFIXES = /^(settings|printer|project|studio)\./;
/** BAMBU_KB_DIR (development override) or knowledge/ next to dist/. fileURLToPath, never URL.pathname (breaks on C:\). */
export const kbDir = () => path.resolve(process.env.BAMBU_KB_DIR?.trim() || fileURLToPath(new URL("../../knowledge/", import.meta.url)));
/** Text as hashed in the manifest: no BOM, LF line endings, so a Windows checkout or editor does not trip the check. */
const canonical = (text) => text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
function* leaves(c) {
    if ("all" in c || "any" in c)
        for (const x of "all" in c ? c.all : c.any)
            yield* leaves(x);
    else if ("not" in c)
        yield* leaves(c.not);
    else
        yield c;
}
function validate(topics, rules, facts, synonyms) {
    const errors = [];
    const unique = (items, what) => {
        const seen = new Set();
        for (const { id } of items) {
            if (seen.has(id))
                errors.push(`duplicate ${what} id ${id}`);
            seen.add(id);
        }
        return seen;
    };
    const topicIds = unique(topics, "topic");
    unique(rules, "rule");
    const declared = new Set(facts.map(f => f.name));
    const checkApplies = (id, a) => {
        for (const [key, predicate] of Object.entries(a ?? {}))
            if (!parseVersionPredicate(predicate))
                errors.push(`${id}: applies_to.${key} "${predicate}" does not parse`);
    };
    const checkFact = (id, fact) => {
        if (!declared.has(fact) && !FACT_PREFIXES.test(fact) && !UNSUPPORTED_FACTS.has(fact))
            errors.push(`${id}: fact ${fact} is not declared`);
    };
    for (const t of topics)
        checkApplies(t.id, t.applies_to);
    for (const r of rules) {
        if (!topicIds.has(r.topic))
            errors.push(`${r.id}: topic ${r.topic} does not exist`);
        checkApplies(r.id, r.applies_to);
        for (const f of r.detect.facts)
            checkFact(r.id, f);
        if (!r.detect.when)
            continue;
        try {
            for (const leaf of leaves(r.detect.when)) {
                if (!OPS.has(leaf.op))
                    errors.push(`${r.id}: bad op ${leaf.op}`);
                else if (leaf.op === "in" && !Array.isArray(leaf.value))
                    errors.push(`${r.id}: op in needs an array value`);
                checkFact(r.id, leaf.fact);
            }
        }
        catch (error) {
            errors.push(`${r.id}: malformed condition (${error.message})`);
        }
    }
    if (!Array.isArray(synonyms) || !synonyms.every(g => Array.isArray(g) && g.length >= 2 && g.every(s => typeof s === "string"))) {
        errors.push("synonyms.json must be an array of groups of at least two strings");
    }
    return errors;
}
export function loadKbFrom(dir) {
    const read = (name) => {
        try {
            return canonical(fs.readFileSync(path.join(dir, name), "utf8"));
        }
        catch (error) {
            throw new Error(`Knowledge base unavailable: cannot read ${name} in ${dir} (${error.message}). Reinstall the package, or set BAMBU_KB_DIR to a folder built by scripts/build-knowledge.mjs.`);
        }
    };
    const raw = Object.fromEntries(KB_FILES.map(name => [name, read(name)]));
    const parse = (name) => {
        try {
            return JSON.parse(raw[name]);
        }
        catch (error) {
            throw new Error(`Knowledge base unreadable: ${name} in ${dir} is not valid JSON (${error.message}).`);
        }
    };
    const topics = [...parse("bambu.topics.json"), ...parse("blender.topics.json")];
    const rules = parse("rules.json");
    const facts = parse("facts.json");
    const synonyms = parse("synonyms.json");
    let errors;
    try {
        errors = validate(topics, rules, facts, synonyms);
    }
    catch (error) {
        errors = [`malformed entry (${error.message})`];
    }
    if (errors.length)
        throw new Error(`Knowledge base in ${dir} is invalid (${errors.length} problems): ${errors.slice(0, 10).join("; ")}`);
    let integrity = "mismatch";
    let version = "unknown";
    try {
        const manifest = JSON.parse(read("manifest.json"));
        version = String(manifest.kb_version);
        if (KB_FILES.every(name => manifest.files?.[name] === sha256(raw[name])))
            integrity = "ok";
    }
    catch {
        // An unreadable manifest leaves integrity at "mismatch"; the content itself already validated.
    }
    const rulesByTopic = new Map();
    for (const r of rules)
        rulesByTopic.set(r.topic, [...(rulesByTopic.get(r.topic) ?? []), r]);
    return {
        dir, version, integrity, topics, rules, facts, synonyms,
        topicById: new Map(topics.map(t => [t.id, t])),
        ruleById: new Map(rules.map(r => [r.id, r])),
        rulesByTopic,
    };
}
let cached;
/** Late and cached; a failure is not cached, so fixing the folder works without restarting the server. */
export function getKb() {
    const dir = kbDir();
    if (cached?.dir !== dir)
        cached = loadKbFrom(dir);
    return cached;
}
/** Applying a rule's fix without asking is allowed only for a definite setting value backed by a strong source. */
export const approvalFor = (r) => r.auto_apply && r.solution.settings && Object.keys(r.solution.settings).length > 0
    && (r.confidence === "preset" || r.confidence === "oficial") && r.stage !== "blender-prep"
    ? "auto_apply" : "needs_user_approval";
