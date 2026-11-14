// Ingest helpers (docs/SDD.md, "Ingest"): listing a source, fetching one doc,
// and storing its chunks in D1 (only changed chunks get embedded_at = NULL,
// so only they are re-embedded). The Keeper runs these in small alarm steps.
//
// "Your own content only": GitHub fetches go only to api.github.com for the
// configured repo; sitemap fetches only to the source's listed hosts, after
// each host serves SITE_PROOF at /.well-known/perchlight-ask.txt; every URL
// passes the SSRF rules (src/lib/outbound.js), hop by hop.
import { safeFetch, decode, FetchError, allowedUrl } from "./outbound.js";
import { htmlToText, decodeEntities } from "./html.js";
import { chunkMarkdown, chunkIds, titleOf } from "./chunk.js";
import { sha256Hex } from "./crypto.js";
import { tokens } from "./text.js";

export const GITHUB_HOSTS = ["api.github.com"];
export const MAX_GITHUB_FILE = 1024 * 1024;
export const MAX_PAGE = 2 * 1024 * 1024;
export const MAX_SITEMAP = 5 * 1024 * 1024;
export const MAX_TREE = 8 * 1024 * 1024;
export const MAX_URLS = 5000;
export const MAX_SITEMAP_DEPTH = 2;
export const PROOF_PATH = "/.well-known/perchlight-ask.txt";

function ghHeaders(env, accept = "application/vnd.github+json") {
  const h = { Accept: accept, "User-Agent": "perchlight-ask", "X-GitHub-Api-Version": "2022-11-28" };
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

/**
 * GitHub: one recursive tree call. Returns every matching file with its blob sha.
 * @returns {Promise<{ files: { path: string, etag: string }[], truncated: boolean }>}
 */
export async function listGithub(env, src, budget, ownHost) {
  const url = `https://api.github.com/repos/${enc(src.repo)}/git/trees/${encodeURIComponent(src.branch)}?recursive=1`;
  const r = await safeFetch(url, { hosts: GITHUB_HOSTS, ownHost, headers: ghHeaders(env), maxBytes: MAX_TREE, budget, timeoutMs: 20_000 });
  if (r.status !== 200) throw new FetchError("status", `GitHub tree: HTTP ${r.status}${r.status === 403 || r.status === 429 ? " (rate limited? set GITHUB_TOKEN)" : r.status === 404 ? " (repo, branch or token access wrong)" : ""}`);
  let data;
  try {
    data = JSON.parse(decode(r.bytes));
  } catch {
    throw new FetchError("status", "GitHub tree: not JSON");
  }
  const prefix = src.path ? `${src.path}/` : "";
  const all = (Array.isArray(data.tree) ? data.tree : []).filter((t) => t.type === "blob" && typeof t.path === "string" && t.path.startsWith(prefix) && src.exts.some((e) => t.path.toLowerCase().endsWith(e)) && (t.size ?? 0) <= MAX_GITHUB_FILE);
  const files = all.slice(0, MAX_URLS).map((t) => ({ path: t.path, etag: String(t.sha) }));
  // A capped listing isn't the whole truth either: treated like a truncated tree (nothing deleted).
  return { files, truncated: data.truncated === true || all.length > MAX_URLS };
}

export function githubDocUrl(src, path) {
  if (src.urlBase) {
    const rel = path.slice(src.path ? src.path.length + 1 : 0).replace(/\.(md|mdx|txt)$/i, "").replace(/(^|\/)(index|README)$/i, "");
    return `${src.urlBase}/${enc(rel)}`.replace(/\/+$/, "");
  }
  return `https://github.com/${src.repo}/blob/${enc(src.branch)}/${enc(path)}`;
}

/** One file's raw markdown, by blob sha (the sha is the change check). */
export async function fetchGithubFile(env, src, item, budget, ownHost) {
  const url = `https://api.github.com/repos/${enc(src.repo)}/git/blobs/${encodeURIComponent(item.etag)}`;
  const r = await safeFetch(url, { hosts: GITHUB_HOSTS, ownHost, headers: ghHeaders(env, "application/vnd.github.raw+json"), maxBytes: MAX_GITHUB_FILE, budget });
  if (r.status !== 200) throw new FetchError("status", `GitHub blob ${item.path}: HTTP ${r.status}`);
  const md = decode(r.bytes);
  return { markdown: md, title: titleOf(md, item.path), url: githubDocUrl(src, item.path), etag: item.etag };
}

/** Whether every host of a sitemap source serves SITE_PROOF (open question 2). */
export async function verifyHosts(env, src, budget, ownHost) {
  const proof = String(env.SITE_PROOF ?? "");
  if (proof.length < 16) return { ok: false, error: "SITE_PROOF isn't set (16+ characters)" };
  for (const host of src.hosts) {
    let r;
    try {
      r = await safeFetch(`https://${host}${PROOF_PATH}`, { hosts: [host], ownHost, maxBytes: 4096, budget, maxRedirects: 0 });
    } catch (e) {
      return { ok: false, error: `${host}${PROOF_PATH}: ${e.message}` };
    }
    if (r.status !== 200 || !decode(r.bytes).split(/\s+/).includes(proof)) return { ok: false, error: `${host}${PROOF_PATH} doesn't contain this deployment's SITE_PROOF` };
  }
  return { ok: true };
}

/**
 * One sitemap (or sitemap index) document.
 * @returns {Promise<{ pages: string[], sitemaps: string[], refused: number }>}
 */
export async function fetchSitemap(src, url, budget, ownHost) {
  const r = await safeFetch(url, { hosts: src.hosts, ownHost, headers: { Accept: "application/xml, text/xml" }, maxBytes: MAX_SITEMAP, budget });
  if (r.status !== 200) throw new FetchError("status", `sitemap ${url}: HTTP ${r.status}`);
  const xml = decode(r.bytes);
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]));
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  let refused = 0;
  const ok = [];
  for (const l of locs) {
    try {
      ok.push(allowedUrl(l, { hosts: src.hosts, ownHost }).toString());
    } catch {
      refused++;
    }
  }
  return isIndex ? { pages: [], sitemaps: ok, refused } : { pages: ok, sitemaps: [], refused };
}

