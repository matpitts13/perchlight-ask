// The admin API: /api/* with Authorization: Bearer <ADMIN_TOKEN> (16+
// characters, constant-time compare, 503 when it isn't set).
import { json, fail, readJson, utcDay, parseJson } from "../lib/http.js";
import { safeEqual, sha256Hex } from "../lib/crypto.js";
import { keeperStub, clock } from "../lib/appctx.js";
import { terms } from "../lib/text.js";
import { checkTarget } from "../lib/ssrf.js";
import { allowedOrigins } from "../lib/guard.js";

export const MAX_UPLOAD = 1024 * 1024;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export async function authorized(request, env) {
  const token = env.ADMIN_TOKEN;
  if (typeof token !== "string" || token.length < 16) return "not_configured";
  const h = request.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return "no";
  return (await safeEqual(m[1].trim(), token)) ? "yes" : "no";
}

export async function handleAdmin(request, app, ctx, path) {
  const { env, cfg } = app;
  const auth = await authorized(request, env);
  if (auth === "not_configured") return fail(503, "not_configured", "ADMIN_TOKEN isn't set (16+ characters).");
  if (auth !== "yes") return fail(401, "unauthorized", "Send Authorization: Bearer <ADMIN_TOKEN>.");
  const method = request.method;
  const db = env.DB;
  const keeper = keeperStub(env);
  const wake = () => ctx.waitUntil(keeper.wake().catch((e) => console.error(`admin: wake failed: ${e}`)));
  const now = clock.now();
  const seg = path.split("/").filter(Boolean);

  if (seg[0] === "sources") {
    if (method === "GET" && seg.length === 1) return json({ sources: (await db.prepare("SELECT id, kind, location, status, paused, docs, chunks, next_at, verified_at, fail_count, last_error, last_run_id FROM sources ORDER BY id").all()).results });
    if (method === "POST" && seg.length === 3 && SOURCE_ID.test(seg[1]) && ["reingest", "pause", "resume"].includes(seg[2])) {
      const r = await db.prepare("UPDATE sources SET requested_action = ? WHERE id = ?").bind(seg[2], seg[1]).run();
      if (!r.meta.changes) return fail(404, "not_found", "No such source.");
      wake();
      return json({ ok: true, requested: seg[2] }, 202);
    }
  }

  if (seg[0] === "docs") {
    if (method === "GET" && seg.length === 1) return json({ docs: (await db.prepare("SELECT d.id, d.source_id, d.path, d.url, d.title, d.tokens, d.status, d.updated_at, (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunks FROM docs d WHERE d.deleted_at IS NULL ORDER BY d.source_id, d.path LIMIT 1000").all()).results });
    if (seg.length === 2 && SLUG.test(seg[1])) {
      if (method === "PUT") {
        const body = await readJson(request, MAX_UPLOAD + 4096);
        if (!body.ok) return fail(body.tooLarge ? 413 : 400, "bad_request", body.tooLarge ? "Uploads are 1 MB at most." : "Send JSON {markdown, title?, url?}.");
        const { markdown, title = "", url = "" } = body.value;
        if (typeof markdown !== "string" || !markdown.trim()) return fail(400, "bad_request", "markdown must be non-empty text.");
        if (new TextEncoder().encode(markdown).length > MAX_UPLOAD) return fail(413, "too_large", "Uploads are 1 MB at most.");
        if (url) {
          const t = checkTarget(url);
          if (!t.ok || t.url.protocol !== "https:") return fail(400, "bad_url", "url must be an https:// URL on a public host (it's shown as the citation link).");
        }
        const hash = (await sha256Hex(markdown)).slice(0, 40);
        await db.batch([
          db.prepare("INSERT INTO uploads (slug, title, url, body, content_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (slug) DO UPDATE SET title = excluded.title, url = excluded.url, body = excluded.body, content_hash = excluded.content_hash, updated_at = excluded.updated_at").bind(seg[1], String(title).slice(0, 200), String(url), markdown, hash, now),
          db.prepare("INSERT INTO sources (id, kind, config, location, every_ms, next_at, status) VALUES ('upload', 'upload', '{}', 'uploaded markdown', 31536000000, 0, 'new') ON CONFLICT (id) DO UPDATE SET next_at = 0, status = CASE WHEN sources.status = 'running' THEN 'running' ELSE 'new' END"),
        ]);
        wake();
        return json({ ok: true, slug: seg[1], ingest: "queued" }, 202);
      }
      if (method === "DELETE") {
        const r = await db.prepare("DELETE FROM uploads WHERE slug = ?").bind(seg[1]).run();
        if (!r.meta.changes) return fail(404, "not_found", "No such upload.");
        await db.prepare("UPDATE sources SET next_at = 0 WHERE id = 'upload'").run();
        wake();
        return json({ ok: true, removed: seg[1], note: "Its chunks are removed at the end of the next ingest run." }, 202);
      }
    }
  }

  if (seg[0] === "asks") {
    if (method === "GET" && seg.length === 1) {
      const u = new URL(request.url);
      const limit = Math.min(500, Math.max(1, Number(u.searchParams.get("limit")) || 100));
      const idk = u.searchParams.get("idk") === "1";
      return json({ asks: (await db.prepare(`SELECT id, at, origin, question, answer, confidence, mode, neurons, helpful, cached FROM asks ${idk ? "WHERE confidence = 'none'" : ""} ORDER BY at DESC LIMIT ?`).bind(limit).all()).results });
    }
    if (method === "DELETE" && seg.length === 1) {
      const r = await db.prepare("DELETE FROM asks").run();
      return json({ ok: true, deleted: r.meta.changes });
    }
    if (method === "DELETE" && seg.length === 2) {
      const r = await db.prepare("DELETE FROM asks WHERE id = ?").bind(seg[1]).run();
      return r.meta.changes ? json({ ok: true }) : fail(404, "not_found", "No such question.");
    }
  }

  if (seg[0] === "unanswered" && method === "GET") {
    // Should: "I don't know" questions from the last 7 days, grouped by shared keywords.
    const rows = (await db.prepare("SELECT question, at FROM asks WHERE confidence = 'none' AND at > ? ORDER BY at DESC LIMIT 500").bind(now - 7 * 86400_000).all()).results;
    const groups = [];
    for (const r of rows) {
      const ts = terms(r.question);
      const g = groups.find((x) => ts.filter((t) => x.terms.includes(t)).length >= Math.max(1, Math.ceil(Math.min(ts.length, x.terms.length) / 2)));
      if (g) {
        g.count++;
        if (g.examples.length < 3) g.examples.push(r.question);
      } else groups.push({ terms: ts, count: 1, examples: [r.question] });
    }
    return json({ groups: groups.sort((a, b) => b.count - a.count).slice(0, 50) });
  }

  if (seg[0] === "drafts") {
    if (method === "GET" && seg.length === 1) return json({ drafts: (await db.prepare("SELECT d.id, d.created_at, d.from_addr, d.subject, d.body, d.sources, d.confidence, d.needs_you, d.flags, d.status, d.mailto, d.send_result, e.body AS email FROM drafts d LEFT JOIN emails e ON e.id = d.email_id ORDER BY d.created_at DESC LIMIT 200").all()).results.map((d) => ({ ...d, sources: parseJson(d.sources, []) })) });
    if (method === "POST" && seg.length === 3 && ["approve", "discard"].includes(seg[2])) {
      const r = await db.prepare("UPDATE drafts SET requested_action = ? WHERE id = ? AND status IN ('new', 'approved')").bind(seg[2], seg[1]).run();
      if (!r.meta.changes) return fail(404, "not_found", "No such draft (or it's already sent).");
      wake();
      return json({ ok: true, requested: seg[2], sends: seg[2] === "approve" && String(env.INBOX_SEND ?? "") === "resend" }, 202);
    }
  }

  if (seg[0] === "runs" && method === "GET") return json({ runs: (await db.prepare("SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT 100").all()).results });

  if (seg[0] === "budget" && method === "GET") {
    const today = await keeper.budget(now);
    return json({ ...today });
  }

  if (seg[0] === "footprint" && method === "GET") {
    const [today, rows] = await Promise.all([keeper.budget(now), db.prepare("SELECT * FROM daily ORDER BY day DESC LIMIT 30").all()]);
    const d = rows.results.find((r) => r.day === utcDay(now)) ?? null;
    return json({
      today: { day: utcDay(now), workerRequests: d?.requests ?? 0, d1RowsWritten: d?.d1_rows_written ?? 0, neurons: today.used, mode: today.mode, counters: d },
      limits: { workerRequestsPerDay: 100000, d1RowsWrittenPerDay: 100000, neuronsPerDay: 10000, ourHardStop: today.hardStop },
      note: "Neurons are this deployment's own; other Workers AI use on the account counts against the same 10,000 a day (lower ASK_NEURON_CAP to match). Worker requests here are /v1/ask calls; widget loads and admin calls aren't counted.",
      days: rows.results,
    });
  }

  if (seg[0] === "settings" && method === "GET") {
    const set = (k) => typeof env[k] === "string" && env[k].length > 0;
    return json({
      secrets: Object.fromEntries(["ADMIN_TOKEN", "SESSION_SECRET", "IP_SALT", "TURNSTILE_SECRET", "ASK_API_KEYS", "SITE_PROOF", "GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "RESEND_API_KEY"].map((k) => [k, set(k)])),
      allowedOrigins: allowedOrigins(env),
      model: cfg.model,
      embedModel: cfg.embedModel,
      embedModelWarning: await (async () => {
        const r = await db.prepare("SELECT v FROM state WHERE k = 'embed_model'").first();
        return r && r.v !== cfg.embedModel ? `The index holds ${r.v} vectors; embedModel is ${cfg.embedModel}. Changing it needs a new Vectorize index and a full re-embed.` : null;
      })(),
      inbox: { enabled: cfg.inbox.enabled, forwardTo: set("FORWARD_TO"), send: String(env.INBOX_SEND ?? "") === "resend" ? "resend" : "off", notify: String(env.NOTIFY_PROVIDER ?? "") === "resend" ? "resend" : "send_email" },
      logging: { questions: cfg.logQuestions, retentionDays: cfg.retentionDays },
      budget: cfg.budget,
      sources: cfg.sources.map((s) => ({ id: s.id, kind: s.kind, error: s.error })),
      keeper: await keeper.status(),
    });
  }

  return fail(404, "not_found", "No such admin route.");
}
