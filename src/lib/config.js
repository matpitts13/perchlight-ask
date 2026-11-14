// ask.json: checked once per isolate, with defaults (docs/SDD.md). Errors in
// one source mark only that source (config_error); the rest keeps working.
import { checkTarget } from "./ssrf.js";

export const MODELS = {
  // neurons per million tokens (Workers AI pricing, checked 2026-11-12)
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast": { in: 4119, out: 34868 },
  "@cf/meta/llama-3.2-3b-instruct": { in: 4625, out: 30475 },
  "@cf/meta/llama-3.2-1b-instruct": { in: 2457, out: 18252 },
  "@cf/google/gemma-4-26b-a4b-it": { in: 9091, out: 27273 },
};
export const EMBED_MODELS = {
  "@cf/baai/bge-small-en-v1.5": { in: 1841, dims: 384 },
  "@cf/baai/bge-base-en-v1.5": { in: 6058, dims: 768 },
  "@cf/baai/bge-m3": { in: 1075, dims: 1024 },
};

const DEFAULTS = {
  name: "the docs",
  contact: "",
  model: "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
  embedModel: "@cf/baai/bge-small-en-v1.5",
  budget: { hardStop: 9500, inboxReserve: 1500, ingestReserve: 1000, releaseHourUtc: 18, leanBelow: 1000, searchBelow: 100 },
  retrieval: { minScore: 0.55, topK: 8, maxChunks: 5, maxContextTokens: 1500, leanChunks: 3, leanContextTokens: 900, minKeywordCoverage: 0.6 },
  answer: { maxTokens: 300, leanMaxTokens: 180, draftMaxTokens: 450, temperature: 0.2, cacheHours: 24 },
  maxCorpusTokens: 1500000,
  limits: { perIpPerMinute: 10, perIpPerDay: 60, perSession: 20, sessionMinutes: 30, dailyCap: 1000 },
  inbox: { enabled: false, dailyCap: 50, ownAddresses: [], draftsPerRun: 5 },
  retentionDays: 30,
};

const EVERY = { "6h": 6 * 3600_000, "12h": 12 * 3600_000, "1d": 86400_000, "7d": 7 * 86400_000 };
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function checkSource(raw, i) {
  const s = obj(raw);
  const id = String(s.id ?? `source-${i + 1}`);
  const out = { id, kind: s.kind, every: EVERY[s.every ?? "1d"] ? (s.every ?? "1d") : null, everyMs: EVERY[s.every ?? "1d"] ?? EVERY["1d"], paused: s.paused === true, error: null };
  const bad = (e) => ({ ...out, error: e });
  if (!SOURCE_ID.test(id)) return bad("id must be 1-32 lower-case letters, digits or dashes");
  if (!out.every) return bad(`every must be one of ${Object.keys(EVERY).join(", ")}`);
  if (s.kind === "github") {
    const repo = String(s.repo ?? "");
    if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) return bad('repo must be "owner/name"');
    const branch = String(s.branch ?? "main");
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes("..")) return bad("branch isn't a valid branch name");
    const path = String(s.path ?? "").replace(/^\/+|\/+$/g, "");
    if (path.includes("..")) return bad("path mustn't contain ..");
    const exts = Array.isArray(s.extensions) ? s.extensions.map(String) : [".md", ".mdx", ".txt"];
    if (exts.some((e) => ![".md", ".mdx", ".txt"].includes(e))) return bad("extensions can only be .md, .mdx and .txt");
    let urlBase = null;
    if (s.urlBase != null) {
      const t = checkTarget(s.urlBase);
      if (!t.ok) return bad(`urlBase ${t.error}`);
      urlBase = String(s.urlBase).replace(/\/+$/, "");
    }
    return { ...out, repo, branch, path, exts, urlBase, location: `github.com/${repo}/${path}` };
  }
  if (s.kind === "sitemap") {
    const t = checkTarget(s.sitemap);
    if (!t.ok) return bad(`sitemap ${t.error}`);
    const hosts = Array.isArray(s.hosts) ? s.hosts.map((h) => String(h).toLowerCase()) : [];
    if (!hosts.length) return bad("hosts must list the host names this sitemap may point at");
    for (const h of hosts) {
      const c = checkTarget(`https://${h}/`);
      if (!c.ok || c.url.hostname !== h) return bad(`host "${h}" isn't a public host name`);
    }
    if (!hosts.includes(t.url.hostname)) return bad("the sitemap's own host must be in hosts");
    return { ...out, sitemap: t.url.toString(), hosts, location: t.url.toString() };
  }
  return bad('kind must be "github" or "sitemap" (uploads need no source entry)');
}

