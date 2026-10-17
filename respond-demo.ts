// Tries Qwen as the writer of the suggestion shown for a Simple issue: it rewrites the found
// source's solution as short steps for the reporter. Writes to the data dir (real tickets) and
// prints timing plus a crude grounding check (share of answer words that appear in the source).
//   node respond-demo.ts [--model qwen3:4b-instruct-2507-q4_K_M] [--limit 6]
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, KB_PATH, searchSources } from "./retrieval.ts";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const model = arg("--model") ?? "qwen3:4b-instruct-2507-q4_K_M";
const limit = Number(arg("--limit")) || 6;
const GATE = Number(process.env.SIM_GATE ?? 0.8);
const out = join(DATA_DIR, "responses.jsonl");

const SYSTEM =
  "Bạn là trợ lý IT support của T-Solve. Viết hướng dẫn ngắn bằng tiếng Việt cho người vừa gặp sự cố, " +
  "CHỈ dựa trên ticket đã giải quyết được cung cấp. Tối đa 5 bước, mỗi bước một dòng. " +
  "Nếu ticket nguồn không ghi cách xử lý cụ thể, nói rõ là chưa có hướng dẫn chi tiết và đề nghị liên hệ người phụ trách. " +
  "Không bịa tên hệ thống, đường dẫn hay số liệu không có trong nguồn.";

const words = (s: string) => new Set(s.toLowerCase().normalize("NFC").match(/[\p{L}\p{N}_]{3,}/gu) ?? []);

const queries = readFileSync(KB_PATH, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => r.kind === "query" && r.triage === "simple");
mkdirSync(DATA_DIR, { recursive: true });

let done = 0;
const stats: { ms: number; tokens: number; grounded: number }[] = [];
for (const q of queries) {
  if (done >= limit) break;
  const [best] = await searchSources(q.summary, 1, q.summary);
  if (!best || best.similarity < GATE || !best.excerpt.trim()) continue; // only Simple cases with a written solution
  const user = `Sự cố mới: ${q.summary}\n\nTicket đã giải quyết (${best.id}): ${best.title}\nCách xử lý đã ghi: ${best.excerpt.slice(0, 1200)}\n\nViết hướng dẫn cho người gặp sự cố mới.`;
  const t0 = performance.now();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    body: JSON.stringify({ model, stream: false, think: false, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], options: { temperature: 0.2, num_predict: 300 } }),
  });
  const body = await res.json();
  const ms = Math.round(performance.now() - t0);
  const answer: string = body.message?.content ?? `(error: ${JSON.stringify(body).slice(0, 200)})`;
  const src = words(`${best.title} ${best.excerpt} ${q.summary}`);
  const ans = [...words(answer)];
  const grounded = ans.length ? ans.filter((w) => src.has(w)).length / ans.length : 0;
  stats.push({ ms, tokens: body.eval_count ?? 0, grounded });
  appendFileSync(out, `${JSON.stringify({ query: q.id, source: best.id, similarity: best.similarity, model, ms, answer })}\n`);
  console.log(`${q.id} -> ${best.id} sim ${best.similarity}  ${ms} ms  ${body.eval_count ?? "?"} tokens  grounded ${(grounded * 100).toFixed(0)}%`);
  done++;
}
const avg = (k: "ms" | "tokens" | "grounded") => stats.reduce((s, x) => s + x[k], 0) / (stats.length || 1);
console.log(`\n${model}: ${stats.length} answers, avg ${Math.round(avg("ms"))} ms, ${Math.round(avg("tokens"))} tokens, ${((avg("tokens") / avg("ms")) * 1000).toFixed(1)} tokens/s, grounded words ${(avg("grounded") * 100).toFixed(0)}% (answers in ${out})`);
