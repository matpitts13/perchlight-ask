// POST /v1/session, POST /v1/ask, POST /v1/feedback (docs/SDD.md, "Answering", "Abuse").
import { json, fail, readJson, utcDay, secondsToMidnight, errText } from "../lib/http.js";
import { sha256Hex, randomToken } from "../lib/crypto.js";
import { normalizeQuestion, redact, clean, tokens, snippet } from "../lib/text.js";
import { originAllowed, verifyTurnstile, issueSession, checkSession, checkApiKey, ipHash, minuteOk, countDaily } from "../lib/guard.js";
import { retrieve, isWeak, pages } from "../lib/retrieve.js";
import { answerMessages, messagesTokens, checkOutput, IDK, NO_CITE_NOTE, SEARCH_NOTE } from "../lib/answer.js";
import { generate, AIError } from "../lib/ai.js";
import { genNeurons, embedNeurons } from "../lib/ledger.js";
import { MODELS, EMBED_MODELS } from "../lib/config.js";
import { keeperStub, clock } from "../lib/appctx.js";

export const MAX_BODY = 2048;
const SYSTEM_TOKENS = 400;

// Outcome counters for /api/footprint, kept in isolate memory and added to
// the next request's daily upsert (as perchlight-keys does), so a question
// writes the daily row once.
const pending = { answered: 0, cached: 0, search: 0, idk: 0, not_logged: 0, refused: 0, d1_rows_written: 0 };
export function resetPending() {
  for (const k of Object.keys(pending)) pending[k] = 0;
}
function takePending() {
  const p = { ...pending };
  resetPending();
  return p;
}

const secretOk = (s) => typeof s === "string" && s.length >= 16;

export function corsHeaders(env, origin) {
  if (!originAllowed(env, origin)) return {};
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Headers": "Content-Type, X-Session, X-Api-Key", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Max-Age": "600" };
}

const withCors = (res, cors) => {
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
};

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") ?? "0.0.0.0";
}

export async function handleSession(request, app) {
  const { env, cfg } = app;
  const origin = request.headers.get("Origin");
  const cors = corsHeaders(env, origin);
  if (!originAllowed(env, origin)) return fail(403, "origin", "This site isn't allowed to use this widget.");
  if (!secretOk(env.SESSION_SECRET) || !secretOk(env.IP_SALT) || !env.TURNSTILE_SECRET) return withCors(fail(503, "not_configured", "The widget isn't set up yet (SESSION_SECRET, IP_SALT and TURNSTILE_SECRET)."), cors);
  const now = clock.now();
  const ip = await ipHash(env, clientIp(request), now);
  if (!minuteOk(`ip:${ip}`, now, cfg.limits.perIpPerMinute)) return withCors(fail(429, "rate_limited", "Too many questions; try again later.", { "Retry-After": "60" }), cors);
  const body = await readJson(request, MAX_BODY);
  if (!body.ok) return withCors(fail(body.tooLarge ? 413 : 400, "bad_request", "Send JSON {turnstile}."), cors);
  const v = await verifyTurnstile(env, body.value.turnstile, clientIp(request));
  if (v === "unavailable") return withCors(fail(503, "turnstile_unavailable", "Search is temporarily unavailable."), cors);
  if (v !== "ok") return withCors(fail(403, "turnstile", "The bot check didn't pass."), cors);
  const s = await issueSession(env, now, cfg.limits.sessionMinutes);
  return withCors(json({ session: s.session, exp: s.exp }), cors);
}

/** Who's asking: { kind: "session", sid } | { kind: "key", name, daily } | a Response. */
async function caller(request, app, cors) {
  const { env } = app;
  const key = request.headers.get("X-Api-Key");
  if (key) {
    const k = await checkApiKey(env, key);
    return k ? { kind: "key", ...k } : withCors(fail(401, "unauthorized", "That API key isn't valid."), cors);
  }
  const origin = request.headers.get("Origin");
  if (!originAllowed(env, origin)) return fail(403, "origin", "This site isn't allowed to use this widget.");
  if (!secretOk(env.SESSION_SECRET) || !secretOk(env.IP_SALT)) return withCors(fail(503, "not_configured", "The widget isn't set up yet."), cors);
  const sid = await checkSession(env, request.headers.get("X-Session"), clock.now());
  return sid ? { kind: "session", sid } : withCors(fail(401, "session", "Your session expired; please pass the bot check again."), cors);
}

