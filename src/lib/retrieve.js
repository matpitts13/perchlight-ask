// Hybrid retrieval (docs/SDD.md, "Answering" step 4): Vectorize top 8 plus
// keyword (FTS5) top 8, merged by reciprocal-rank fusion (k = 60), then the
// best chunks that fit the token cap. Vectorize or embeddings failing falls
// back to keywords only; `search` mode never calls Workers AI at all.
import { embed, vectorQuery, AIError } from "./ai.js";
import { terms, ftsQuery, coverage } from "./text.js";
import { errText } from "./http.js";

export const RRF_K = 60;

/** Keyword hits: ids in BM25 order. Every term is quoted, so the user can't write FTS syntax. */
export async function keywordSearch(db, ts, limit) {
  if (!ts.length) return [];
  const r = await db
    .prepare("SELECT c.id FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid JOIN docs d ON d.id = c.doc_id WHERE chunks_fts MATCH ?1 AND d.deleted_at IS NULL ORDER BY bm25(chunks_fts) LIMIT ?2")
    .bind(ftsQuery(ts), limit)
    .all();
  return r.results.map((x) => x.id);
}

export function rrf(lists, k = RRF_K) {
  const score = new Map();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * @param {{ useVector: boolean, maxChunks: number, maxTokens: number }} opts
 * @returns {Promise<{ chunks: object[], bestScore: number, kwDecent: boolean, vectorOk: boolean, neurons: number, aiError?: Error }>}
 */
export async function retrieve(env, cfg, query, { useVector, maxChunks, maxTokens }) {
  const ts = terms(query);
  const topK = cfg.retrieval.topK;
  let vec = [];
  let vectorOk = false;
  let neurons = 0;
  let aiError;
  const vectorPart = async () => {
    if (!useVector || !env.VECTORIZE || !env.AI) return;
    try {
      const e = await embed(env, cfg, [query.slice(0, 2000)]);
      neurons += e.neurons;
      vec = await vectorQuery(env, e.vectors[0], topK);
      vectorOk = true;
    } catch (err) {
      if (err instanceof AIError) aiError = err;
      console.error(`retrieve: vector search unavailable: ${errText(err)}`);
    }
  };
  const [, kw] = await Promise.all([vectorPart(), keywordSearch(env.DB, ts, topK)]);
  const order = rrf([vec.map((v) => v.id), kw]).slice(0, topK * 2);
  if (!order.length) return { chunks: [], bestScore: 0, kwDecent: false, vectorOk, neurons, aiError };
  const rows = (
    await env.DB.prepare(
      `SELECT c.id, c.doc_id, c.heading_path, c.text, c.tokens, d.title, d.url FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE d.deleted_at IS NULL AND c.id IN (${order.map((_, i) => `?${i + 1}`).join(",")})`,
    )
      .bind(...order)
      .all()
  ).results;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const scoreOf = new Map(vec.map((v) => [v.id, v.score]));
  const kwSet = new Set(kw);
  const bestScore = vec.length ? Math.max(...vec.filter((v) => byId.has(v.id)).map((v) => v.score), 0) : 0;
  const kwDecent = kw.some((id) => byId.has(id) && coverage(ts, `${byId.get(id).heading_path} ${byId.get(id).text}`) >= cfg.retrieval.minKeywordCoverage);
  const chunks = [];
  let used = 0;
  for (const id of order) {
    const r = byId.get(id);
    if (!r || chunks.length >= maxChunks) continue;
    if (used + r.tokens > maxTokens && chunks.length) continue;
    used += r.tokens;
    chunks.push({ id, docId: r.doc_id, title: r.title, url: r.url, headingPath: r.heading_path, text: r.text, tokens: r.tokens, score: scoreOf.get(id) ?? null, keyword: kwSet.has(id) });
  }
  return { chunks, bestScore, kwDecent, vectorOk, neurons, aiError };
}

/** Weak retrieval means "I don't know" without a model call (step 5). */
export function isWeak(r, cfg) {
  return !r.chunks.length || (r.bestScore < cfg.retrieval.minScore && !r.kwDecent);
}

/** Closest pages (one per doc), for "I don't know" and search mode. */
export function pages(chunks, n) {
  const seen = new Set();
  const out = [];
  for (const c of chunks) {
    if (seen.has(c.docId)) continue;
    seen.add(c.docId);
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}
