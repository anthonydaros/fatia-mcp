import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getKb } from "../dist/knowledge/loader.js";
import { consultKnowledge } from "../dist/knowledge/tools.js";
import { LOW_RELEVANCE, MIN_RELEVANCE, indexFor, search, tokenize } from "../dist/knowledge/search.js";

const fixture = (name) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`fixtures/knowledge/${name}`, import.meta.url)), "utf8"));
const kb = getKb();
const index = indexFor(kb);
const eval_ = fixture("eval.json");
const extra = fixture("questions.json");

/** Top-N topic ids; a no_match answer returns nothing, so it counts as a miss. */
const topIds = (query, limit = 3, printer) => {
  const found = search(index, query, { limit, printer });
  return found.noMatch ? [] : found.hits.map((h) => h.topic.id);
};

/** hit@1, hit@3 and rule-via-topic of the eval questions, searched for one printer (undefined = none named). */
function evalRates(printer) {
  let hit1 = 0, hit3 = 0, withRules = 0, ruleHits = 0;
  const lost = [];
  for (const q of eval_.questions) {
    const ids = topIds(q.q, 3, printer);
    const ok1 = q.expect_topics.includes(ids[0]);
    const ok3 = q.expect_topics.some((t) => ids.includes(t));
    hit1 += ok1;
    hit3 += ok3;
    if (q.expect_rules.length) {
      withRules++;
      const viaTopic = q.expect_rules.some((r) => ids.includes(kb.ruleById.get(r).topic));
      ruleHits += viaTopic;
      if (!viaTopic) lost.push(`rule-via-topic: ${q.q}\n    wants a rule of ${q.expect_rules.map((r) => kb.ruleById.get(r).topic).join(", ")}\n    got ${ids.join(", ") || "no_match"}`);
    }
    if (!ok3) lost.push(`hit@3: ${q.q}\n    wants ${q.expect_topics.join(", ")}\n    got ${ids.join(", ") || "no_match"}`);
  }
  const n = eval_.questions.length;
  const rates = { hit1: hit1 / n, hit3: hit3 / n, ruleViaTopic: ruleHits / withRules };
  return { rates, report: `printer ${printer ?? "none"}: hit@1 ${rates.hit1.toFixed(3)} hit@3 ${rates.hit3.toFixed(3)} rule-via-topic ${rates.ruleViaTopic.toFixed(3)} over ${n} questions\n${lost.join("\n")}` };
}

// The second pass is the real configuration: BAMBU_MODEL is set, so topics of other printers are down-weighted.
for (const printer of [undefined, "x2d"]) {
  test(`eval questions${printer ? ` for printer ${printer}` : ""}: hit@1, hit@3 and rule-via-topic stay above the floors`, () => {
    const { rates, report } = evalRates(printer);
    assert.ok(rates.hit1 >= 0.88, `hit@1 below 0.88\n${report}`);
    assert.ok(rates.hit3 >= 0.95, `hit@3 below 0.95\n${report}`);
    assert.ok(rates.ruleViaTopic >= 0.95, `rule-via-topic below 0.95\n${report}`);
  });
}

test("free-worded questions, not taken from the symptom lists, mostly land in the top 3", () => {
  const lost = extra.free.filter((q) => !q.expect_topics.some((t) => topIds(q.q).includes(t)));
  const rate = 1 - lost.length / extra.free.length;
  assert.ok(rate >= 0.85, `hit@3 ${rate.toFixed(3)} below 0.85; lost:\n${lost.map((q) => `${q.q} -> ${topIds(q.q).join(", ") || "no_match"}`).join("\n")}`);
});

test("out-of-scope questions give no_match", () => {
  assert.equal(extra.negative.length, 30);
  const answered = extra.negative.filter((q) => !search(index, q).noMatch);
  assert.deepEqual(answered.map((q) => `${q} -> ${search(index, q).hits[0]?.topic.id}`), []);
  assert.equal(search(index, "").noMatch, true);
  assert.equal(search(index, "o a de para").noMatch, true, "only stopwords");
  assert.ok(search(index, "z hop").relevance > MIN_RELEVANCE);
});