export async function handleAsk(request, app, ctx) {
  const { env, cfg } = app;
  const origin = request.headers.get("Origin");
  const cors = corsHeaders(env, origin);
  const now = clock.now();
  const body = await readJson(request, MAX_BODY);
  if (!body.ok) return withCors(fail(body.tooLarge ? 413 : 400, "bad_request", body.tooLarge ? "The request is too large (2 KB at most)." : "Send JSON {question}."), cors);
  const question = clean(typeof body.value.question === "string" ? body.value.question : "").trim();
  if (question.length < 3 || question.length > 500) return withCors(fail(400, "bad_question", "A question is 3 to 500 characters."), cors);
  const who = await caller(request, app, cors);
  if (who instanceof Response) return who;

  // Rate limits: per IP (minute in isolate memory, day in D1) and per session for the widget;
  // the key's own daily cap for apps; the global daily cap for both.
  const day = utcDay(now);
  const items = [];
  if (who.kind === "session") {
    const ip = await ipHash(env, clientIp(request), now);
    if (!minuteOk(`ip:${ip}`, now, cfg.limits.perIpPerMinute)) {
      pending.refused++;
      return withCors(fail(429, "rate_limited", "Too many questions; try again later.", { "Retry-After": "60" }), cors);
    }
    items.push({ key: `ip:${ip}`, limit: cfg.limits.perIpPerDay }, { key: `s:${who.sid}`, limit: cfg.limits.perSession });
  } else items.push({ key: `k:${who.name}`, limit: who.daily });
  const p = takePending();
  const counted = await countDaily(env.DB, day, items);
  const dailyRow = await env.DB.prepare(
    "INSERT INTO daily (day, requests, asks, answered, cached, search, idk, not_logged, refused, d1_rows_written) VALUES (?1, 1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT (day) DO UPDATE SET requests = requests + 1, asks = asks + 1, answered = answered + ?2, cached = cached + ?3, search = search + ?4, idk = idk + ?5, not_logged = not_logged + ?6, refused = refused + ?7, d1_rows_written = d1_rows_written + ?8 RETURNING asks",
  )
    .bind(day, p.answered, p.cached, p.search, p.idk, p.not_logged, p.refused, p.d1_rows_written + counted.rows + 1)
    .first();
  if (counted.over || (dailyRow?.asks ?? 0) > cfg.limits.dailyCap) {
    pending.refused++;
    if (who.kind === "session" && counted.over?.startsWith("s:")) return withCors(fail(401, "session", "This session has used its questions; please pass the bot check again."), cors);
    return withCors(fail(429, "rate_limited", "Too many questions; try again later.", { "Retry-After": String(secondsToMidnight(now)) }), cors);
  }

  const history = body.value.history && typeof body.value.history === "object" ? { question: clean(String(body.value.history.question ?? "")).slice(0, 500), answer: clean(String(body.value.history.answer ?? "")).slice(0, 400) } : null;
  const result = await answerQuestion(env, cfg, question, history, ctx);
  // 128 random bits: an id handed to the browser for feedback must not be guessable.
  const id = `q_${randomToken()}`;
  const optOut = body.value.log === false || request.headers.get("Sec-GPC") === "1" || !cfg.logQuestions;

  // Log (unless opted out) and cache, in one batch.
  const stmts = [];
  if (!optOut) {
    stmts.push(
      env.DB.prepare("INSERT INTO asks (id, at, origin, question, answer, chunk_ids, confidence, mode, neurons, cached) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
        id,
        now,
        who.kind === "key" ? `key:${who.name}` : String(origin ?? "").slice(0, 200),
        redact(question),
        result.response.answer,
        JSON.stringify(result.chunkIds),
        result.response.confidence,
        result.response.mode,
        Math.round(result.neurons * 100) / 100,
        result.response.mode === "cache" ? 1 : 0,
      ),
    );
  } else pending.not_logged++;
  if (result.cacheable && result.cacheKey) {
    stmts.push(
      env.DB.prepare("INSERT INTO answer_cache (key, docs_version, response, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET docs_version = excluded.docs_version, response = excluded.response, expires_at = excluded.expires_at").bind(
        result.cacheKey,
        result.docsVersion,
        JSON.stringify({ ...result.response, chunkIds: result.chunkIds }),
        now + cfg.answer.cacheHours * 3600_000,
      ),
    );
  }
  if (stmts.length) {
    try {
      const res = await env.DB.batch(stmts);
      for (const r of res) pending.d1_rows_written += r.meta?.rows_written ?? 0;
    } catch (err) {
      console.error(`ask: log/cache write failed: ${errText(err)}`);
    }
  }
  const m = result.response.mode;
  if (m === "cache") pending.cached++;
  else if (m === "search") pending.search++;
  if (result.response.confidence === "none") pending.idk++;
  else if (m === "full" || m === "lean") pending.answered++;
  return withCors(json({ ...result.response, id: optOut ? null : id }), cors);
}

