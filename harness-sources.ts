// Source-based triage harness (UC-38 / GBR-35) on the team's graded queries (TSOLVE_DATA_DIR,
// default data/private).
//
// run     npm run harness:sources -- --model <ollama model> [--split dev|test|all] [--limit N]
//         Finds the top 3 sources of each labelled query, asks the AI to grade each 2/1/0, and
//         appends one line per query to <data dir>/runs/<model>.jsonl. Re-running resumes: queries
//         already recorded with the same question wording are skipped.
// report  npm run harness:sources -- --report [--model <ollama model>]
//         No model calls. Retrieval hit@k, AI vs team grades, and triage for each similarity gate.
//         The gate is chosen on dev (smallest gate whose Simple precision reaches the SRS target,
//         NFR: precision of Simple >= 90%) and scored once on test.
// retrieval  EMBED_MODEL=<ollama embedding> npm run harness:sources -- --retrieval [--rerank | --rerank-scores <file>] [--export <file>]
//         No LLM. Compares the embedding model (and, with --rerank, the cross-encoder sidecar in
//         rerank/server.py) on the same split: similarity only, reranker only, similarity + reranker.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, EMBED_MODEL, KB_PATH, searchSources } from "./retrieval.ts";
import { DecisionClient } from "./sdk/index.ts";
import { sourceChecks, sourceMatch } from "./tsolve-questions.ts";

type Label = "simple" | "complex";
type Query = { id: string; summary: string; triage: "" | Label; candidates: { ticket_id: string; grade: number | null }[] };
type Checked = { ticket: string; sim: number; team: number | null; choice: string; p: Record<string, number> };
type Run = { id: string; label: Label; split: "dev" | "test"; model: string; question: string; sources: Checked[]; ms: number };

const SIMPLE_PRECISION_TARGET = 0.9; // SRS NFR for AI Ticket Triage
const GATES = [0, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85];
const AI_GRADE: Record<string, number> = { same_problem: 2, same_area: 1, unrelated: 0 };

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const model = arg("--model") ?? process.env.LOCAL_MODEL ?? "qwen3:4b";
const split = (arg("--split") ?? "all") as "dev" | "test" | "all";
const limit = Number(arg("--limit")) || Infinity;
const RUNS_DIR = join(DATA_DIR, "runs");
const runFile = join(RUNS_DIR, `${model.replace(/[^\w.-]/g, "_")}.jsonl`);
// runs only count for the current wording of the question
const questionId = createHash("sha1").update(JSON.stringify(sourceMatch)).digest("hex").slice(0, 8);

const queries: Query[] = readFileSync(KB_PATH, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .filter((r) => r.kind === "query");
// fixed split by id, so dev and test never change between runs
const splitOf = (id: string): "dev" | "test" => (createHash("sha1").update(id).digest()[0] % 2 === 0 ? "dev" : "test");
const gradeOf = (q: Query, ticket: string) => q.candidates.find((c) => c.ticket_id === ticket)?.grade ?? null;
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");

const readRuns = (): Run[] =>
  existsSync(runFile)
    ? readFileSync(runFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r: Run) => r.question === questionId)
    : [];

// ---- run ----------------------------------------------------------------------
async function run() {
  mkdirSync(RUNS_DIR, { recursive: true });
  const done = new Set(readRuns().map((r) => r.id));
  const todo = queries.filter((q) => q.triage && (split === "all" || splitOf(q.id) === split) && !done.has(q.id)).slice(0, limit);
  const client = new DecisionClient({
    apiKey: process.env.TSOLVE_DECISION_API_KEY ?? "local",
    timeout: Number(process.env.TSOLVE_DECISION_TIMEOUT_MS) || 300_000,
  });
  console.log(`${model} · question ${questionId} · ${todo.length} queries to run (${done.size} already recorded)`);
  for (const q of todo) {
    const started = performance.now();
    const found = await searchSources(q.summary, 3, q.summary);
    const answers = await Promise.all(
      sourceChecks({ summary: q.summary }, found).map((req) => client.systemOne({ model, ...req }).then((r) => r.answers.match)),
    );
    const sources: Checked[] = found.map((s, i) => ({
      ticket: s.id,
      sim: s.similarity,
      team: gradeOf(q, s.id),
      choice: answers[i].choice,
      p: answers[i].probabilities,
    }));
    const r: Run = { id: q.id, label: q.triage as Label, split: splitOf(q.id), model, question: questionId, sources, ms: Math.round(performance.now() - started) };
    appendFileSync(runFile, `${JSON.stringify(r)}\n`);
    const shown = sources.map((s) => `${AI_GRADE[s.choice]}/${s.team ?? "?"}@${s.sim.toFixed(2)}`).join(" ");
    console.log(`${r.id} ${r.split} label=${r.label.padEnd(7)} [ai/team@sim ${shown}] ${r.ms} ms`);
  }
}

