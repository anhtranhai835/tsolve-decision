// Mini eval harness: runs the triage question over labelled tickets and reports accuracy,
// calibration (Brier) and latency. Compare models with --model, gate CI with --min-accuracy.
//   npm run harness -- [--model qwen3:1.7b] [--min-accuracy 0.8]
import { readFileSync } from "node:fs";
import { DecisionClient } from "./sdk/index.ts";
import { triage } from "./tsolve-questions.ts";

type Ticket = { id: string; summary: string; description: string; triage: "simple" | "complex" };

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const model = arg("--model");
const minAccuracy = Number(arg("--min-accuracy") ?? 0);

const tickets: Ticket[] = readFileSync(new URL("./data/tickets.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

// slow CPU models need a longer client timeout than the SDK's 10 s default
const client = new DecisionClient({
  apiKey: process.env.TSOLVE_DECISION_API_KEY ?? "local",
  timeout: Number(process.env.TSOLVE_DECISION_TIMEOUT_MS) || 300_000,
});
const rows: { t: Ticket; choice: string; pLabel: number; ms: number }[] = [];
let served = "";

for (const t of tickets) {
  const started = performance.now();
  const r = await client.systemOne({
    model,
    state: { summary: t.summary, description: t.description },
    questions: { triage },
  });
  const ms = Math.round(performance.now() - started);
  served = r.model;
  const a = r.answers.triage;
  const pLabel = a.probabilities[t.triage];
  rows.push({ t, choice: a.choice, pLabel, ms });
  console.log(`${a.choice === t.triage ? "✓" : "✗"} ${t.id} label=${t.triage.padEnd(7)} got=${a.choice.padEnd(7)} p(label)=${pLabel.toFixed(2)} ${ms} ms  ${t.summary}`);
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const recall = (label: string) => {
  const of = rows.filter((r) => r.t.triage === label);
  return of.filter((r) => r.choice === label).length / of.length;
};
const accuracy = rows.filter((r) => r.choice === r.t.triage).length / rows.length;
// binary Brier score: 0 is perfect, 0.25 is a coin flip
const brier = rows.reduce((s, r) => s + (1 - r.pLabel) ** 2, 0) / rows.length;
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
const percentile = (q: number) => ms[Math.min(ms.length - 1, Math.ceil(q * ms.length) - 1)];

console.log(`\nModel ${served} on ${rows.length} tickets`);
console.log(`accuracy ${pct(accuracy)}  recall simple ${pct(recall("simple"))}  recall complex ${pct(recall("complex"))}`);
console.log(`Brier ${brier.toFixed(3)}  latency p50 ${percentile(0.5)} ms  p95 ${percentile(0.95)} ms (budget 8000 ms)`);

if (accuracy < minAccuracy) {
  console.error(`accuracy ${pct(accuracy)} is below --min-accuracy ${pct(minAccuracy)}`);
  process.exit(1);
}