/**
 * The answer pipeline: cache, budget, retrieve, "I don't know", generate, check.
 * @returns {Promise<{ response: object, chunkIds: string[], neurons: number, cacheable: boolean, cacheKey?: string, docsVersion?: number }>}
 */
export async function answerQuestion(env, cfg, question, history, ctx) {
  const now = clock.now();
  const rates = MODELS[cfg.model];
  const erates = EMBED_MODELS[cfg.embedModel];
  const qTokens = tokens(question) + (history ? tokens(history.question) + tokens(history.answer) + 20 : 0);
  const est = {
    full: genNeurons(rates, SYSTEM_TOKENS + cfg.retrieval.maxContextTokens + qTokens + 60, cfg.answer.maxTokens) + embedNeurons(erates, tokens(question)),
    lean: genNeurons(rates, SYSTEM_TOKENS + cfg.retrieval.leanContextTokens + qTokens + 60, cfg.answer.leanMaxTokens) + embedNeurons(erates, tokens(question)),
  };
  const keeper = keeperStub(env);
  const cacheKey = history ? null : await sha256Hex(normalizeQuestion(question));

  // The budget reservation and the cache lookup run in parallel (docs/SDD.md, "Budget guard").
  const [resv, cached] = await Promise.all([
    keeper.reserve(est, now).catch((err) => {
      // The ledger is unreachable: never risk the budget; answer from search.
      console.error(`ask: ledger unavailable: ${errText(err)}`);
      return { mode: "search" };
    }),
    env.DB.prepare("SELECT CAST((SELECT v FROM state WHERE k = 'docs_version') AS INTEGER) AS dv, (SELECT response FROM answer_cache WHERE key = ?1 AND expires_at > ?2 AND docs_version = CAST((SELECT v FROM state WHERE k = 'docs_version') AS INTEGER)) AS response")
      .bind(cacheKey ?? "", now)
      .first(),
  ]);
  const docsVersion = cached?.dv ?? 1;
  const release = (n) => {
    if (resv.hold) ctx.waitUntil(keeper.settle(resv.hold, n).catch((err) => console.error(`ask: settle failed: ${errText(err)}`)));
  };
  if (cached?.response) {
    release(0);
    const r = JSON.parse(cached.response);
    const { chunkIds = [], ...rest } = r;
    return { response: { ...rest, mode: "cache" }, chunkIds, neurons: 0, cacheable: false };
  }

  const lean = resv.mode === "lean";
  const useModel = resv.mode === "full" || lean;
  let r;
  try {
    r = await retrieve(env, cfg, question, { useVector: useModel, maxChunks: lean ? cfg.retrieval.leanChunks : cfg.retrieval.maxChunks, maxTokens: lean ? cfg.retrieval.leanContextTokens : cfg.retrieval.maxContextTokens });
  } catch (err) {
    release(0); // never leave a hold to settle at its estimate
    throw err;
  }
  // Only a complete, full-mode retrieval is cached: a degraded one (Vectorize or embeddings down) or a
  // lean answer would otherwise be served to everyone for 24 hours.
  const cacheOk = resv.mode === "full" && r.vectorOk && !r.aiError;
  let spent = r.neurons;
  if (r.aiError) await keeper.aiFailed(r.aiError.quota, now).catch(() => {});

  // Weak retrieval: "I don't know", without a model call.
  if (isWeak(r, cfg)) {
    release(spent);
    return { response: idk(cfg, r.chunks, useModel ? resv.mode : "search"), chunkIds: [], neurons: spent, cacheable: cacheOk, cacheKey, docsVersion };
  }
  if (!useModel || r.aiError?.quota) {
    release(spent);
    return { response: searchResult(r.chunks), chunkIds: r.chunks.map((c) => c.id), neurons: spent, cacheable: false };
  }

  const msgs = answerMessages(cfg, question, r.chunks, history, { lean });
  let g;
  try {
    g = await generate(env, cfg, msgs, lean ? cfg.answer.leanMaxTokens : cfg.answer.maxTokens, messagesTokens(msgs));
  } catch (err) {
    release(spent);
    if (err instanceof AIError) await keeper.aiFailed(err.quota, now).catch(() => {});
    console.error(`ask: generation failed: ${errText(err)}`);
    return { response: searchResult(r.chunks), chunkIds: r.chunks.map((c) => c.id), neurons: spent, cacheable: false };
  }
  spent += g.neurons;
  release(spent);
  const c = checkOutput(g.text, r.chunks.length);
  if (c.idk) return { response: idk(cfg, r.chunks, resv.mode), chunkIds: [], neurons: spent, cacheable: cacheOk, cacheKey, docsVersion };
  // Links: only the cited sources' URLs, from D1 metadata.
  const sources = c.cited.map((n) => source(n, r.chunks[n - 1]));
  const response = { answer: c.answer, sources, confidence: c.confidence, mode: resv.mode };
  if (c.confidence === "low") response.note = NO_CITE_NOTE;
  return { response, chunkIds: r.chunks.map((x) => x.id), neurons: spent, cacheable: cacheOk, cacheKey, docsVersion };
}

