// T-Solve decision server: speaks the System One contract (POST /v1/systemone) used by Jev and
// by our SDK in ./sdk, but answers with a self-hosted model through Ollama.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { answerFor, averageOverOrders, letterDistribution, optionsOf, promptFor } from "./decision.ts";
import type { Question } from "./sdk/index.ts";
import { EMBED_MODEL, kbIndex, searchSources } from "./retrieval.ts";
import { sourceChecks, TSOLVE_QUESTIONS } from "./tsolve-questions.ts";

const STATIC: Record<string, { path: string; type: string }> = {
  "/": { path: "./public/index.html", type: "text/html; charset=utf-8" },
  "/sample/tickets.jsonl": { path: "./data/tickets.jsonl", type: "application/x-ndjson; charset=utf-8" },
};

const PORT = Number(process.env.PORT ?? 8787);
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const LOCAL_MODEL = process.env.LOCAL_MODEL ?? "qwen3:4b";
const TIMEOUT_MS = Number(process.env.QUESTION_TIMEOUT_MS ?? 120_000); // SRS target is 8000 ms; CPU-only demo needs more
const MAX_QUESTIONS = 8;
const PREFILL = "Answer:";
// ask each question twice (options in order, then reversed) and average; ORDER_DEBIAS=0 halves latency
const ORDER_DEBIAS = process.env.ORDER_DEBIAS !== "0";

// The SDK default ("tsolve-decision") and Jev names map to LOCAL_MODEL; anything else is an Ollama model.
const ollamaModel = (requested: unknown) =>
  typeof requested === "string" && requested && requested !== "tsolve-decision" && !requested.startsWith("jev")
    ? requested
    : LOCAL_MODEL;

async function topLogprobs(model: string, system: string, user: string) {
  const call = (body: object) =>
    fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify(body),
    });
  const base = {
    model,
    stream: false,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
      // prefilled reply: reasoning models (qwen3:4b) ignore think:false and start with "First, ...";
      // continuing after "Answer:" makes the next token the option letter for every model tried
      { role: "assistant", content: PREFILL },
    ],
    options: { num_predict: 1, temperature: 0 },
    logprobs: true,
    top_logprobs: 20,
  };
  let res = await call({ ...base, think: false });
  // models without a thinking mode reject the think flag
  if (res.status === 400 && (await res.clone().text()).includes("think")) res = await call(base);
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const out = await res.json();
  const top = out.logprobs?.[0]?.top_logprobs;
  if (!top) throw new Error("Ollama returned no logprobs; upgrade to a version that supports them");
  return { top, inputTokens: out.prompt_eval_count ?? 0, outputTokens: out.eval_count ?? 0 };
}

// The SDK zstd-compresses request bodies of 1 KB or more.
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("body over 1 MB");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  const encoding = req.headers["content-encoding"];
  if (encoding === "zstd") return zstdDecompressSync(raw, { maxOutputLength: 4_000_000 }).toString("utf8");
  if (encoding) throw new Error(`unsupported content-encoding ${encoding}`);
  return raw.toString("utf8");
}

// Returns an error message, or null when the request matches the contract.
function invalid(body: any): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  if (body.state == null) return "state is required";
  if (body.assets) return "assets (images) are not supported";
  const q = body.questions;
  if (!q || typeof q !== "object" || Array.isArray(q)) return "questions must be an object keyed by question name";
  const names = Object.keys(q);
  if (names.length < 1 || names.length > MAX_QUESTIONS) return `send 1-${MAX_QUESTIONS} questions`;
  for (const name of names) {
    try {
      optionsOf(q[name]);
    } catch (e) {
      return `questions.${name}: ${(e as Error).message}`;
    }
  }
  return null;
}

createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET") {
    // demo UI and its helpers; only these fixed files are served
    const file = STATIC[req.url ?? ""];
    if (file) {
      res.writeHead(200, { "Content-Type": file.type });
      return res.end(readFileSync(new URL(file.path, import.meta.url)));
    }
    if (req.url === "/local/questions") return send(200, TSOLVE_QUESTIONS);
    if (req.url === "/local/models") {
      try {
        const tags = await (await fetch(`${OLLAMA_URL}/api/tags`)).json();
        const names: string[] = tags.models.map((m: { name: string }) => m.name);
        return send(200, { default: LOCAL_MODEL, models: names.filter((n) => !n.startsWith(EMBED_MODEL)) });
      } catch {
        return send(200, { default: LOCAL_MODEL, models: [LOCAL_MODEL] });
      }
    }
  }
  if (req.method === "POST" && req.url === "/local/retrieve") {
    // source search for the demo: top-k resolved tickets, plus the ready System One request that
    // asks the AI whether each one applies (same builder the harness uses)
    try {
      const issue = JSON.parse(await readBody(req));
      const t0 = performance.now();
      const sources = await searchSources(`${issue.summary ?? ""}\n${issue.description ?? ""}`, Number(issue.k) || 3, issue.exclude_same_title ? issue.summary : undefined);
      return send(200, { embed_model: EMBED_MODEL, ms: Math.round(performance.now() - t0), sources, requests: sourceChecks(issue, sources) });
    } catch (e) {
      return send(502, { error: (e as Error).message });
    }
  }
  if (req.method !== "POST" || req.url !== "/v1/systemone") return send(404, { error: "POST /v1/systemone only" });
  if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
    return send(422, { error: "send application/json (assets are not supported)" });
  }

  const started = performance.now();
  let body: any;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return send(422, { error: `unreadable body: ${(e as Error).message}` });
  }
  const error = invalid(body);
  if (error) return send(422, { error });

  const model = ollamaModel(body.model);
  const questions = body.questions as Record<string, Question>;
  try {
    // every question reads the same state and runs in parallel
    const results = await Promise.all(
      Object.entries(questions).map(async ([name, q]) => {
        const t0 = performance.now();
        const options = optionsOf(q);
        const orders = ORDER_DEBIAS && options.length > 1 ? [options, [...options].reverse()] : [options];
        const runs = await Promise.all(
          orders.map(async (order) => {
            const prompt = promptFor(body.state, q, order);
            const r = await topLogprobs(model, prompt.system, prompt.user);
            return { order, prompt, r, p: letterDistribution(r.top, order.length) };
          }),
        );
        const p = averageOverOrders(options, runs);
        const trace = {
          options,
          distribution: p,
          ms: Math.round(performance.now() - t0),
          runs: runs.map((run) => ({
            order: run.order.map((o) => o.key),
            prompt: { ...run.prompt, assistant: PREFILL },
            top_logprobs: run.r.top.slice(0, 8),
            distribution: run.p,
          })),
        };
        const r = {
          inputTokens: runs.reduce((s, run) => s + run.r.inputTokens, 0),
          outputTokens: runs.reduce((s, run) => s + run.r.outputTokens, 0),
        };
        return { name, r, trace, answer: answerFor(q, options, p) };
      }),
    );
    const elapsed_ms = Math.round(performance.now() - started);
    console.log(`${model} [${results.map((x) => x.name).join(", ")}] ${elapsed_ms} ms`);
    send(200, {
      model: `tsolve-decision/${model}`,
      answers: Object.fromEntries(results.map((x) => [x.name, x.answer])),
      usage: {
        input_tokens: results.reduce((s, x) => s + x.r.inputTokens, 0),
        output_tokens: results.reduce((s, x) => s + x.r.outputTokens, 0),
      },
      elapsed_ms,
      // opt-in: how each answer was reached (prompt, raw next-token logprobs, option probabilities)
      ...(req.headers["x-tsolve-trace"] === "1" && { trace: Object.fromEntries(results.map((x) => [x.name, x.trace])) }),
    });
  } catch (e) {
    const err = e as Error;
    const timedOut = err.name === "TimeoutError";
    console.error(`${model}: ${err.message}`);
    send(timedOut ? 504 : 502, { error: timedOut ? `model took over ${TIMEOUT_MS} ms` : err.message });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`T-Solve decision server: demo UI http://127.0.0.1:${PORT}/ , API /v1/systemone -> Ollama ${OLLAMA_URL} (${LOCAL_MODEL})`);
  // build the source index in the background so the first search does not wait for it
  kbIndex().then((items) => console.log(`source index ready: ${items.length} tickets (${EMBED_MODEL})`), (e) => console.error(`source index failed: ${e.message}`));
});
