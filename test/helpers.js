// Test helpers: in-memory fakes for Workers AI and Vectorize (the only
// external services faked; D1 and the Durable Object are real, in miniflare),
// a fake network, and request helpers.
import { env, createExecutionContext, waitOnExecutionContext, runInDurableObject } from "cloudflare:test";
import { makeWorker, resetWatchdog } from "../src/app.js";
import { clock, testHooks } from "../src/lib/appctx.js";
import { net } from "../src/lib/net.js";
import { resetMinuteWindows } from "../src/lib/guard.js";
import { resetPending } from "../src/routes/ask.js";
import { TEST_CONFIG } from "./config.js";

export const ORIGIN = "https://ask.test";
export const SITE = "https://docs.example.com";
export const TOKEN = "test-admin-token-0123456789";
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
// Thursday 12 November 2026, 09:00 UTC.
export const NOW = Date.UTC(2026, 10, 12, 9, 0);

export const worker = makeWorker(TEST_CONFIG);
// Nothing in the tests may reach the real network: the default network refuses.
const noNet = async (input) => {
  throw new Error(`unexpected fetch in test: ${typeof input === "string" ? input : input.url}`);
};

export function setNow(ms) {
  clock.now = () => ms;
}

const DIMS = 384;
const STOP = new Set("a an and are as at be by can do does for from how i in is it of on or the to what when where which with you your".split(" "));
const words = (s) => (String(s).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.replace(/(ing|es|s)$/, ""));

