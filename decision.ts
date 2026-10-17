// Turns a System One question (noul / choice / score) into a one-letter multiple-choice prompt,
// and turns the model's top logprobs for that single letter back into typed answers.
// No text is generated: the answer is read from the probability of each option letter.
import type { Question } from "./sdk/index.ts";

export type Option = { key: string; text: string };
export type TopLogprob = { token: string; logprob: number };

// ponytail: one letter per option caps choice at 26 options; use two-letter labels if needed
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Text, JSON objects and arrays can appear in state, instructions and criteria.
export function contentText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function stateText(state: unknown): string {
  if (Array.isArray(state) && state.every((s) => typeof s === "string")) {
    return state.map((s, i) => `${i + 1}. ${s}`).join("\n");
  }
  return contentText(state);
}

// The options a question offers, in order. Throws a message fit for a 422 response.
export function optionsOf(q: Question): Option[] {
  if (!q || typeof q !== "object") throw new Error("each question must be an object");
  if (q.type === "noul") {
    const c = q.criteria ?? {};
    if (!contentText(q.instructions) && !contentText(c.true) && !contentText(c.false)) {
      throw new Error("noul needs instructions or a described outcome");
    }
    return [
      { key: "true", text: contentText(c.true) || "Yes" },
      { key: "false", text: contentText(c.false) || "No" },
    ];
  }
  if (q.type === "choice") {
    const c = q.criteria;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("choice criteria must map labels to descriptions");
    const opts = Object.entries(c).map(([key, d]) => ({ key, text: contentText(d) ? `${key}: ${contentText(d)}` : key }));
    if (opts.length < 1 || opts.length > LETTERS.length) throw new Error(`choice needs 1-${LETTERS.length} options`);
    return opts;
  }
  if (q.type === "score") {
    // criteria are a list indexed by score from zero, low to high
    if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) {
      throw new Error("score criteria must be a list of 2-10 descriptions, indexed from zero");
    }
    return q.criteria.map((d, i) => ({ key: String(i), text: contentText(d) || `score ${i}` }));
  }
  throw new Error("type must be noul, choice or score (box is not supported)");
}

export function promptFor(state: unknown, q: Question, options: Option[]): { system: string; user: string } {
  const list = options.map((o, i) => `${LETTERS[i]}) ${o.text}`).join("\n");
  const question = contentText(q.instructions) || "Which option fits the state best?";
  return {
    system: "You are a decision model. Read the state, then answer the question with exactly one option letter. Output only the letter.",
    user: `State:\n${stateText(state)}\n\nQuestion: ${question}\n\nOptions:\n${list}\n\nAnswer with one letter.`,
  };
}

// Probability of each option, from the logprobs of the first generated token.
// Only option letters count; letters missing from the top-k get no probability.
export function letterDistribution(top: TopLogprob[], n: number): number[] {
  const best = new Array<number>(n).fill(-Infinity);
  for (const { token, logprob } of top) {
    const t = token.trim().toUpperCase();
    if (t.length !== 1) continue;
    const i = LETTERS.indexOf(t);
    if (i >= 0 && i < n) best[i] = Math.max(best[i], logprob);
  }
  const max = Math.max(...best);
  if (max === -Infinity) throw new Error("the model did not answer with an option letter");
  const w = best.map((l) => Math.exp(l - max));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / sum);
}

// Small models favour a letter position ("always A"). Asking again with the options in reverse
// order and averaging per option cancels that bias. Each run lists the options in the order shown.
export function averageOverOrders(options: Option[], runs: { order: Option[]; p: number[] }[]): number[] {
  return options.map((o) => runs.reduce((s, run) => s + run.p[run.order.indexOf(o)], 0) / runs.length);
}

// 1 when all probability sits on one option, 0 when it is spread evenly.
export function confidence(p: number[]): number {
  if (p.length < 2) return 1;
  const entropy = -p.reduce((s, x) => s + (x > 0 ? x * Math.log(x) : 0), 0);
  return 1 - entropy / Math.log(p.length);
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;

export function answerFor(q: Question, options: Option[], p: number[]) {
  if (q.type === "noul") return { type: "noul", noul: round(p[0]) };
  const probabilities = Object.fromEntries(options.map((o, i) => [o.key, round(p[i])]));
  if (q.type === "choice") {
    const best = p.indexOf(Math.max(...p));
    return { type: "choice", choice: options[best].key, confidence: round(confidence(p)), probabilities };
  }
  const criteria = (q as { criteria: unknown[] }).criteria;
  return {
    type: "score",
    score: round(p.reduce((s, x, i) => s + x * i, 0)),
    confidence: round(confidence(p)),
    legend: Object.fromEntries(criteria.map((d, i) => [String(i), d])),
    probabilities,
  };
}
