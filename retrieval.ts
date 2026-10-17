// Finds resolved tickets similar to a new issue with a local embedding model (bge-m3 on Ollama).
// The knowledge base is the "ticket" rows of the team dataset; vectors are cached on disk so the
// 486 tickets are embedded once, not at every start.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type KbTicket = { id: string; title: string; excerpt: string };
export type Source = KbTicket & { similarity: number };

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-m3";
export const KB_PATH = process.env.KB_PATH ?? fileURLToPath(new URL("./data/private/tsolve-labelled-dataset.jsonl", import.meta.url));
const CACHE_PATH = KB_PATH.replace(/\.jsonl$/, "") + `.${EMBED_MODEL}.embeddings.json`;

// What gets embedded for a ticket: its title and the start of its solution.
const ticketText = (t: KbTicket) => `${t.title}\n${t.excerpt}`.slice(0, 1000);

async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embedding ${res.status}: ${await res.text()}`);
  return (await res.json()).embeddings.map(normalize);
}

const normalize = (v: number[]) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

// ponytail: brute-force cosine over every ticket; fine for thousands, use pgvector (planned in Report 2) beyond that
export function topK(query: number[], items: { vector: number[] }[], k: number): { index: number; similarity: number }[] {
  return items
    .map((it, index) => ({ index, similarity: dot(query, it.vector) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

export function loadKb(path = KB_PATH): KbTicket[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === "ticket")
    .map((r) => ({ id: r.id, title: r.summary, excerpt: r.solution_excerpt ?? "" }));
}

let index: Promise<{ ticket: KbTicket; vector: number[] }[]> | undefined;

// Embeds the knowledge base once per process, reusing cached vectors whose text has not changed.
export function kbIndex(): Promise<{ ticket: KbTicket; vector: number[] }[]> {
  index ??= (async () => {
    const kb = loadKb();
    if (!kb.length) {
      console.warn(`no knowledge base at ${KB_PATH}; source search returns nothing`);
      return [];
    }
    const cache: Record<string, { hash: string; vector: number[] }> = existsSync(CACHE_PATH)
      ? JSON.parse(readFileSync(CACHE_PATH, "utf8"))
      : {};
    const hash = (t: KbTicket) => createHash("sha1").update(ticketText(t)).digest("hex");
    const missing = kb.filter((t) => cache[t.id]?.hash !== hash(t));
    for (let i = 0; i < missing.length; i += 32) {
      const batch = missing.slice(i, i + 32);
      const vectors = await embed(batch.map(ticketText));
      batch.forEach((t, j) => (cache[t.id] = { hash: hash(t), vector: vectors[j] }));
      console.log(`embedded ${Math.min(i + 32, missing.length)}/${missing.length} tickets with ${EMBED_MODEL}`);
    }
    if (missing.length) writeFileSync(CACHE_PATH, JSON.stringify(cache));
    return kb.map((ticket) => ({ ticket, vector: cache[ticket.id].vector }));
  })();
  index.catch(() => (index = undefined)); // retry on the next call if Ollama was down
  return index;
}

const sameText = (a: string, b: string) => a.toLowerCase().replace(/\s+/g, " ").trim() === b.toLowerCase().replace(/\s+/g, " ").trim();

// excludeTitle: skip tickets whose title equals it. The team's test queries were copied from
// ticket titles, so without this the search finds the query's own ticket, which a real new
// issue would not have yet.
export async function searchSources(text: string, k = 3, excludeTitle?: string): Promise<Source[]> {
  const all = await kbIndex();
  const items = excludeTitle ? all.filter((it) => !sameText(it.ticket.title, excludeTitle)) : all;
  if (!items.length) return [];
  const [query] = await embed([text]);
  return topK(query, items, k).map(({ index, similarity }) => ({ ...items[index].ticket, similarity: Math.round(similarity * 1e4) / 1e4 }));
}