function source(n, c, withSnippet = false) {
  const s = { n, title: c.title, url: c.url || null, heading: c.headingPath || null };
  if (withSnippet) s.snippet = snippet(c.text, 200);
  return s;
}

function idk(cfg, chunks, mode) {
  const close = pages(chunks, 3);
  return { answer: cfg.contact ? `${IDK} ${cfg.contact}` : IDK, sources: close.map((c, i) => source(i + 1, c)), confidence: "none", mode };
}

function searchResult(chunks) {
  const top = pages(chunks, 5);
  return { answer: SEARCH_NOTE, sources: top.map((c, i) => source(i + 1, c, true)), confidence: "low", mode: "search" };
}

export async function handleFeedback(request, app) {
  const { env } = app;
  const cors = corsHeaders(env, request.headers.get("Origin"));
  const body = await readJson(request, 512);
  if (!body.ok || typeof body.value.id !== "string" || typeof body.value.helpful !== "boolean" || !/^q_[A-Za-z0-9_-]{22}$/.test(body.value.id)) return withCors(fail(400, "bad_request", "Send JSON {id, helpful}."), cors);
  const who = await caller(request, app, cors);
  if (who instanceof Response) return who;
  // Feedback is rate limited like questions: the minute window and a daily counter.
  const now = clock.now();
  const key = who.kind === "session" ? `ip:${await ipHash(env, clientIp(request), now)}` : `k:${who.name}`;
  if (!minuteOk(key, now, app.cfg.limits.perIpPerMinute)) return withCors(fail(429, "rate_limited", "Too many requests; try again later.", { "Retry-After": "60" }), cors);
  const c = await countDaily(env.DB, utcDay(now), [{ key: `fb:${key}`, limit: app.cfg.limits.perIpPerDay }]);
  if (c.over) return withCors(fail(429, "rate_limited", "Too many requests; try again later.", { "Retry-After": String(secondsToMidnight(now)) }), cors);
  await env.DB.prepare("UPDATE asks SET helpful = ? WHERE id = ? AND helpful IS NULL").bind(body.value.helpful ? 1 : 0, body.value.id).run();
  return withCors(new Response(null, { status: 204 }), cors);
}

export function handlePreflight(request, app) {
  const cors = corsHeaders(app.env, request.headers.get("Origin"));
  return new Response(null, { status: Object.keys(cors).length ? 204 : 403, headers: cors });
}
