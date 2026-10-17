// Source-based triage harness on the team's graded queries (data/private dataset).
//   1. Retrieval: does bge-m3 put a ticket graded 2 ("same problem, fix reusable") in the top k?
//   2. Triage: retrieve top 3, the AI grades each 2/1/0 like the team did, Simple when one is 2;
//      compared with the label derived from the grades (GBR-35).
//   npm run harness:sources -- [--retrieval-only] [--limit 20] [--model qwen3:4b]
import { readFileSync } from "node:fs";
import { KB_PATH, searchSources } from "./retrieval.ts";
import { DecisionClient } from "./sdk/index.ts";
import { sourceChecks } from "./tsolve-questions.ts";

type Query = { id: string; summary: string; triage: "" | "simple" | "complex"; candidates: { ticket_id: string; grade: number | null }[] };

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const retrievalOnly = process.argv.includes("--retrieval-only");
const limit = Number(arg("--limit")) || Infinity;
const model = arg("--model");

const queries: Query[] = readFileSync(KB_PATH, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .filter((r) => r.kind === "query");
const grade = (q: Query, ticket: string) => q.candidates.find((c) => c.ticket_id === ticket)?.grade ?? null;
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");

// ---- 1. retrieval -----------------------------------------------------------
const withFix = queries.filter((q) => q.candidates.some((c) => c.grade === 2));
const hits = { 1: 0, 3: 0, 10: 0 };
const top1 = { simple: [] as number[], complex: [] as number[] };
for (const q of queries) {
  const found = await searchSources(q.summary, 10, q.summary);
  if (q.triage) top1[q.triage].push(found[0]?.similarity ?? 0);
  if (!withFix.includes(q)) continue;
  for (const k of [1, 3, 10] as const) if (found.slice(0, k).some((s) => grade(q, s.id) === 2)) hits[k]++;
}
const avg = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / (xs.length || 1)).toFixed(3);
console.log(`Retrieval (bge-m3) on ${withFix.length} queries that have a ticket graded 2:`);
console.log(`  hit@1 ${pct(hits[1], withFix.length)}  hit@3 ${pct(hits[3], withFix.length)}  hit@10 ${pct(hits[10], withFix.length)}`);
console.log(`  top-1 similarity: simple queries avg ${avg(top1.simple)}, complex queries avg ${avg(top1.complex)} (SRS threshold 0.80)`);
console.log("  note: only ~19 candidates per query were graded; an ungraded hit counts as a miss, so these are lower bounds");
if (retrievalOnly) process.exit(0);

// ---- 2. triage with the AI confirming sources ---------------------------------
const client = new DecisionClient({
  apiKey: process.env.TSOLVE_DECISION_API_KEY ?? "local",
  timeout: Number(process.env.TSOLVE_DECISION_TIMEOUT_MS) || 300_000,
});
const labelled = queries.filter((q) => q.triage).slice(0, limit);
const rows: { q: Query; got: "simple" | "complex"; picked?: string; ms: number }[] = [];
// AI choice vs the team's grade, for every checked source the team graded
const AI_GRADE = { same_problem: 2, same_area: 1, unrelated: 0 } as const;
const pairs: { human: number; ai: number }[] = [];
console.log(`\nTriage on ${labelled.length} labelled queries (AI grades each of the top 3 sources 2/1/0):`);
for (const q of labelled) {
  const started = performance.now();
  const sources = await searchSources(q.summary, 3, q.summary);
  const answers = await Promise.all(
    sourceChecks({ summary: q.summary }, sources).map((req) => client.systemOne({ model, ...req }).then((r) => r.answers.match)),
  );
  const checked = sources.map((s, i) => ({ id: s.id, choice: answers[i].choice, p: answers[i].probabilities.same_problem }));
  for (const c of checked) {
    const human = grade(q, c.id);
    if (human !== null) pairs.push({ human, ai: AI_GRADE[c.choice as keyof typeof AI_GRADE] });
  }
  // the AI's own pick, no tuned threshold: Simple when some source is "same_problem"
  const same = checked.filter((c) => c.choice === "same_problem").sort((a, b) => b.p - a.p);
  const got = same.length ? "simple" : "complex";
  const ms = Math.round(performance.now() - started);
  rows.push({ q, got, picked: same[0]?.id, ms });
  const shown = checked.map((c) => `${c.id}:${AI_GRADE[c.choice as keyof typeof AI_GRADE]}/${grade(q, c.id) ?? "?"}`).join(" ");
  console.log(`${got === q.triage ? "✓" : "✗"} ${q.id} label=${q.triage.padEnd(7)} got=${got.padEnd(7)} [ai/team ${shown}] ${ms} ms  ${q.summary}`);
}

const ok = rows.filter((r) => r.got === r.q.triage).length;
const recall = (label: string) => pct(rows.filter((r) => r.q.triage === label && r.got === label).length, rows.filter((r) => r.q.triage === label).length);
const suggested = rows.filter((r) => r.picked);
const goodSuggestion = suggested.filter((r) => grade(r.q, r.picked!) === 2).length;
const ungradedSuggestion = suggested.filter((r) => grade(r.q, r.picked!) === null).length;
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`\naccuracy ${pct(ok, rows.length)}  recall simple ${recall("simple")}  recall complex ${recall("complex")}`);
console.log(`suggestions shown ${suggested.length}: graded 2 ${goodSuggestion}, ungraded ${ungradedSuggestion}, graded 0/1 ${suggested.length - goodSuggestion - ungradedSuggestion}`);
const agree = (h: number, a: number) => pairs.filter((p) => p.human === h && p.ai === a).length;
console.log(`AI vs team on ${pairs.length} graded source pairs (rows = team 2/1/0, cols = AI 2/1/0):`);
for (const h of [2, 1, 0]) console.log(`  team ${h}: ${[2, 1, 0].map((a) => String(agree(h, a)).padStart(4)).join(" ")}`);
console.log(`latency p50 ${ms[Math.floor(ms.length / 2)]} ms  p95 ${ms[Math.min(ms.length - 1, Math.ceil(0.95 * ms.length) - 1)]} ms`);