/** @returns the checked config. */
export function checkConfig(raw) {
  const r = obj(raw);
  const cfg = {
    ...DEFAULTS,
    name: typeof r.name === "string" ? r.name.slice(0, 100) : DEFAULTS.name,
    contact: typeof r.contact === "string" ? r.contact.slice(0, 300) : DEFAULTS.contact,
    model: MODELS[r.model] ? r.model : DEFAULTS.model,
    embedModel: EMBED_MODELS[r.embedModel] ? r.embedModel : DEFAULTS.embedModel,
    budget: { ...DEFAULTS.budget, ...numbers(r.budget) },
    retrieval: { ...DEFAULTS.retrieval, ...numbers(r.retrieval) },
    answer: { ...DEFAULTS.answer, ...numbers(r.answer) },
    maxCorpusTokens: Number.isFinite(r.maxCorpusTokens) ? r.maxCorpusTokens : DEFAULTS.maxCorpusTokens,
    limits: { ...DEFAULTS.limits, ...numbers(r.limits) },
    inbox: { ...DEFAULTS.inbox, ...numbers(r.inbox), enabled: obj(r.inbox).enabled === true, ownAddresses: Array.isArray(obj(r.inbox).ownAddresses) ? obj(r.inbox).ownAddresses.map((a) => String(a).toLowerCase()) : [] },
    retentionDays: Number.isFinite(r.retentionDays) ? r.retentionDays : DEFAULTS.retentionDays,
  };
  // Hard ceilings, whatever ask.json says.
  cfg.budget.hardStop = Math.min(cfg.budget.hardStop, 9500);
  cfg.answer.maxTokens = Math.min(cfg.answer.maxTokens, 600);
  cfg.answer.draftMaxTokens = Math.min(cfg.answer.draftMaxTokens, 800);
  cfg.inbox.draftsPerRun = Math.min(cfg.inbox.draftsPerRun, 5);
  const seen = new Set();
  cfg.sources = (Array.isArray(r.sources) ? r.sources : []).map((s, i) => {
    const c = checkSource(s, i);
    if (seen.has(c.id)) return { ...c, error: "duplicate id" };
    seen.add(c.id);
    return c;
  });
  return cfg;
}

function numbers(v) {
  return Object.fromEntries(Object.entries(obj(v)).filter(([, x]) => typeof x === "number" && Number.isFinite(x) && x >= 0));
}

const cache = new WeakMap();
export function configFor(raw) {
  let c = cache.get(raw);
  if (!c) {
    c = checkConfig(raw);
    cache.set(raw, c);
  }
  return c;
}

/** Environment overrides that the SDD names as settings (vars, not secrets). */
export function effective(cfg, env) {
  const num = (v, d) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  const model = MODELS[env.AI_MODEL] ? env.AI_MODEL : cfg.model;
  const cap = num(env.ASK_NEURON_CAP, cfg.budget.hardStop);
  return {
    ...cfg,
    model,
    budget: { ...cfg.budget, hardStop: Math.max(0, Math.min(cfg.budget.hardStop, cap)) },
    limits: { ...cfg.limits, dailyCap: num(env.ASK_DAILY_CAP, cfg.limits.dailyCap) },
    retentionDays: Math.max(1, num(env.RETENTION_DAYS, cfg.retentionDays)),
    logQuestions: String(env.LOG_QUESTIONS ?? "1") !== "0",
  };
}
