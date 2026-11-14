// The Keeper: one Durable Object instance and the only scheduler (no cron
// trigger; docs/SDD.md, "Pieces"). It holds the daily neuron ledger and runs,
// in its alarm: the app's requested actions, the retention purge, inbox
// drafts, owner digests (and approved replies, off by default) and ingest.
//
// Each alarm run (pattern from perchlight-hooks's Scheduler):
// 1. SETS A SAFETY ALARM FIRST, before anything that can fail.
// 2. Works inside a 40-subrequest budget with 5 held back for its own writes.
// 3. Persists its whole state (one row) at the end of EVERY run, so an
//    eviction never loses an ingest run's progress.
// 4. Sets the next alarm to the earliest due thing; a run that failed backs
//    off (30 s doubling to 30 min), so persistent failures never hot-loop.
import { DurableObject } from "cloudflare:workers";
import { configFor, effective, MODELS, EMBED_MODELS } from "./lib/config.js";
import { clock, testHooks } from "./lib/appctx.js";
import { newBudget, spend, fits, ALARM_RESERVE } from "./lib/budget.js";
import { emptyDay, available, questionMode, displayMode, genNeurons, embedNeurons, POOL_NAMES } from "./lib/ledger.js";
import { utcDay, nextMidnight, parseJson, errText } from "./lib/http.js";
import { sha256Hex, sortableId } from "./lib/crypto.js";
import { tokens, looksLikeInjection } from "./lib/text.js";
import { retrieve, isWeak, pages } from "./lib/retrieve.js";
import { embed, generate, AIError } from "./lib/ai.js";
import { draftMessages, messagesTokens, checkOutput, foreignLinks } from "./lib/answer.js";
import { listGithub, fetchGithubFile, verifyHosts, fetchSitemap, fetchPage, docStatements, docId, MAX_URLS, MAX_SITEMAP_DEPTH } from "./lib/ingest.js";
import { FetchError } from "./lib/outbound.js";
import { checkTarget } from "./lib/ssrf.js";
import { net } from "./lib/net.js";
import { sendResend, sendBinding } from "./lib/mail.js";
import { headerSafe } from "./lib/mime.js";
import { titleOf } from "./lib/chunk.js";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const IDLE_MS = 10 * MIN; // the desktop app sets requested_action columns; they run within 10 minutes
export const HOLD_TTL = 10 * MIN;
export const RUN_TEXT_BYTES = 200 * 1024;
export const DIGEST_EVERY = HOUR;
export const RETRY_DELAYS = [MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 12 * HOUR];
export const INGEST_RETRY = [HOUR, 6 * HOUR];
export const DRAFT_RETRY = [5 * MIN, 30 * MIN, 2 * HOUR];
export const PURGE_BATCH = 500;
export const MAX_PURGE_RUNS = 10;
const QUERY_BUDGET = 45; // D1 statements per invocation on Free (assumed to count per statement)

function defaultHot() {
  return { cfgHash: null, run: null, lastRunAt: null, lastError: null, errors: 0, lastPurgeDay: null, purgeRuns: 0, purgeMore: false, lastDigestAt: 0, heartbeatAt: 0, draftsBlockedUntil: 0 };
}