test("numbers are not words: they neither count toward the two-word coverage gate nor answer on their own", () => {
  // "10" and "3" used to be the second and third shared word of a baking-tips question.
  assert.equal(search(index, "como emagrecer 10 kg em 3 meses").noMatch, true);
  assert.equal(search(index, "0.4 0.2 0.6 2024").noMatch, true);
  assert.equal(search(index, "pla 0.2 0.4 0.6").noMatch, true, "one word and three numbers: the numbers do not make a second word");
  assert.equal(search(index, "z hop 0.4").noMatch, false, "words with a number still answer");
  assert.equal(search(index, "nozzle 0.4").noMatch, false);
});

test("a query of any length is tokenized and searched without overflowing the stack", () => {
  const long = Array(300000).fill("a").join(".");
  assert.doesNotThrow(() => tokenize(long));
  assert.doesNotThrow(() => search(index, long));
});

test("the four reference questions put the right topic first", () => {
  assert.equal(topIds("o bico arrasta na peça e derruba")[0], "bambu.travel.unprotected-travel-bug");
  assert.equal(topIds("z hop")[0], "bambu.travel.zhop-types");
  assert.equal(topIds("z_hop_types")[0], "bambu.travel.zhop-types", "a setting key finds its topic");
  assert.equal(topIds("minha peça está empenando no canto")[0], "bambu.materials.pla");
});

test("accents, case, decimal commas and light stemming do not change the match", () => {
  assert.deepEqual(tokenize("Retração"), tokenize("retracao"));
  assert.deepEqual(tokenize("camadas"), tokenize("camada"));
  assert.deepEqual(tokenize("retrações"), tokenize("retração"));
  assert.deepEqual(tokenize("0,4 mm"), tokenize("0.4 mm"));
  assert.deepEqual(tokenize("printing"), tokenize("print"));
  assert.ok(tokenize("z_hop_types").includes("z_hop_types") && tokenize("z_hop_types").includes("hop"), "identifiers stay whole and split");
  assert.ok(tokenize("2.8.4.57").includes("2.8.4.57") && !tokenize("2.8.4.57").includes("2"), "versions stay whole");
  assert.deepEqual(tokenize("o bico de uma peça"), ["bico", "peca"]);
});

test("synonyms only widen the query, and every group can score against the base", () => {
  for (const group of kb.synonyms) {
    assert.ok(group.some((term) => { const t = tokenize(term); return t.length > 0 && t.every((x) => index.df.has(x)); }), `no term of ${JSON.stringify(group)} occurs in the base`);
  }
  // "deformando" is in no topic; its group leads to the warping topics. Without the groups the index finds nothing.
  assert.equal(search({ ...index, groups: [] }, "deformando").hits.length, 0);
  const widened = search(index, "deformando");
  assert.equal(widened.noMatch, false);
  assert.ok(widened.hits.slice(0, 2).some((h) => h.topic.id === "bambu.materials.pla"));
  assert.ok(search(index, "fiapos").hits.length > 0);
});

test("a topic for another printer ranks lower instead of disappearing; domain filters", () => {
  const a1Only = kb.topics.find((t) => t.printers.length === 1 && t.printers[0] === "a1");
  assert.ok(a1Only, "the base has a topic for one printer");
  const query = a1Only.title.replace(/\bA1\b/g, ""); // a query that names the printer is never down-weighted (next test)
  const here = search(index, query, { limit: 8, printer: "a1" }).hits.find((h) => h.topic.id === a1Only.id);
  const elsewhere = search(index, query, { limit: 8, printer: "x2d" }).hits.find((h) => h.topic.id === a1Only.id);
  assert.ok(here, "found for its own printer");
  if (elsewhere) assert.ok(elsewhere.score < here.score, "down-weighted for another printer");
  assert.ok(search(index, "malha manifold", { domain: "blender", limit: 8 }).hits.every((h) => h.topic.domain !== "bambu"));
  assert.ok(search(index, "z hop", { domain: "blender", limit: 8 }).hits.every((h) => h.topic.domain !== "bambu"));
});