/** One HTML page, conditional on its ETag. Returns null when unchanged (304). */
export async function fetchPage(src, item, budget, ownHost) {
  const headers = { Accept: "text/html" };
  if (item.etag) headers["If-None-Match"] = item.etag;
  const r = await safeFetch(item.path, { hosts: src.hosts, ownHost, headers, maxBytes: MAX_PAGE, budget });
  if (r.status === 304) return null;
  if (r.status !== 200) throw new FetchError("status", `HTTP ${r.status}`);
  const ct = r.headers.get("Content-Type") ?? "";
  if (!/^text\/html/i.test(ct)) throw new FetchError("status", `not text/html (${ct.slice(0, 40) || "no Content-Type"})`);
  const { title, text } = await htmlToText(decode(r.bytes));
  return { markdown: text, title: title || titleOf(text, item.path), url: item.path, etag: r.headers.get("ETag") };
}

export async function docId(sourceId, path) {
  return (await sha256Hex(`${sourceId}\n${path}`)).slice(0, 40);
}

const CHUNK_COLS = 7;
const ROWS_PER_INSERT = Math.floor(99 / CHUNK_COLS);

/**
 * The D1 statements that store one doc: changed or new chunks upserted with
 * embedded_at NULL, removed chunks deleted (their ids returned for Vectorize).
 * Unchanged chunks aren't touched (and so aren't re-embedded).
 * @param existing  Map of chunk id -> content_hash currently stored for this doc
 * @returns {Promise<{ stmts: {sql: string, params: any[]}[], removed: string[], changed: number, tokens: number }>}
 */
export async function docStatements({ sourceId, path, doc, existing, now }) {
  const id = await docId(sourceId, path);
  const chunks = await chunkIds(sourceId, path, chunkMarkdown(doc.markdown, { mdx: String(path).toLowerCase().endsWith(".mdx") }));
  const contentHash = (await sha256Hex(doc.markdown)).slice(0, 40);
  const total = chunks.reduce((n, c) => n + c.tokens, 0);
  const stmts = [];
  const fresh = chunks.filter((c) => existing.get(c.id) !== c.contentHash);
  for (let i = 0; i < fresh.length; i += ROWS_PER_INSERT) {
    const part = fresh.slice(i, i + ROWS_PER_INSERT);
    stmts.push({
      sql: `INSERT INTO chunks (id, doc_id, ordinal, heading_path, text, tokens, content_hash) VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")} ON CONFLICT (id) DO UPDATE SET doc_id = excluded.doc_id, ordinal = excluded.ordinal, heading_path = excluded.heading_path, text = excluded.text, tokens = excluded.tokens, content_hash = excluded.content_hash, embedded_at = NULL`,
      params: part.flatMap((c) => [c.id, id, c.ordinal, c.headingPath, c.text, c.tokens, c.contentHash]),
    });
  }
  const keep = new Set(chunks.map((c) => c.id));
  const removed = [...existing.keys()].filter((k) => !keep.has(k));
  for (let i = 0; i < removed.length; i += 99) {
    const part = removed.slice(i, i + 99);
    stmts.push({ sql: `DELETE FROM chunks WHERE id IN (${part.map(() => "?").join(", ")})`, params: part });
  }
  stmts.push({
    sql: "INSERT INTO docs (id, source_id, path, url, title, etag, content_hash, tokens, status, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, NULL) ON CONFLICT (id) DO UPDATE SET url = excluded.url, title = excluded.title, etag = excluded.etag, content_hash = excluded.content_hash, tokens = excluded.tokens, status = 'ok', updated_at = excluded.updated_at, deleted_at = NULL",
    params: [id, sourceId, path, safeUrl(doc.url), String(doc.title ?? "").slice(0, 200), doc.etag ?? null, contentHash, total, now],
  });
  return { id, stmts, removed, changed: fresh.length, tokens: total, contentHash };
}

/** Only http(s) URLs are ever stored as citation links (no javascript: and the like). */
export function safeUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : "";
  } catch {
    return "";
  }
}

export const tokensOf = (md) => tokens(md);