export function keeperClass(rawConfig) {
  return class Keeper extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      Object.defineProperty(this, "env", { get: () => (testHooks.env ? { ...env, ...testHooks.env } : env) });
      this.sql = ctx.storage.sql;
      this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS ledger (day TEXT PRIMARY KEY, data TEXT NOT NULL)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS holds (id TEXT PRIMARY KEY, day TEXT NOT NULL, pool TEXT NOT NULL, amount REAL NOT NULL, at INTEGER NOT NULL)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS queue (path TEXT PRIMARY KEY, etag TEXT)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS todel (path TEXT PRIMARY KEY)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS vdel (id TEXT PRIMARY KEY)");
      this.hot = null;
    }

    get cfg() {
      return effective(configFor(rawConfig), this.env);
    }

    // ---- state -----------------------------------------------------------

    kvGet(k) {
      const r = this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
      return r ? JSON.parse(r.v) : null;
    }

    kvPut(k, v) {
      this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
    }

    load() {
      if (!this.hot) this.hot = { ...defaultHot(), ...(this.kvGet("hot") ?? {}) };
      return this.hot;
    }

    persist() {
      this.kvPut("hot", this.hot);
    }

    /** Tests: forget in-memory state, as an eviction would. */
    evict() {
      this.hot = null;
      return true;
    }

    // ---- the ledger ------------------------------------------------------

    dayState(now) {
      const day = utcDay(now);
      // Holds older than HOLD_TTL are settled at their estimate (a Worker that never reported back).
      for (const h of this.sql.exec("SELECT id, day, pool, amount FROM holds WHERE at < ?", now - HOLD_TTL).toArray()) this.settleRow(h, h.amount);
      const r = this.sql.exec("SELECT data FROM ledger WHERE day = ?", day).toArray()[0];
      const d = r ? { ...emptyDay(day), ...JSON.parse(r.data) } : emptyDay(day);
      d.held = { questions: 0, inbox: 0, ingest: 0 };
      for (const h of this.sql.exec("SELECT pool, SUM(amount) AS n FROM holds WHERE day = ? GROUP BY pool", day).toArray()) d.held[h.pool] = h.n;
      return d;
    }

    saveDay(d) {
      const { held, ...rest } = d;
      this.sql.exec("INSERT INTO ledger (day, data) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET data = excluded.data", d.day, JSON.stringify(rest));
    }

    settleRow(h, actual) {
      this.sql.exec("DELETE FROM holds WHERE id = ?", h.id);
      const r = this.sql.exec("SELECT data FROM ledger WHERE day = ?", h.day).toArray()[0];
      const d = r ? { ...emptyDay(h.day), ...JSON.parse(r.data) } : emptyDay(h.day);
      const n = Math.max(0, Number(actual) || 0);
      d.used += n;
      d[h.pool] = (d[h.pool] ?? 0) + n;
      this.saveDay(d);
    }

    /** Holds `amount` for a pool if it fits; returns the hold id or null. */
    hold(pool, amount, now, opts = {}) {
      const d = this.dayState(now);
      const a = available(d, this.cfg.budget, now, opts);
      if (amount > a[pool] || amount <= 0) return null;
      const id = crypto.randomUUID();
      this.sql.exec("INSERT INTO holds (id, day, pool, amount, at) VALUES (?, ?, ?, ?, ?)", id, d.day, pool, amount, now);
      return id;
    }

    /**
     * RPC from the Worker, one per question: picks the mode (full, lean,
     * search) given what's left and holds that mode's worst-case estimate.
     * @param {{ full: number, lean: number }} est
     */
    async reserve(est, nowArg) {
      const now = nowArg ?? clock.now();
      const d = this.dayState(now);
      const a = available(d, this.cfg.budget, now);
      const mode = questionMode(a.questions, est, this.cfg.budget);
      if (mode === "search") return { mode };
      const amount = est[mode];
      const id = crypto.randomUUID();
      this.sql.exec("INSERT INTO holds (id, day, pool, amount, at) VALUES (?, ?, ?, ?, ?)", id, d.day, "questions", amount, now);
      return { mode, hold: id, amount };
    }

    /** RPC: settles a hold with what the call actually cost. */
    async settle(id, actual) {
      if (!id) return false;
      const h = this.sql.exec("SELECT id, day, pool, amount FROM holds WHERE id = ?", String(id)).toArray()[0];
      if (!h) return false; // already settled at its estimate
      this.settleRow(h, actual);
      return true;
    }

    /**
     * RPC: Workers AI errored. A quota-like error, or a 3rd error in a day,
     * marks the day exhausted: search mode until 00:00 UTC.
     */
    async aiFailed(quota, nowArg) {
      const now = nowArg ?? clock.now();
      const d = this.dayState(now);
      d.errors = (d.errors ?? 0) + 1;
      if (quota || d.errors >= 3) d.exhausted = true;
      this.saveDay(d);
      return d.exhausted;
    }

    /** RPC: today's numbers for /api/budget and /api/footprint. */
    async budget(nowArg) {
      const now = nowArg ?? clock.now();
      const d = this.dayState(now);
      const b = this.cfg.budget;
      const a = available(d, b, now);
      const hist = this.sql.exec("SELECT day, data FROM ledger ORDER BY day DESC LIMIT 30").toArray().map((r) => ({ day: r.day, ...JSON.parse(r.data) }));
      return { day: d.day, used: round(d.used), byPool: Object.fromEntries(POOL_NAMES.map((p) => [p, round(d[p] ?? 0)])), held: d.held, available: mapRound(a), mode: displayMode(d, b, now), exhausted: Boolean(d.exhausted), hardStop: b.hardStop, history: hist };
    }

    /** Tests: set a day's numbers. */
    async setLedger(day, data) {
      this.saveDay({ ...emptyDay(day), ...data });
      return true;
    }

    // ---- alarm bookkeeping -----------------------------------------------

    async setAlarmAt(t) {
      await this.ctx.storage.setAlarm(t);
    }

    /** Re-arms the alarm if it's missing or stuck. Called lazily (throttled) by the Worker. */
    async ensureAlarm(nowArg) {
      const now = nowArg ?? clock.now();
      const cur = await this.ctx.storage.getAlarm();
      if (cur === null || cur < now - MIN) {
        await this.setAlarmAt(now + 1000);
        return { rearmed: true };
      }
      return { rearmed: false, at: cur };
    }

    /** Asks for a run soon (new email, upload, webhook, requested action). */
    async wake(at) {
      const now = clock.now();
      const t = Math.max(Number(at) || now + 1000, now + 500);
      const cur = await this.ctx.storage.getAlarm();
      this.wakeAt = Math.min(this.wakeAt ?? Infinity, t);
      if (cur === null || cur > t + 1000) await this.setAlarmAt(t);
      return true;
    }

    async status() {
      const h = this.load();
      return { nextAlarm: await this.ctx.storage.getAlarm(), lastRunAt: h.lastRunAt, lastError: h.lastError, run: h.run, errors: h.errors };
    }

    async alarm() {
      if (this.env.PAUSE_ALARMS === "1") return; // tests drive runs directly
      await this.run(clock.now());
    }

    // ---- D1 --------------------------------------------------------------

    /** One D1 batch of {sql, params}; counts one subrequest and its statements. Throws on failure. */
    async d1(budget, stmts) {
      if (!stmts.length) return [];
      if (!spend(budget, 1)) throw new BudgetOut();
      budget.queries = (budget.queries ?? 0) + stmts.length;
      const db = this.env.DB;
      return db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)));
    }

    queriesLeft(budget) {
      return QUERY_BUDGET - (budget.queries ?? 0);
    }

    // ---- one run ---------------------------------------------------------

    async run(nowArg) {
      const now = nowArg ?? clock.now();
      const h = this.load();
      this.wakeAt = Infinity;
      await this.setAlarmAt(now + 5 * MIN); // safety first
      const cfg = this.cfg;
      const budget = newBudget();
      const report = { actions: 0, purged: 0, drafted: 0, delivered: 0, ingest: null, error: null };
      let failed = false;
      let next = { at: now + IDLE_MS };
      try {
        const reads = await this.d1(budget, [
          { sql: "SELECT * FROM sources", params: [] },
          { sql: "SELECT id, requested_action, status FROM drafts WHERE requested_action IS NOT NULL LIMIT 20", params: [] },
          { sql: "SELECT COUNT(*) AS n, MIN(next_at) AS at FROM emails WHERE status = 'queued'", params: [] },
          { sql: "SELECT MIN(next_at) AS at FROM deliveries WHERE status IN ('pending', 'retry', 'sending')", params: [] },
          { sql: "SELECT COUNT(*) AS n FROM drafts WHERE notified = 0 AND status = 'new'", params: [] },
        ]);
        let sources = reads[0].results;
        sources = await this.syncSources(cfg, h, sources, now, budget);
        report.actions = await this.actions(cfg, h, sources, reads[1].results, now, budget);
        report.purged = await this.purge(cfg, h, now, budget);
        if (cfg.inbox.enabled && reads[2].results[0].n > 0) report.drafted = await this.draftStep(cfg, h, now, budget);
        report.delivered = await this.deliveries(cfg, h, now, budget, reads[4].results[0].n);
        report.ingest = await this.ingestStep(cfg, h, sources, now, budget);
        next = await this.nextTimes(cfg, h, now, budget);
        await this.heartbeat(h, now, budget);
        h.errors = 0;
      } catch (err) {
        failed = true;
        h.errors = (h.errors ?? 0) + 1;
        h.lastError = { at: now, error: errText(err).slice(0, 300) };
        report.error = h.lastError.error;
        console.error(`keeper run: ${err instanceof Error ? err.stack : String(err)}`);
      } finally {
        h.lastRunAt = now;
        try {
          await this.mirrorBudget(now, budget);
        } catch (err) {
          console.error(`keeper: budget mirror failed: ${errText(err)}`);
        }
        this.persist();
        let at = next.at;
        if (failed) at = now + Math.min(30_000 * 2 ** Math.min(h.errors - 1, 6), 30 * MIN);
        at = Math.min(at, this.wakeAt ?? Infinity);
        at = Math.max(at, now + 1000);
        await this.setAlarmAt(at);
        report.nextAlarm = at;
      }
      return report;
    }

    /** The app's Budget screen reads D1: one row per day, updated every run. */
    async mirrorBudget(now, budget) {
      const d = this.dayState(now);
      const mode = displayMode(d, this.cfg.budget, now);
      await this.d1(budget, [
        {
          sql: "INSERT INTO budget_days (day, used, questions, inbox, ingest, mode, exhausted, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (day) DO UPDATE SET used = excluded.used, questions = excluded.questions, inbox = excluded.inbox, ingest = excluded.ingest, mode = excluded.mode, exhausted = excluded.exhausted, updated_at = excluded.updated_at",
          params: [d.day, round(d.used), round(d.questions), round(d.inbox), round(d.ingest), mode, d.exhausted ? 1 : 0, now],
        },
      ]);
      this.sql.exec("DELETE FROM ledger WHERE day < ?", utcDay(now - 90 * 86400_000));
    }

    /** ask.json sources -> D1 rows (when the config changed). Sources gone from the config are marked removed and purged by an ingest run. */
    async syncSources(cfg, h, rows, now, budget) {
      const hash = await sha256Hex(JSON.stringify(cfg.sources));
      if (hash === h.cfgHash) return rows;
      const stmts = [];
      const ids = new Set(cfg.sources.map((s) => s.id));
      for (const s of cfg.sources) {
        const { error, ...conf } = s;
        stmts.push({
          sql: "INSERT INTO sources (id, kind, config, location, every_ms, next_at, status, paused, last_error) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8) ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, config = excluded.config, location = excluded.location, every_ms = excluded.every_ms, paused = CASE WHEN ?7 = 1 THEN 1 ELSE sources.paused END, status = CASE WHEN ?6 = 'config_error' THEN 'config_error' WHEN sources.status IN ('config_error', 'removed') THEN 'new' ELSE sources.status END, next_at = CASE WHEN sources.config <> excluded.config THEN 0 ELSE sources.next_at END, last_error = CASE WHEN ?6 = 'config_error' THEN ?8 ELSE sources.last_error END",
          params: [s.id, s.kind ?? "unknown", JSON.stringify(conf), s.location ?? "", s.everyMs, error ? "config_error" : s.paused ? "paused" : "new", s.paused ? 1 : 0, error ?? null],
        });
      }
      for (const r of rows) if (r.kind !== "upload" && !ids.has(r.id) && r.status !== "removed") stmts.push({ sql: "UPDATE sources SET status = 'removed', next_at = 0, paused = 0 WHERE id = ?", params: [r.id] });
      stmts.push({ sql: "SELECT * FROM sources", params: [] });
      const res = await this.d1(budget, stmts);
      h.cfgHash = hash;
      return res[res.length - 1].results;
    }

    // ---- requested actions (the app sets columns; the Keeper does the work) --

    async actions(cfg, h, sources, draftRows, now, budget) {
      const stmts = [];
      for (const s of sources) {
        const a = s.requested_action;
        if (!a) continue;
        if (a === "reingest") stmts.push({ sql: "UPDATE sources SET requested_action = NULL, next_at = 0, fail_count = 0, status = CASE WHEN paused = 1 THEN status ELSE 'new' END WHERE id = ?", params: [s.id] });
        else if (a === "pause") {
          stmts.push({ sql: "UPDATE sources SET requested_action = NULL, paused = 1, status = 'paused' WHERE id = ?", params: [s.id] });
          if (h.run?.sourceId === s.id) await this.abortRun(h, "paused", now, budget);
        } else if (a === "resume") stmts.push({ sql: "UPDATE sources SET requested_action = NULL, paused = 0, status = 'new', next_at = 0 WHERE id = ?", params: [s.id] });
        else stmts.push({ sql: "UPDATE sources SET requested_action = NULL WHERE id = ?", params: [s.id] });
        s.requested_action = null;
        if (a === "reingest") s.next_at = 0;
        if (a === "pause") s.paused = 1;
        if (a === "resume") {
          s.paused = 0;
          s.next_at = 0;
        }
      }
      for (const d of draftRows) {
        if (d.requested_action === "discard") {
          // Discarded drafts are deleted at once with their email copy (docs/SDD.md, "Privacy").
          stmts.push({ sql: "DELETE FROM emails WHERE id = (SELECT email_id FROM drafts WHERE id = ?)", params: [d.id] });
          stmts.push({ sql: "DELETE FROM deliveries WHERE draft_id = ? AND status IN ('pending', 'retry')", params: [d.id] });
          stmts.push({ sql: "DELETE FROM drafts WHERE id = ?", params: [d.id] });
        } else if (d.requested_action === "approve" && (d.status === "new" || d.status === "approved")) {
          stmts.push({ sql: "UPDATE drafts SET requested_action = NULL, status = 'approved', decided_at = ? WHERE id = ?", params: [now, d.id] });
          // Sending is built but off by default (open question 1): only with INBOX_SEND=resend,
          // and only for this specific draft the owner approved.
          if (String(this.env.INBOX_SEND ?? "") === "resend" && d.status === "new") {
            stmts.push({ sql: "INSERT INTO deliveries (id, kind, draft_id, channel, status, next_at, subject, created_at) VALUES (?, 'reply', ?, 'resend', 'pending', ?, '', ?)", params: [sortableId("dl_", now), d.id, now, now] });
          }
        } else stmts.push({ sql: "UPDATE drafts SET requested_action = NULL WHERE id = ?", params: [d.id] });
      }
      if (stmts.length) await this.d1(budget, stmts);
      return stmts.length;
    }

    // ---- retention -------------------------------------------------------

    async purge(cfg, h, now, budget) {
      const day = utcDay(now);
      if (h.lastPurgeDay === day && !h.purgeMore) return 0;
      if (h.lastPurgeDay !== day) h.purgeRuns = 0;
      if (!fits(budget, 1, ALARM_RESERVE + 6)) return 0;
      const cut = now - cfg.retentionDays * 86400_000;
      const lim = PURGE_BATCH;
      const del = (table, col, value, key = "id") => ({ sql: `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${col} < ? LIMIT ${lim})`, params: [value] });
      const res = await this.d1(budget, [
        del("asks", "at", cut),
        del("drafts", "created_at", cut),
        del("emails", "received_at", cut),
        del("answer_cache", "expires_at", now, "key"),
        { sql: `DELETE FROM rate WHERE (key, day) IN (SELECT key, day FROM rate WHERE day < ? LIMIT ${lim})`, params: [utcDay(now - 2 * 86400_000)] },
        del("deliveries", "created_at", cut),
        del("ingest_runs", "started_at", now - 90 * 86400_000),
        { sql: "DELETE FROM daily WHERE day < ?", params: [utcDay(now - 90 * 86400_000)] },
      ]);
      const counts = res.map((r) => r.meta?.changes ?? 0);
      h.lastPurgeDay = day;
      h.purgeRuns = (h.purgeRuns ?? 0) + 1;
      h.purgeMore = counts.some((c) => c >= lim) && h.purgeRuns < MAX_PURGE_RUNS;
      return counts.reduce((a, b) => a + b, 0);
    }

    // ---- inbox drafts ----------------------------------------------------

    async draftStep(cfg, h, now, budget) {
      if ((h.draftsBlockedUntil ?? 0) > now) return 0;
      const rows = (await this.d1(budget, [{ sql: "SELECT * FROM emails WHERE status = 'queued' AND next_at <= ? ORDER BY received_at LIMIT ?", params: [now, cfg.inbox.draftsPerRun] }]))[0].results;
      const rates = MODELS[cfg.model];
      const erates = EMBED_MODELS[cfg.embedModel];
      let made = 0;
      for (const email of rows) {
        if (!fits(budget, 7, ALARM_RESERVE) || this.queriesLeft(budget) < 10) break;
        const query = `${email.subject}\n${email.body}`.slice(0, 2000);
        const worst = genNeurons(rates, 450 + tokens(email.subject) + tokens(email.body) + cfg.retrieval.maxContextTokens + 300 + 200, cfg.answer.draftMaxTokens) + embedNeurons(erates, tokens(query));
        const hold = this.hold("inbox", worst, now);
        if (!hold) {
          h.draftsBlockedUntil = nextMidnight(now);
          break;
        }
        let spent = 0;
        try {
          spend(budget, 3); // embed, Vectorize, keyword query (+ rows)
          budget.queries = (budget.queries ?? 0) + 2;
          const r = await retrieve(this.env, cfg, query, { useVector: true, maxChunks: cfg.retrieval.maxChunks, maxTokens: cfg.retrieval.maxContextTokens });
          spent += r.neurons;
          if (r.aiError?.quota) throw r.aiError;
          let prev = null;
          if (email.in_reply_to) {
            const p = await this.d1(budget, [{ sql: "SELECT d.body FROM drafts d JOIN emails e ON e.id = d.email_id WHERE e.message_id = ? AND d.status IN ('approved', 'sent') ORDER BY d.created_at DESC LIMIT 1", params: [email.in_reply_to] }]);
            prev = p[0].results[0]?.body ?? null;
          }
          let body;
          let confidence;
          let cited = [];
          let used = r.chunks;
          if (isWeak(r, cfg)) {
            used = pages(r.chunks, 3);
            body = holdingReply(this.env, used);
            confidence = "none";
          } else {
            const msgs = draftMessages(cfg, email, r.chunks, String(this.env.INBOX_SIGNATURE ?? "").slice(0, 300), prev);
            spend(budget, 1);
            const g = await generate(this.env, cfg, msgs, cfg.answer.draftMaxTokens, messagesTokens(msgs));
            spent += g.neurons;
            const c = checkOutput(g.text, r.chunks.length);
            if (c.idk) {
              used = pages(r.chunks, 3);
              body = holdingReply(this.env, used);
              confidence = "none";
            } else {
              cited = c.cited;
              confidence = c.confidence;
              // Links come from D1 metadata of the cited sources, never from model text.
              const src = cited.map((n) => ({ n, c: r.chunks[n - 1] })).filter((x) => x.c.url);
              body = src.length ? `${c.answer}\n\nSources:\n${src.map((x) => `[${x.n}] ${x.c.title}: ${x.c.url}`).join("\n")}` : c.answer;
              used = r.chunks;
            }
          }
          const sources = (confidence === "none" ? used.map((c, i) => ({ n: i + 1, c })) : cited.map((n) => ({ n, c: r.chunks[n - 1] }))).map(({ n, c }) => ({ n, title: c.title, url: c.url, heading: c.headingPath }));
          const flags = [];
          if (looksLikeInjection(`${email.subject}\n${email.body}`)) flags.push("possible prompt injection in the email");
          if (foreignLinks(body, sources.map((s) => s.url)).length) flags.push("draft contains links that aren't from your docs");
          const subject = /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`;
          const mailto = `mailto:${encodeURIComponent(email.from_addr)}?subject=${encodeURIComponent(headerSafe(subject))}&body=${encodeURIComponent(body.slice(0, 1500))}`;
          await this.d1(budget, [
            {
              sql: "INSERT INTO drafts (id, email_id, created_at, from_addr, subject, body, chunk_ids, sources, confidence, needs_you, flags, mailto, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')",
              params: [sortableId("dr_", now), email.id, now, email.from_addr, email.subject, body, JSON.stringify(used.map((c) => c.id)), JSON.stringify(sources), confidence, confidence === "high" ? 0 : 1, flags.join("; "), mailto],
            },
            { sql: "UPDATE emails SET status = 'drafted', flags = ? WHERE id = ?", params: [flags.join("; "), email.id] },
          ]);
          made++;
        } catch (err) {
          if (err instanceof BudgetOut) {
            await this.settle(hold, spent);
            break;
          }
          if (err instanceof AIError) {
            const exhausted = await this.aiFailed(err.quota, now);
            if (exhausted) {
              h.draftsBlockedUntil = nextMidnight(now);
              await this.settle(hold, spent);
              break;
            }
          }
          const attempts = (email.attempts ?? 0) + 1;
          const delay = DRAFT_RETRY[attempts - 1];
          await this.d1(budget, [{ sql: "UPDATE emails SET attempts = ?, next_at = ?, status = ?, skip_reason = ? WHERE id = ?", params: [attempts, delay ? now + delay : 0, delay ? "queued" : "failed", delay ? null : `drafting failed: ${errText(err).slice(0, 200)}`, email.id] }]).catch(() => {});
        }
        await this.settle(hold, spent);
      }
      return made;
    }

    // ---- owner digests and approved replies --------------------------------

    async deliveries(cfg, h, now, budget, undigested) {
      const env = this.env;
      const provider = String(env.NOTIFY_PROVIDER ?? "") === "resend" ? "resend" : "send_email";
      if (undigested > 0 && now - (h.lastDigestAt ?? 0) >= DIGEST_EVERY && env.FORWARD_TO && env.MAIL_FROM && fits(budget, 2, ALARM_RESERVE)) {
        const r = (await this.d1(budget, [{ sql: "SELECT id, subject FROM drafts WHERE notified = 0 AND status = 'new' ORDER BY created_at LIMIT 20", params: [] }]))[0].results;
        if (r.length) {
          const n = undigested;
          // No customer text beyond subjects (docs/SDD.md, "Owner notification").
          const body = `${n} new draft${n === 1 ? "" : "s"} waiting in Perchlight:\n\n${r.map((x) => `- ${headerSafe(x.subject).slice(0, 120) || "(no subject)"}`).join("\n")}${n > r.length ? `\n- and ${n - r.length} more` : ""}\n\nNothing has been sent to anyone. Open the Drafts screen to review them.`;
          await this.d1(budget, [
            { sql: "INSERT INTO deliveries (id, kind, channel, status, next_at, subject, body, created_at) VALUES (?, 'digest', ?, 'pending', ?, ?, ?, ?)", params: [sortableId("dl_", now), provider, now, `${n} new draft${n === 1 ? "" : "s"} waiting in Perchlight`, body, now] },
            { sql: `UPDATE drafts SET notified = 1 WHERE id IN (${r.map(() => "?").join(",")})`, params: r.map((x) => x.id) },
          ]);
        }
        h.lastDigestAt = now;
      }
      if (!fits(budget, 3, ALARM_RESERVE)) return 0;
      const due = (await this.d1(budget, [{ sql: "SELECT * FROM deliveries WHERE (status IN ('pending', 'retry') AND next_at <= ?1) OR (status = 'sending' AND next_at <= ?2) ORDER BY next_at LIMIT 5", params: [now, now - 10 * MIN] }]))[0].results;
      let sent = 0;
      for (const d of due) {
        if (!fits(budget, 4, ALARM_RESERVE)) break;
        // Claim first: a crash mid-send leaves "sending", retried after 10 minutes (Resend's Idempotency-Key stops a double send).
        const claim = await this.d1(budget, [{ sql: "UPDATE deliveries SET status = 'sending', attempts = attempts + 1, next_at = ? WHERE id = ? AND status = ?", params: [now, d.id, d.status] }]);
        if (!claim[0].meta?.changes) continue;
        const attempts = d.attempts + 1;
        let result;
        let after = [];
        if (d.kind === "reply") {
          const x = (await this.d1(budget, [{ sql: "SELECT d.id, d.body, d.status, e.from_addr, e.subject, e.message_id FROM drafts d JOIN emails e ON e.id = d.email_id WHERE d.id = ?", params: [d.draft_id] }]))[0].results[0];
          if (String(env.INBOX_SEND ?? "") !== "resend") result = { status: "failed", error: "INBOX_SEND is off; nothing was sent" };
          else if (!x || x.status !== "approved") result = { status: "failed", error: "the draft isn't approved any more" };
          else {
            spend(budget, 1);
            const mid = headerSafe(x.message_id);
            result = await sendResend(env, {
              from: env.INBOX_FROM || env.MAIL_FROM,
              to: x.from_addr,
              subject: /^re:/i.test(x.subject) ? x.subject : `Re: ${x.subject}`,
              text: x.body,
              headers: mid ? { "In-Reply-To": mid, References: mid } : {},
              idempotencyKey: d.id,
            });
            if (result.status === "sent") after = [{ sql: "UPDATE drafts SET status = 'sent', send_result = ? WHERE id = ?", params: [`sent via Resend${result.id ? ` (${result.id})` : ""}`, x.id] }];
            else after = [{ sql: "UPDATE drafts SET send_result = ? WHERE id = ?", params: [result.error ?? result.status, x.id] }];
          }
        } else {
          spend(budget, 1);
          const msg = { from: env.MAIL_FROM, to: env.FORWARD_TO, subject: d.subject, text: d.body ?? "", idempotencyKey: d.id };
          result = d.channel === "resend" ? await sendResend(env, msg) : await sendBinding(env, msg);
        }
        const delay = RETRY_DELAYS[attempts - 1];
        const status = result.status === "sent" ? "sent" : result.status === "failed" || !delay ? "failed" : "retry";
        await this.d1(budget, [{ sql: "UPDATE deliveries SET status = ?, next_at = ?, last_error = ?, sent_at = ? WHERE id = ?", params: [status, status === "retry" ? now + delay : 0, result.error ?? null, status === "sent" ? now : null, d.id] }, ...after]);
        if (status === "sent") sent++;
      }
      return sent;
    }

    // ---- ingest ----------------------------------------------------------

    async ingestStep(cfg, h, sources, now, budget) {
      if (!h.run) {
        const due = sources.filter((s) => !s.paused && s.next_at <= now && !["config_error", "running"].includes(s.status)).sort((a, b) => a.next_at - b.next_at)[0];
        if (!due) return null;
        if (!fits(budget, 3, ALARM_RESERVE)) return null;
        const src = due.status === "removed" ? { id: due.id, kind: "removed" } : due.kind === "upload" ? { id: "upload", kind: "upload" } : cfg.sources.find((s) => s.id === due.id);
        if (!src || src.error) return null;
        const runId = sortableId("run_", now);
        const r = await this.d1(budget, [
          { sql: "INSERT INTO ingest_runs (id, source_id, started_at, status) VALUES (?, ?, ?, 'running')", params: [runId, due.id, now] },
          { sql: "UPDATE sources SET status = 'running', last_run_id = ? WHERE id = ?", params: [runId, due.id] },
          { sql: "SELECT COALESCE(SUM(tokens), 0) AS t FROM docs WHERE deleted_at IS NULL AND status = 'ok'", params: [] },
          { sql: "SELECT COUNT(*) AS n FROM chunks WHERE embedded_at IS NOT NULL", params: [] },
        ]);
        this.sql.exec("DELETE FROM queue");
        this.sql.exec("DELETE FROM todel");
        h.run = { id: runId, sourceId: due.id, kind: src.kind, phase: "list", startedAt: now, corpus: r[2].results[0].t, firstIngest: r[3].results[0].n === 0, total: 0, done: 0, changed: 0, embedded: 0, deleted: 0, neurons: 0, errors: 0, pausedUntil: 0, sitemaps: null, verified: false, truncated: false };
      }
      const run = h.run;
      if (run.pausedUntil > now) return { phase: run.phase, paused: true };
      const src = run.kind === "removed" ? { id: run.sourceId, kind: "removed" } : run.kind === "upload" ? { id: "upload", kind: "upload" } : cfg.sources.find((s) => s.id === run.sourceId);
      if (!src || src.error) {
        await this.abortRun(h, "source removed from ask.json", now, budget);
        return { phase: "aborted" };
      }
      try {
        let bytes = 0;
        for (let guard = 0; guard < 200 && h.run; guard++) {
          if (!fits(budget, 3, ALARM_RESERVE) || this.queriesLeft(budget) < 6) break;
          if (run.phase === "list") {
            const doneListing = await this.listStep(src, run, now, budget);
            if (!doneListing) break;
            run.phase = "docs";
          } else if (run.phase === "docs") {
            const r = await this.docsStep(cfg, src, run, now, budget, bytes);
            bytes = r.bytes;
            if (!r.done) break;
            run.phase = "embed";
          } else if (run.phase === "embed") {
            const r = await this.embedStep(cfg, h, run, now, budget);
            if (r === "paused" || r === "more") break;
            run.phase = "finalize";
          } else if (run.phase === "finalize") {
            const done = await this.finalizeStep(src, run, now, budget);
            if (!done) break;
            await this.completeRun(h, run, now, budget);
            break;
          }
        }
      } catch (err) {
        if (err instanceof BudgetOut) return { phase: run.phase };
        await this.failRun(h, run, err, now, budget);
        return { phase: "failed", error: errText(err) };
      }
      if (h.run) {
        const progress = run.total ? Math.min(99, Math.round((run.done / run.total) * 100)) : 0;
        await this.d1(budget, [{ sql: "UPDATE ingest_runs SET docs_seen = ?, docs_changed = ?, chunks_embedded = ?, neurons = ?, progress = ?, status = ? WHERE id = ?", params: [run.total, run.changed, run.embedded, round(run.neurons), progress, run.pausedUntil > now ? "paused_budget" : "running", run.id] }]).catch(() => {});
      }
      return { phase: h.run?.phase ?? "done" };
    }

    ownHost() {
      try {
        return new URL(String(this.env.PUBLIC_URL ?? "")).hostname || null;
      } catch {
        return null;
      }
    }

    async existingDocs(sourceId, budget) {
      const r = await this.d1(budget, [{ sql: "SELECT path, etag, content_hash, deleted_at FROM docs WHERE source_id = ?", params: [sourceId] }]);
      return r[0].results;
    }

    /** Lists the source into the queue (changed docs) and todel (docs gone). Returns true when listing is complete. */
    async listStep(src, run, now, budget) {
      const env = this.env;
      const own = this.ownHost();
      const queueAll = (items) => {
        for (const it of items) this.sql.exec("INSERT INTO queue (path, etag) VALUES (?, ?) ON CONFLICT (path) DO NOTHING", it.path, it.etag ?? null);
      };
      if (src.kind === "removed") {
        for (const d of await this.existingDocs(src.id, budget)) if (!d.deleted_at) this.sql.exec("INSERT OR IGNORE INTO todel (path) VALUES (?)", d.path);
        return true;
      }
      if (src.kind === "github") {
        const { files, truncated } = await listGithub(env, src, budget, own);
        const have = await this.existingDocs(src.id, budget);
        const byPath = new Map(have.map((d) => [d.path, d]));
        queueAll(files.filter((f) => byPath.get(f.path)?.etag !== f.etag || byPath.get(f.path)?.deleted_at));
        const seen = new Set(files.map((f) => f.path));
        // A truncated tree isn't the whole truth: nothing is deleted on its say-so.
        if (!truncated) for (const d of have) if (!d.deleted_at && !seen.has(d.path)) this.sql.exec("INSERT OR IGNORE INTO todel (path) VALUES (?)", d.path);
        run.truncated = truncated;
        run.total = files.length;
        run.done = files.length - this.count("queue");
        return true;
      }
      if (src.kind === "upload") {
        const r = await this.d1(budget, [
          { sql: "SELECT slug, content_hash FROM uploads", params: [] },
          { sql: "SELECT path, etag, deleted_at FROM docs WHERE source_id = 'upload'", params: [] },
        ]);
        const byPath = new Map(r[1].results.map((d) => [d.path, d]));
        queueAll(r[0].results.filter((u) => byPath.get(u.slug)?.etag !== u.content_hash || byPath.get(u.slug)?.deleted_at).map((u) => ({ path: u.slug, etag: u.content_hash })));
        const seen = new Set(r[0].results.map((u) => u.slug));
        for (const d of r[1].results) if (!d.deleted_at && !seen.has(d.path)) this.sql.exec("INSERT OR IGNORE INTO todel (path) VALUES (?)", d.path);
        run.total = r[0].results.length;
        run.done = run.total - this.count("queue");
        return true;
      }
      if (src.kind === "sitemap") {
        if (!run.verified) {
          const v = await verifyHosts(env, src, budget, own);
          if (!v.ok) throw new Unverified(v.error);
          run.verified = true;
          await this.d1(budget, [{ sql: "UPDATE sources SET verified_at = ? WHERE id = ?", params: [now, src.id] }]);
        }
        if (!run.sitemaps) run.sitemaps = { stack: [{ url: src.sitemap, depth: 0 }], pages: 0, refused: 0 };
        const sm = run.sitemaps;
        while (sm.stack.length) {
          if (!fits(budget, 5, ALARM_RESERVE)) return false;
          const { url, depth } = sm.stack.shift();
          const r = await fetchSitemap(src, url, budget, own);
          sm.refused += r.refused;
          if (depth < MAX_SITEMAP_DEPTH) for (const s of r.sitemaps.slice(0, 50)) sm.stack.push({ url: s, depth: depth + 1 });
          const room = MAX_URLS - sm.pages;
          const pagesHere = r.pages.slice(0, Math.max(0, room));
          queueAll(pagesHere.map((p) => ({ path: p, etag: null })));
          sm.pages = this.count("queue");
        }
        // Every listed page is fetched (conditionally, with its stored ETag).
        const have = await this.existingDocs(src.id, budget);
        for (const d of have) {
          if (d.etag) this.sql.exec("UPDATE queue SET etag = ? WHERE path = ?", d.etag, d.path);
          if (!d.deleted_at && this.sql.exec("SELECT 1 FROM queue WHERE path = ?", d.path).toArray().length === 0) this.sql.exec("INSERT OR IGNORE INTO todel (path) VALUES (?)", d.path);
        }
        run.total = this.count("queue");
        run.done = 0;
        return true;
      }
      throw new Error(`unknown source kind ${src.kind}`);
    }

    count(table) {
      return this.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0].n;
    }

    /** Fetches, converts and stores queued docs, within the run's text and subrequest caps. */
    async docsStep(cfg, src, run, now, budget, bytesSoFar) {
      const env = this.env;
      const own = this.ownHost();
      let bytes = bytesSoFar;
      for (;;) {
        const item = this.sql.exec("SELECT path, etag FROM queue ORDER BY path LIMIT 1").toArray()[0];
        if (!item) return { done: true, bytes };
        if (bytes >= RUN_TEXT_BYTES || !fits(budget, 6, ALARM_RESERVE) || this.queriesLeft(budget) < 8) return { done: false, bytes };
        let doc;
        try {
          if (src.kind === "github") doc = await fetchGithubFile(env, src, item, budget, own);
          else if (src.kind === "sitemap") doc = await fetchPage(src, item, budget, own);
          else if (src.kind === "upload") {
            const u = (await this.d1(budget, [{ sql: "SELECT slug, title, url, body, content_hash FROM uploads WHERE slug = ?", params: [item.path] }]))[0].results[0];
            doc = u ? { markdown: u.body, title: u.title || titleOf(u.body, u.slug), url: u.url, etag: u.content_hash } : undefined;
          }
        } catch (err) {
          if (err instanceof FetchError && err.kind === "budget") return { done: false, bytes };
          // One bad page doesn't fail the run (its old version, if any, stays); many do.
          run.errors++;
          run.lastDocError = `${item.path.slice(0, 120)}: ${errText(err).slice(0, 160)}`;
          this.sql.exec("DELETE FROM queue WHERE path = ?", item.path);
          run.done++;
          if (run.errors > 5 && run.errors > run.total / 4) throw new Error(`too many fetch errors (last: ${run.lastDocError})`);
          continue;
        }
        if (doc === null || doc === undefined) {
          // 304 Not Modified, or an upload deleted since listing.
          this.sql.exec("DELETE FROM queue WHERE path = ?", item.path);
          run.done++;
          continue;
        }
        bytes += doc.markdown.length;
        const id = await docId(src.id, item.path);
        const cur = await this.d1(budget, [
          { sql: "SELECT content_hash, tokens, deleted_at, status FROM docs WHERE id = ?", params: [id] },
          { sql: "SELECT id, content_hash FROM chunks WHERE doc_id = ?", params: [id] },
        ]);
        const old = cur[0].results[0];
        const existing = new Map(cur[1].results.map((c) => [c.id, c.content_hash]));
        const st = await docStatements({ sourceId: src.id, path: item.path, doc, existing, now });
        const oldTokens = old && !old.deleted_at && old.status === "ok" ? old.tokens : 0;
        if (old && !old.deleted_at && old.content_hash === st.contentHash) {
          // Same text (an ETag or sha change only): nothing to re-chunk or re-embed.
          await this.d1(budget, [{ sql: "UPDATE docs SET etag = ?, updated_at = ? WHERE id = ?", params: [doc.etag ?? null, now, id] }]);
        } else if (run.corpus - oldTokens + st.tokens > cfg.maxCorpusTokens) {
          // Over maxCorpusTokens: flagged, not stored (sources are taken in order up to the cap).
          await this.d1(budget, [{ sql: "INSERT INTO docs (id, source_id, path, url, title, etag, tokens, status, updated_at) VALUES (?, ?, ?, '', ?, NULL, ?, 'over_cap', ?) ON CONFLICT (id) DO UPDATE SET status = CASE WHEN docs.deleted_at IS NULL AND docs.status = 'ok' THEN docs.status ELSE 'over_cap' END, updated_at = excluded.updated_at", params: [id, src.id, item.path, String(doc.title).slice(0, 200), st.tokens, now] }]);
          run.overCap = (run.overCap ?? 0) + 1;
        } else {
          if (st.stmts.length > this.queriesLeft(budget) - 4) return { done: false, bytes };
          await this.d1(budget, st.stmts);
          for (const rid of st.removed) this.sql.exec("INSERT OR IGNORE INTO vdel (id) VALUES (?)", rid);
          run.corpus += st.tokens - oldTokens;
          run.changed++;
        }
        this.sql.exec("DELETE FROM queue WHERE path = ?", item.path);
        run.done++;
      }
    }

    /** Embeds chunks waiting for it, within the ingest pool. "done" | "more" | "paused". */
    async embedStep(cfg, h, run, now, budget) {
      const rates = EMBED_MODELS[cfg.embedModel];
      for (;;) {
        if (!fits(budget, 4, ALARM_RESERVE) || this.queriesLeft(budget) < 4) return "more";
        const got = await this.d1(budget, [
          { sql: "SELECT id, doc_id, heading_path, text FROM chunks WHERE embedded_at IS NULL LIMIT 100", params: [] },
          { sql: "SELECT v FROM state WHERE k = 'embed_model'", params: [] },
        ]);
        const rows = got[0].results;
        if (!rows.length) return "done";
        // Vectors from two models can't share an index (open question 5): refuse, with what to do.
        const indexModel = got[1].results[0]?.v;
        if (indexModel && indexModel !== cfg.embedModel) throw new Error(`the Vectorize index holds ${indexModel} vectors but embedModel is ${cfg.embedModel}: create a new index with the new model's dimensions, point wrangler.jsonc at it, clear the chunks table and re-ingest`);
        const texts = rows.map((r) => `${r.heading_path ? `${r.heading_path}\n` : ""}${r.text}`.slice(0, 2000));
        const d = this.dayState(now);
        const left = available(d, cfg.budget, now, { firstIngest: run.firstIngest }).ingest;
        let k = 0;
        let est = 0;
        while (k < texts.length) {
          const e = embedNeurons(rates, tokens(texts[k]));
          if (est + e > left) break;
          est += e;
          k++;
        }
        if (k === 0) {
          // The ingest pool is spent: pause until 00:00 UTC (docs/SDD.md, "Over the budget or the cap").
          run.pausedUntil = nextMidnight(now) + MIN;
          await this.d1(budget, [{ sql: "UPDATE sources SET status = 'paused_budget' WHERE id = ?", params: [run.sourceId] }]);
          return "paused";
        }
        const hold = this.hold("ingest", est, now, { firstIngest: run.firstIngest });
        if (!hold) {
          run.pausedUntil = nextMidnight(now) + MIN;
          return "paused";
        }
        let res;
        try {
          if (!spend(budget, 2)) throw new BudgetOut();
          res = await embed(this.env, cfg, texts.slice(0, k));
        } catch (err) {
          await this.settle(hold, 0);
          if (err instanceof AIError) {
            const ex = await this.aiFailed(err.quota, now);
            if (ex) {
              run.pausedUntil = nextMidnight(now) + MIN;
              await this.d1(budget, [{ sql: "UPDATE sources SET status = 'paused_budget' WHERE id = ?", params: [run.sourceId] }]);
              return "paused";
            }
          }
          throw err;
        }
        await this.settle(hold, res.neurons);
        run.neurons += res.neurons;
        const ids = rows.slice(0, k).map((r) => r.id);
        await this.env.VECTORIZE.upsert(ids.map((id, i) => ({ id, values: res.vectors[i], metadata: { doc: rows[i].doc_id } })));
        const stmts = [{ sql: "INSERT OR IGNORE INTO state (k, v) VALUES ('embed_model', ?)", params: [cfg.embedModel] }];
        for (let i = 0; i < ids.length; i += 99) {
          const part = ids.slice(i, i + 99);
          stmts.push({ sql: `UPDATE chunks SET embedded_at = ? WHERE id IN (${part.map(() => "?").join(",")})`, params: [now, ...part] });
        }
        await this.d1(budget, stmts);
        run.embedded += k;
      }
    }

    /** Deletions happen only here, at the end of a complete listing (a failed crawl never empties the index). */
    async finalizeStep(src, run, now, budget) {
      for (;;) {
        if (!fits(budget, 3, ALARM_RESERVE) || this.queriesLeft(budget) < 5) return false;
        const paths = this.sql.exec("SELECT path FROM todel LIMIT 50").toArray().map((r) => r.path);
        if (!paths.length) break;
        const ids = await Promise.all(paths.map((p) => docId(src.id, p)));
        const ph = ids.map(() => "?").join(",");
        const res = await this.d1(budget, [
          { sql: `SELECT id FROM chunks WHERE doc_id IN (${ph})`, params: ids },
          { sql: `DELETE FROM chunks WHERE doc_id IN (${ph})`, params: ids },
          { sql: `UPDATE docs SET deleted_at = ? WHERE id IN (${ph})`, params: [now, ...ids] },
        ]);
        for (const r of res[0].results) this.sql.exec("INSERT OR IGNORE INTO vdel (id) VALUES (?)", r.id);
        for (const p of paths) this.sql.exec("DELETE FROM todel WHERE path = ?", p);
        run.deleted += paths.length;
      }
      for (;;) {
        if (!fits(budget, 2, ALARM_RESERVE)) return false;
        const ids = this.sql.exec("SELECT id FROM vdel LIMIT 500").toArray().map((r) => r.id);
        if (!ids.length) return true;
        spend(budget, 1);
        await this.env.VECTORIZE.deleteByIds(ids);
        for (const id of ids) this.sql.exec("DELETE FROM vdel WHERE id = ?", id);
      }
    }

    async completeRun(h, run, now, budget) {
      const changed = run.changed + run.deleted + run.embedded > 0;
      const err = run.lastDocError ? `${run.errors} page(s) failed; last: ${run.lastDocError}` : run.truncated ? "GitHub's tree was truncated: nothing was deleted" : run.overCap ? `${run.overCap} doc(s) over maxCorpusTokens weren't stored` : null;
      const stmts = [
        { sql: "UPDATE ingest_runs SET finished_at = ?, docs_seen = ?, docs_changed = ?, chunks_embedded = ?, neurons = ?, progress = 100, status = 'ok', error = ? WHERE id = ?", params: [now, run.total, run.changed, run.embedded, round(run.neurons), err, run.id] },
      ];
      if (run.kind === "removed") {
        stmts.push({ sql: "DELETE FROM sources WHERE id = ? AND status = 'removed'", params: [run.sourceId] });
      } else {
        const every = run.kind === "upload" ? 365 * 86400_000 : (this.cfg.sources.find((s) => s.id === run.sourceId)?.everyMs ?? 86400_000);
        stmts.push({
          sql: "UPDATE sources SET status = CASE WHEN paused = 1 THEN 'paused' ELSE 'ok' END, fail_count = 0, last_error = ?1, next_at = ?2, docs = (SELECT COUNT(*) FROM docs WHERE source_id = ?3 AND deleted_at IS NULL AND status = 'ok'), chunks = (SELECT COUNT(*) FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE d.source_id = ?3 AND d.deleted_at IS NULL) WHERE id = ?3",
          params: [err, now + every, run.sourceId],
        });
      }
      // Every completed ingest that changed something bumps docs_version, so cached answers stop matching.
      if (changed) stmts.push({ sql: "UPDATE state SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT) WHERE k = 'docs_version'", params: [] });
      await this.d1(budget, stmts);
      this.sql.exec("DELETE FROM queue");
      this.sql.exec("DELETE FROM todel");
      h.run = null;
    }

    async failRun(h, run, err, now, budget) {
      const unverified = err instanceof Unverified;
      const r = await this.env.DB.prepare("SELECT fail_count, every_ms FROM sources WHERE id = ?").bind(run.sourceId).first().catch(() => null);
      const fails = (r?.fail_count ?? 0) + 1;
      // Retried at 1 h, 6 h, then the normal schedule; never a hot loop.
      const delay = INGEST_RETRY[fails - 1] ?? r?.every_ms ?? 86400_000;
      const msg = errText(err).slice(0, 300);
      spend(budget, 1);
      await this.env.DB.batch([
        this.env.DB.prepare("UPDATE ingest_runs SET finished_at = ?, status = 'failed', error = ?, docs_seen = ?, chunks_embedded = ?, neurons = ? WHERE id = ?").bind(now, msg, run.total, run.embedded, round(run.neurons), run.id),
        this.env.DB.prepare("UPDATE sources SET status = ?, fail_count = ?, last_error = ?, next_at = ? WHERE id = ?").bind(unverified ? "unverified" : "failed", fails, msg, now + delay, run.sourceId),
      ]).catch((e) => console.error(`keeper: failRun write: ${errText(e)}`));
      this.sql.exec("DELETE FROM queue");
      this.sql.exec("DELETE FROM todel");
      h.run = null;
    }

    async abortRun(h, why, now, budget) {
      if (!h.run) return;
      await this.d1(budget, [{ sql: "UPDATE ingest_runs SET finished_at = ?, status = 'failed', error = ? WHERE id = ?", params: [now, `stopped: ${why}`, h.run.id] }]).catch(() => {});
      this.sql.exec("DELETE FROM queue");
      this.sql.exec("DELETE FROM todel");
      h.run = null;
    }

    // ---- scheduling ------------------------------------------------------

    async nextTimes(cfg, h, now, budget) {
      const times = [now + IDLE_MS];
      if (h.run) times.push(h.run.pausedUntil > now ? h.run.pausedUntil : now + 1000);
      if (h.purgeMore) times.push(now + MIN);
      times.push(h.lastPurgeDay === utcDay(now) ? nextMidnight(now) + 5 * MIN : now + 1000);
      const r = await this.d1(budget, [
        { sql: "SELECT MIN(next_at) AS at FROM sources WHERE paused = 0 AND status NOT IN ('config_error', 'running')", params: [] },
        { sql: "SELECT MIN(next_at) AS at FROM emails WHERE status = 'queued'", params: [] },
        { sql: "SELECT MIN(CASE WHEN status = 'sending' THEN next_at + 600000 ELSE next_at END) AS at FROM deliveries WHERE status IN ('pending', 'retry', 'sending')", params: [] },
        { sql: "SELECT COUNT(*) AS n FROM drafts WHERE notified = 0 AND status = 'new'", params: [] },
        { sql: "SELECT COUNT(*) AS n FROM drafts WHERE requested_action IS NOT NULL", params: [] },
      ]);
      const src = r[0].results[0].at;
      if (src !== null && !h.run) times.push(src);
      const em = r[1].results[0].at;
      if (em !== null && cfg.inbox.enabled) times.push(Math.max(em, h.draftsBlockedUntil ?? 0));
      const dl = r[2].results[0].at;
      if (dl !== null) times.push(dl);
      if (r[3].results[0].n > 0 && this.env.FORWARD_TO && this.env.MAIL_FROM) times.push((h.lastDigestAt ?? 0) + DIGEST_EVERY);
      if (r[4].results[0].n > 0) times.push(now + 1000);
      return { at: Math.min(...times) };
    }

    async heartbeat(h, now, budget) {
      const url = this.env.HEARTBEAT_URL;
      if (!url || now - (h.heartbeatAt ?? 0) < 5 * MIN || !spend(budget, 1)) return;
      h.heartbeatAt = now;
      const t = checkTarget(url);
      if (!t.ok || t.url.protocol !== "https:") return;
      try {
        const res = await net.fetch(t.url.toString(), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000) });
        await res.body?.cancel();
      } catch (err) {
        console.error(`keeper: heartbeat: ${errText(err)}`);
      }
    }
  };
}

class BudgetOut extends Error {
  constructor() {
    super("subrequest budget used up");
  }
}

class Unverified extends Error {}

function holdingReply(env, links) {
  const sig = String(env.INBOX_SIGNATURE ?? "").slice(0, 300);
  const list = links.filter((c) => c.url).map((c) => `- ${c.title}: ${c.url}`);
  return `Hi,\n\nThanks for your message. I'm looking into this and will get back to you soon.${list.length ? `\n\nIn the meantime, these pages may help:\n${list.join("\n")}` : ""}\n\n${sig || "Thanks"}`;
}

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const mapRound = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));

export { parseJson };