// ---- report -------------------------------------------------------------------
type Metrics = { n: number; acc: number; recallSimple: number; recallComplex: number; precisionSimple: number; shown: number; good: number; bad: number };

// A decision rule over one checked source. GBR-35 reads: similarity >= gate AND the AI confirms
// the source applies with confidence >= aiMin. aiMin "argmax" uses the AI's own pick instead of a
// confidence; aiMin "none" ignores the AI (the similarity-only baseline the AI has to beat).
type Rule = { gate: number; aiMin: number | "argmax" | "none" };
const passes = (s: Checked, rule: Rule) =>
  s.sim >= rule.gate &&
  (rule.aiMin === "none" || (rule.aiMin === "argmax" ? s.choice === "same_problem" : s.p.same_problem >= rule.aiMin));
const ruleName = (r: Rule) => `sim>=${r.gate.toFixed(2)} ${r.aiMin === "none" ? "no AI" : r.aiMin === "argmax" ? "AI picks 2" : `AI P2>=${r.aiMin}`}`;

function score(runs: Run[], rule: Rule): Metrics {
  let ok = 0, ss = 0, sN = 0, cc = 0, cN = 0, predS = 0, predSOk = 0, good = 0, bad = 0;
  for (const r of runs) {
    const hits = r.sources.filter((s) => passes(s, rule)).sort((a, b) => b.sim - a.sim);
    const got: Label = hits.length ? "simple" : "complex";
    if (got === r.label) ok++;
    if (r.label === "simple") { sN++; if (got === "simple") ss++; } else { cN++; if (got === "complex") cc++; }
    if (got === "simple") {
      predS++;
      if (r.label === "simple") predSOk++;
      if (hits[0].team === 2) good++;
      if (hits[0].team === 0) bad++;
    }
  }
  const div = (a: number, b: number) => (b ? a / b : 0);
  return { n: runs.length, acc: div(ok, runs.length), recallSimple: div(ss, sN), recallComplex: div(cc, cN), precisionSimple: div(predSOk, predS), shown: predS, good, bad };
}

const row = (name: string, m: Metrics) =>
  `${name.padEnd(12)} n=${String(m.n).padStart(3)}  acc ${pct(m.acc, 1).padStart(4)}  simple recall ${pct(m.recallSimple, 1).padStart(4)} precision ${pct(m.precisionSimple, 1).padStart(4)}  complex recall ${pct(m.recallComplex, 1).padStart(4)}  suggestions ${m.shown} (team 2: ${m.good}, team 0: ${m.bad})`;

