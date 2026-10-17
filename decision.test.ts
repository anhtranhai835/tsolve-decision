import assert from "node:assert/strict";
import { test } from "node:test";
import { answerFor, averageOverOrders, letterDistribution, optionsOf } from "./decision.ts";
import { choice, noul, score } from "./sdk/index.ts";

test("letter logprobs become a distribution over the options only", () => {
  const top = [
    { token: "A", logprob: Math.log(0.6) },
    { token: " b", logprob: Math.log(0.2) }, // spaced and lower-case letters still count
    { token: "Answer", logprob: Math.log(0.1) }, // not an option letter
    { token: "C", logprob: Math.log(0.1) }, // out of range for 2 options
  ];
  const p = letterDistribution(top, 2);
  assert.ok(Math.abs(p[0] - 0.75) < 1e-9 && Math.abs(p[1] - 0.25) < 1e-9);
  assert.throws(() => letterDistribution([{ token: "", logprob: 0 }], 2), /option letter/);
});

test("answers follow the System One shapes", () => {
  const c = choice("?", { simple: "a", complex: "b" });
  const a = answerFor(c, optionsOf(c), [0.9, 0.1]) as any;
  assert.equal(a.choice, "simple");
  assert.deepEqual(a.probabilities, { simple: 0.9, complex: 0.1 });

  const n = noul("?");
  assert.deepEqual(answerFor(n, optionsOf(n), [0.3, 0.7]), { type: "noul", noul: 0.3 });

  // score levels are indexed from zero
  const s = score("?", ["low", "mid", "high"]);
  const sa = answerFor(s, optionsOf(s), [0, 0.5, 0.5]) as any;
  assert.equal(sa.score, 1.5);
  assert.deepEqual(sa.legend, { 0: "low", 1: "mid", 2: "high" });
  assert.equal(sa.confidence, 0.3691);
});

test("averaging over reversed order cancels an always-A model", () => {
  const c = choice("?", { simple: "a", complex: "b" });
  const options = optionsOf(c);
  const reversed = [...options].reverse();
  // a model that answers "A" 90% of the time regardless of content
  const p = averageOverOrders(options, [
    { order: options, p: [0.9, 0.1] },
    { order: reversed, p: [0.9, 0.1] },
  ]);
  assert.deepEqual(p, [0.5, 0.5]);
  // a model that means "complex" in both orders keeps that answer
  const q = averageOverOrders(options, [
    { order: options, p: [0.2, 0.8] },
    { order: reversed, p: [0.9, 0.1] },
  ]);
  assert.ok(Math.abs(q[0] - 0.15) < 1e-9 && Math.abs(q[1] - 0.85) < 1e-9);
});

test("contract violations are rejected", () => {
  assert.throws(() => optionsOf({ type: "box" } as any), /box is not supported/);
  assert.throws(() => optionsOf({ type: "score", criteria: ["only one"] } as any), /2-10/);
  assert.throws(() => optionsOf({ type: "noul" } as any), /instructions or a described outcome/);
});