test("a printer named in the query is never 'another printer': its topics keep their full score", () => {
  const spoken = (id) => id.replace("-", " "); // "a1-mini" is typed "a1 mini"
  const printers = [...new Set(kb.topics.flatMap((t) => t.printers))];
  assert.ok(printers.length >= 5, printers.join(", "));
  for (const printer of printers) {
    const topic = kb.topics.find((t) => t.printers.includes(printer) && !t.printers.includes("x2d")) ?? kb.topics.find((t) => t.printers.includes(printer));
    const other = printer === "a1" ? "x2d" : "a1"; // the configured printer, which is not the one the query names
    const query = `${topic.title} ${spoken(printer)}`;
    const scoreOf = (options) => search(index, query, { limit: 8, ...options }).hits.find((h) => h.topic.id === topic.id)?.score;
    assert.ok(scoreOf({}) > 0, `${topic.id} found for "${query}"`);
    assert.equal(scoreOf({ printer: other }), scoreOf({}), `${topic.id}: "${spoken(printer)}" is in the query, so printer ${other} must not halve it`);
  }
  // The reported case: with BAMBU_MODEL=x2d an A1 question lost its A1 topic from the top 3.
  assert.ok(topIds("Minha primeira camada não gruda na A1, o que eu verifico primeiro?", 3, "x2d").includes("bambu.a1.first-layer-plate"));
  assert.ok(topIds("Minha peça de 150 mm de altura balança na A1, o que posso fazer?", 3, "x2d").includes("bambu.a1.tall-narrow-parts"));
});

const deps = { defaultModel: "x2d", studioVersion: async () => null };

test("consult_knowledge answers with a numeric relevance and flags a weak answer", async () => {
  const strong = await consultKnowledge({ query: "z hop" }, deps);
  assert.equal(typeof strong.relevance, "number");
  assert.ok(strong.relevance > LOW_RELEVANCE && strong.relevance <= 1);
  assert.equal(strong.low_relevance, false);
  assert.equal(strong.hint, undefined);

  // A real question the base answers only partly: an eval question whose best topic shares few of its words.
  const weak = eval_.questions.map((q) => q.q).find((q) => { const f = search(index, q); return !f.noMatch && f.relevance < LOW_RELEVANCE; });
  assert.ok(weak, "the eval has a partly covered question");
  const found = await consultKnowledge({ query: weak }, deps);
  assert.equal(found.no_match, false);
  assert.equal(found.low_relevance, true);
  assert.ok(found.relevance > 0 && found.relevance < LOW_RELEVANCE);
  assert.match(found.hint, /only touches/);
  assert.ok(!found.hint.includes("\n"), "one line");

  const none = await consultKnowledge({ query: "asdkjh qwlkj zxcmnb" }, deps);
  assert.equal(none.no_match, true);
  assert.equal(none.low_relevance, true);
  assert.equal(typeof none.relevance, "number");

  const byId = await consultKnowledge({ id: "bambu.travel.zhop-types" }, deps);
  assert.deepEqual([byId.relevance, byId.low_relevance], [1, false], "an exact id is fully relevant");
  const missing = await consultKnowledge({ id: "bambu.no.such-thing" }, deps);
  assert.deepEqual([missing.relevance, missing.low_relevance], [0, true]);
});

test("consult_knowledge enforces the schema's 500 character query limit", async () => {
  await assert.rejects(consultKnowledge({ query: "z hop ".repeat(100) }, deps), /500/);
  await assert.rejects(consultKnowledge({ query: Array(100000).fill("a").join(".") }, deps), /500/, "a long single token is refused, not tokenized");
  assert.equal((await consultKnowledge({ query: "z hop".padEnd(500, " ") }, deps)).no_match, false, "500 characters is allowed");
});