async function report() {
  // retrieval quality (embedding only, no LLM)
  const withFix = queries.filter((q) => q.candidates.some((c) => c.grade === 2));
  const hits = { 1: 0, 3: 0, 10: 0 };
  for (const q of withFix) {
    const found = await searchSources(q.summary, 10, q.summary);
    for (const k of [1, 3, 10] as const) if (found.slice(0, k).some((s) => gradeOf(q, s.id) === 2)) hits[k]++;
  }
  console.log(`Retrieval on ${withFix.length} queries with a ticket graded 2: hit@1 ${pct(hits[1], withFix.length)}  hit@3 ${pct(hits[3], withFix.length)}  hit@10 ${pct(hits[10], withFix.length)}`);

  const runs = readRuns();
  if (!runs.length) return console.log(`no recorded runs for ${model} with question ${questionId}; run without --report first`);
  const dev = runs.filter((r) => r.split === "dev"), test = runs.filter((r) => r.split === "test");
  console.log(`\n${model} · question ${questionId} · recorded ${runs.length} queries (dev ${dev.length}, test ${test.length})`);

  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const r of runs) for (const s of r.sources) if (s.team !== null) m[2 - s.team][2 - AI_GRADE[s.choice]]++;
  console.log("AI vs team grades (rows team 2/1/0, cols AI 2/1/0):");
  m.forEach((r, i) => console.log(`  team ${2 - i}: ${r.map((x) => String(x).padStart(4)).join("")}`));

  // pick on dev: the rule with the best Simple recall among those reaching the SRS precision target
  // (ties: higher accuracy); then score that rule once on test
  const pick = (aiMins: Rule["aiMin"][]) => {
    const rules = GATES.flatMap((gate) => aiMins.map((aiMin) => ({ gate, aiMin })));
    const ok = rules.filter((r) => { const m = score(dev, r); return m.shown > 0 && m.precisionSimple >= SIMPLE_PRECISION_TARGET; });
    const better = (a: Rule, b: Rule) => {
      const ma = score(dev, a), mb = score(dev, b);
      return mb.recallSimple > ma.recallSimple || (mb.recallSimple === ma.recallSimple && mb.acc > ma.acc) ? b : a;
    };
    return ok.length ? { rule: ok.reduce(better), met: true } : { rule: rules.reduce((a, b) => (score(dev, b).precisionSimple > score(dev, a).precisionSimple ? b : a)), met: false };
  };
  console.log("\nDev, AI's own pick, per similarity gate:");
  for (const g of GATES) console.log(row(`gate ${g.toFixed(2)}`, score(dev, { gate: g, aiMin: "argmax" })));
  const variants: [string, Rule["aiMin"][]][] = [
    ["similarity only (no AI)", ["none"]],
    ["similarity + AI pick", ["argmax"]],
    ["similarity + AI confidence (GBR-35)", [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]],
  ];
  console.log(`\nChosen on dev (best Simple recall with Simple precision >= ${SIMPLE_PRECISION_TARGET * 100}%), scored on test:`);
  for (const [name, aiMins] of variants) {
    const { rule, met } = pick(aiMins);
    console.log(`  ${name}: ${ruleName(rule)}${met ? "" : " (target not reached on dev)"}`);
    console.log(`    ${row("dev", score(dev, rule))}`);
    if (test.length) console.log(`    ${row("TEST", score(test, rule))}`);
  }
  const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`latency per query p50 ${ms[Math.floor(ms.length / 2)]} ms  p95 ${ms[Math.min(ms.length - 1, Math.ceil(0.95 * ms.length) - 1)]} ms`);
}

// ---- retrieval: embedding and reranker, no LLM ---------------------------------------
const RERANK_URL = process.env.RERANK_URL ?? "http://127.0.0.1:8790";
const CANDIDATES = 10; // the reranker may reorder the top 10, so it can also fix retrieval misses

type Cand = { ticket: string; sim: number; rr: number | null; team: number | null };
type QRow = { id: string; label: Label; split: "dev" | "test"; cands: Cand[] };