/** A bag-of-words embedding: cosine similarity follows word overlap. */
export function fakeVector(text) {
  const v = new Array(DIMS).fill(0);
  for (const w of words(text)) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

/**
 * Fake Workers AI. reply(messages) returns the model's text (or throws).
 * Every call is recorded in .calls.
 */
export function fakeAI({ reply = () => "Install it with the installer [1].", embedError = null } = {}) {
  const ai = {
    calls: [],
    reply,
    embedError,
    async run(model, input) {
      ai.calls.push({ model, input });
      if (model.includes("bge")) {
        if (ai.embedError) throw new Error(ai.embedError);
        return { shape: [input.text.length, DIMS], data: input.text.map(fakeVector) };
      }
      const text = await ai.reply(input.messages, input);
      return { response: text, usage: { prompt_tokens: Math.ceil(JSON.stringify(input.messages).length / 4), completion_tokens: Math.ceil(String(text).length / 4) } };
    },
  };
  ai.generations = () => ai.calls.filter((c) => !c.model.includes("bge"));
  ai.embeddings = () => ai.calls.filter((c) => c.model.includes("bge"));
  return ai;
}

/** Fake Vectorize: exact cosine over an in-memory map. */
export function fakeVectorize() {
  const store = new Map();
  const vz = {
    store,
    calls: [],
    async upsert(vectors) {
      vz.calls.push({ op: "upsert", n: vectors.length });
      for (const v of vectors) store.set(v.id, v.values);
      return { mutationId: "m" };
    },
    async deleteByIds(ids) {
      vz.calls.push({ op: "delete", n: ids.length });
      for (const id of ids) store.delete(id);
      return { mutationId: "m" };
    },
    async query(vec, { topK }) {
      vz.calls.push({ op: "query" });
      const out = [];
      for (const [id, v] of store) out.push({ id, score: v.reduce((s, x, i) => s + x * vec[i], 0) });
      return { matches: out.sort((a, b) => b.score - a.score).slice(0, topK), count: out.length };
    },
  };
  return vz;
}

/**
 * Fake network. routes: url prefix -> { status, body, headers } | "down" | (url, init) => same | Response.
 * Longest prefix wins. Every call is recorded.
 */
export function fakeNet(routes = {}) {
  const calls = [];
  const pick = (url) => Object.keys(routes).filter((k) => url.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  net.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init.headers ?? {});
    calls.push({ url, method: init.method ?? "GET", headers, body: init.body, redirect: init.redirect });
    const k = pick(url);
    let r = k !== undefined ? routes[k] : undefined;
    if (typeof r === "function") r = await r(url, init, calls.length);
    if (r === undefined) throw new Error(`unexpected fetch in test: ${url}`);
    if (r instanceof Response) return r;
    if (r === "down") throw new TypeError("Network connection lost.");
    return new Response(r.status === 204 || r.status === 304 ? null : (r.body ?? ""), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return calls;
}

export function restoreNet() {
  net.fetch = noNet;
}

/** A fake send_email binding that records messages. */
export function fakeEmail({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    binding: {
      async send(message) {
        if (fail) throw new Error("send failed");
        sent.push(message);
      },
    },
  };
}

let fakes = null;
/** Installs fresh AI/Vectorize fakes for both the Worker and the Keeper. */
export function installFakes(opts = {}) {
  const ai = fakeAI(opts);
  const vz = fakeVectorize();
  const mail = fakeEmail(opts.mail);
  fakes = { AI: ai, VECTORIZE: vz, EMAIL: mail.binding, ...(opts.env ?? {}) };
  testHooks.env = fakes;
  return { ai, vz, mail };
}

export function keeper() {
  return env.KEEPER.get(env.KEEPER.idFromName("keeper"));
}

export function runAt(at) {
  return runInDurableObject(keeper(), (inst) => inst.run(at));
}

export function inKeeper(fn) {
  return runInDurableObject(keeper(), fn);
}

/** Runs the Keeper until its ingest run finishes (or n runs), 1 second apart. */
export async function runUntilIdle(at = NOW, n = 40) {
  let t = at;
  let last;
  for (let i = 0; i < n; i++) {
    setNow(t);
    last = await runAt(t);
    const st = await inKeeper((k) => k.load().run);
    if (!st || st.pausedUntil > t) break;
    t += 1000;
  }
  return last;
}

export async function call(path, init = {}, envOverrides = {}) {
  resetWatchdog();
  const ctx = createExecutionContext();
  const e = { ...env, ...(fakes ?? {}), ...envOverrides };
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function api(method, path, body, envOverrides = {}, token = TOKEN) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await call(`/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, envOverrides);
  const t = await res.text();
  let data;
  try {
    data = JSON.parse(t);
  } catch {
    data = t;
  }
  return { status: res.status, data, res };
}

export async function rows(sql, ...params) {
  return (await env.DB.prepare(sql).bind(...params).all()).results;
}

const TABLES = ["sources", "docs", "chunks", "uploads", "ingest_runs", "asks", "answer_cache", "emails", "drafts", "deliveries", "rate", "daily", "budget_days"];
export async function resetAll() {
  restoreNet();
  testHooks.env = null;
  fakes = null;
  resetWatchdog();
  resetMinuteWindows();
  resetPending();
  setNow(NOW);
  await env.DB.batch([...TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)), env.DB.prepare("UPDATE state SET v = '1' WHERE k = 'docs_version'"), env.DB.prepare("DELETE FROM state WHERE k = 'embed_model'")]);
  await inKeeper((k) => {
    for (const t of ["kv", "ledger", "holds", "queue", "todel", "vdel"]) k.sql.exec(`DELETE FROM ${t}`);
    k.hot = null;
  });
}

/** Seeds docs straight into D1 + the fake Vectorize (bypassing ingest). docs: [{ path, title, url, markdown }] */
export async function seedDocs(vz, docs, sourceId = "gh") {
  const { docStatements } = await import("../src/lib/ingest.js");
  for (const d of docs) {
    const st = await docStatements({ sourceId, path: d.path, doc: { markdown: d.markdown, title: d.title, url: d.url, etag: "x" }, existing: new Map(), now: NOW });
    await env.DB.batch(st.stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
  }
  const ch = await rows("SELECT id, heading_path, text FROM chunks WHERE embedded_at IS NULL");
  for (const c of ch) vz.store.set(c.id, fakeVector(`${c.heading_path}\n${c.text}`));
  await env.DB.prepare("UPDATE chunks SET embedded_at = ?").bind(NOW).run();
}

export const DOCS = [
  { path: "docs/install.md", title: "Install", url: "https://docs.example.com/install", markdown: "# Install\n\n## Windows\n\nDownload the Widgetron installer and run setup.exe. The installer adds Widgetron to the Start menu.\n\n## Mac\n\nDrag Widgetron.app into Applications. On first launch, right-click and choose Open." },
  { path: "docs/errors.md", title: "Errors", url: "https://docs.example.com/errors", markdown: "# Errors\n\n## E42\n\nError code E42 means your licence key expired. Renew the licence from your account page, then restart Widgetron.\n\n## E7\n\nE7 means the sync server is unreachable. Check your network connection." },
  { path: "docs/billing.md", title: "Billing", url: "https://docs.example.com/billing", markdown: "# Billing\n\nWidgetron costs 5 dollars a month. You can cancel your subscription any time from the billing page; cancellation takes effect at the end of the period." },
];

/** A widget session (Turnstile faked as passing). */
export async function session(origin = SITE) {
  fakeNet({ "https://challenges.cloudflare.com/": { status: 200, body: JSON.stringify({ success: true, hostname: new URL(origin).hostname }) } });
  const res = await call("/v1/session", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify({ turnstile: "tok" }) });
  restoreNet();
  return (await res.json()).session;
}

export async function ask(question, { sess, origin = SITE, ip = "198.51.100.7", extra = {}, headers = {} } = {}) {
  const res = await call("/v1/ask", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Session": sess, "CF-Connecting-IP": ip, ...headers }, body: JSON.stringify({ question, ...extra }) });
  const t = await res.text();
  let data;
  try {
    data = JSON.parse(t);
  } catch {
    data = t;
  }
  return { status: res.status, data, res };
}