async function rerank(query: string, docs: string[]): Promise<number[]> {
  const res = await fetch(`${RERANK_URL}/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, docs }),
  });
  if (!res.ok) throw new Error(`reranker ${res.status}: ${await res.text()}`);
  return (await res.json()).scores;
}

// Simple when some candidate passes; the suggestion is the passing candidate ranked first.
function scoreRows(rows: QRow[], pick: (r: QRow) => Cand | undefined): Metrics {
  let ok = 0, ss = 0, sN = 0, cc = 0, cN = 0, predS = 0, predSOk = 0, good = 0, bad = 0;
  for (const r of rows) {
    const hit = pick(r);
    const got: Label = hit ? "simple" : "complex";
    if (got === r.label) ok++;
    if (r.label === "simple") { sN++; if (hit) ss++; } else { cN++; if (!hit) cc++; }
    if (hit) { predS++; if (r.label === "simple") predSOk++; if (hit.team === 2) good++; if (hit.team === 0) bad++; }
  }
  const div = (a: number, b: number) => (b ? a / b : 0);
  return { n: rows.length, acc: div(ok, rows.length), recallSimple: div(ss, sN), recallComplex: div(cc, cN), precisionSimple: div(predSOk, predS), shown: predS, good, bad };
}

async function retrievalReport() {
  // --rerank-scores <file>: reranker scores computed offline (rerank/train.py), one JSON line
  // {query, ticket, score}; dev scores there are out-of-fold, so rules picked on dev stay honest
  const scoresFile = arg("--rerank-scores");
  const fileScores = new Map<string, number>();
  if (scoresFile) {
    for (const l of readFileSync(scoresFile, "utf8").split("\n").filter((x) => x.trim())) {
      const s = JSON.parse(l);
      fileScores.set(`${s.query}|${s.ticket}`, s.score);
    }
  }
  const withRerank = process.argv.includes("--rerank") || Boolean(scoresFile);
  const exportFile = arg("--export"); // top-10 candidates per query, for rerank/train.py to score
  const EMBED = EMBED_MODEL;
  const rows: QRow[] = [];
  let rrMs = 0;
  for (const q of queries.filter((x) => x.triage)) {
    const found = await searchSources(q.summary, CANDIDATES, q.summary);
    let rr: (number | null)[] = found.map(() => null);
    if (scoresFile) {
      rr = found.map((s) => fileScores.get(`${q.id}|${s.id}`) ?? null);
      if (rr.some((x) => x === null)) throw new Error(`no reranker score for some candidates of ${q.id}; re-export and re-score`);
    } else if (withRerank) {
      const t0 = performance.now();
      rr = await rerank(q.summary, found.map((s) => `${s.title}\n${s.excerpt.slice(0, 600)}`));
      rrMs += performance.now() - t0;
    }
    rows.push({ id: q.id, label: q.triage as Label, split: splitOf(q.id), cands: found.map((s, i) => ({ ticket: s.id, sim: s.similarity, rr: rr[i], team: gradeOf(q, s.id) })) });
  }
  const dev = rows.filter((r) => r.split === "dev"), test = rows.filter((r) => r.split === "test");
  if (exportFile) {
    writeFileSync(exportFile, rows.map((r) => JSON.stringify({ id: r.id, split: r.split, label: r.label, cands: r.cands.map((c) => ({ ticket: c.ticket, sim: c.sim })) })).join("\n") + "\n");
    console.log(`exported top-${CANDIDATES} candidates of ${rows.length} queries to ${exportFile}`);
  }

  // retrieval quality: is a ticket graded 2 at the top (embedding order, then reranker order)?
  const hitAt = (order: (r: QRow) => Cand[], k: number) => {
    const fix = rows.filter((r) => r.cands.some((c) => c.team === 2) || queries.find((q) => q.id === r.id)!.candidates.some((c) => c.grade === 2));
    return pct(fix.filter((r) => order(r).slice(0, k).some((c) => c.team === 2)).length, fix.length);
  };
  const bySim = (r: QRow) => r.cands;
  const byRr = (r: QRow) => [...r.cands].sort((a, b) => (b.rr ?? 0) - (a.rr ?? 0));
  console.log(`${EMBED}${withRerank ? " + reranker" : ""} on ${rows.length} labelled queries (dev ${dev.length}, test ${test.length})`);
  console.log(`  embedding order: hit@1 ${hitAt(bySim, 1)}  hit@3 ${hitAt(bySim, 3)}  hit@10 ${hitAt(bySim, 10)}`);
  if (withRerank) console.log(`  reranker order:  hit@1 ${hitAt(byRr, 1)}  hit@3 ${hitAt(byRr, 3)}  (reranker ${Math.round(rrMs / rows.length)} ms per query for ${CANDIDATES} docs)`);

  // decision rules, each picked on dev (best Simple recall with precision >= target), scored on test
  const sims = [0, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
  const rrs = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  type R = { name: string; pick: (r: QRow) => Cand | undefined };
  const family: [string, R[]][] = [
    ["similarity only (top 3)", sims.map((g) => ({ name: `sim>=${g}`, pick: (r) => r.cands.slice(0, 3).find((c) => c.sim >= g) }))],
  ];
  if (withRerank) {
    family.push(["reranker only (top 10)", rrs.map((t) => ({ name: `rr>=${t}`, pick: (r) => byRr(r).find((c) => (c.rr ?? 0) >= t) }))]);
    family.push(["similarity + reranker (GBR-35)", sims.flatMap((g) => rrs.map((t) => ({ name: `sim>=${g} & rr>=${t}`, pick: (r: QRow) => byRr(r).find((c) => c.sim >= g && (c.rr ?? 0) >= t) })))]);
  }
  console.log(`\nChosen on dev (best Simple recall with Simple precision >= ${SIMPLE_PRECISION_TARGET * 100}%), scored on test:`);
  for (const [name, rules] of family) {
    const ok = rules.filter((x) => { const m = scoreRows(dev, x.pick); return m.shown > 0 && m.precisionSimple >= SIMPLE_PRECISION_TARGET; });
    const best = (ok.length ? ok : rules).reduce((a, b) => {
      const ma = scoreRows(dev, a.pick), mb = scoreRows(dev, b.pick);
      const key = (m: Metrics) => (ok.length ? [m.recallSimple, m.acc] : [m.precisionSimple, m.recallSimple]);
      const [a1, a2] = key(ma), [b1, b2] = key(mb);
      return b1 > a1 || (b1 === a1 && b2 > a2) ? b : a;
    });
    console.log(`  ${name}: ${best.name}${ok.length ? "" : " (target not reached on dev)"}`);
    console.log(`    ${row("dev", scoreRows(dev, best.pick))}`);
    console.log(`    ${row("TEST", scoreRows(test, best.pick))}`);
  }
}

await (process.argv.includes("--retrieval") ? retrievalReport() : process.argv.includes("--report") ? report() : run());
