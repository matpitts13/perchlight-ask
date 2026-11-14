# perchlight-ask

A free, self-hosted "ask the docs" widget and API, plus AI-drafted replies for your support inbox, running on your own Cloudflare account: one Worker, one D1 database, one Vectorize index, Workers AI and one small Durable Object. No cron trigger. Part of the [Perchlight](https://perchlight.ravenburst.com) family.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matpitts13/perchlight-ask)

- **Ask the docs.** One `<script>` tag puts a small panel on your site (Turnstile-protected), and `POST /v1/ask` does the same for your own apps. Answers come only from **your** docs (a GitHub folder, your docs site's sitemap, or uploaded markdown), cite their sources as `[1]`, `[2]` and link to the pages they came from. When the docs don't cover a question it says **"I couldn't find that in the docs."** without asking the model at all.
- **Support inbox (optional, off by default).** Mail to `support@yourdomain` arrives through Cloudflare Email Routing, is **forwarded to your real inbox first**, and then gets a **draft** reply written from your docs. You copy it (or open it in your mail app), edit, and send it yourself. **It never sends anything on its own.**

**Honest limits, up front.** Workers AI on the Free plan gives **10,000 neurons a day**; this deployment stops at 9,500. That's roughly **350 cited answers a day** (up to ~475 when the inbox and ingest reserves go unused), after which it keeps working as a plain docs search (links with snippets) until 00:00 UTC. The answers come from a small model (Llama 3.1 8B): usually good for "how do I…" questions, and sometimes wrong, which is why every answer shows its sources. Other Workers AI use on the same account counts against the same 10,000.

The design is in [docs/SDD.md](docs/SDD.md) (its "Build notes" list where v0.1 differs from it).

## Set up

You need a Cloudflare account (the free plan is enough) and Node 22+.

1. **`ask.json`** (repo root): your product name, a contact line, and your docs sources (see below).
2. **Create the pieces and secrets.**
   ```sh
   npm install
   npx wrangler d1 create perchlight-ask                                   # copy the database_id into wrangler.jsonc
   npx wrangler vectorize create ask-chunks --dimensions=384 --metric=cosine
   npx wrangler secret put ADMIN_TOKEN        # 16+ random characters: openssl rand -hex 32
   npx wrangler secret put SESSION_SECRET     # 16+ random characters (widget sessions)
   npx wrangler secret put IP_SALT            # 16+ random characters (IP hashing for rate limits)
   npx wrangler secret put TURNSTILE_SECRET   # from a Turnstile widget whose hostnames are your sites
   npx wrangler secret put GITHUB_TOKEN       # optional: fine-grained, read-only Contents on the docs repo
   npx wrangler secret put SITE_PROOF         # only for sitemap sources: 16+ random characters
   npm run deploy                             # applies migrations, then deploys
   ```
   Keep your own copy with real ids in `wrangler.mine.jsonc` (gitignored) if you like: `npx wrangler deploy -c wrangler.mine.jsonc`.
3. **`wrangler.jsonc` vars:** `PUBLIC_URL` (your Worker's URL) and `ALLOWED_ORIGINS` (the sites the widget may run on, e.g. `https://example.com, https://docs.example.com`).
4. **First ingest.** The Keeper's first run copies `ask.json` into D1 and starts ingesting (any request wakes it):
   ```sh
   curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/api/settings   # what's set, config errors
   curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/api/sources    # ingest status
   ```
5. **The widget** on your site:
   ```html
   <script src="https://<host>/widget.js?v=0.1.0" data-site-key="<your Turnstile site key>" data-title="Ask the docs" async></script>
   ```

## `ask.json`

```jsonc
{
  "name": "My Product",                                  // used in the prompts
  "contact": "Still stuck? Email support@example.com.",  // added to "I couldn't find that"
  "sources": [
    // A GitHub folder: *.md, *.mdx, *.txt under path, up to 1 MB each. The blob sha is the change check.
    { "id": "docs", "kind": "github", "repo": "you/your-repo", "branch": "main", "path": "docs",
      "urlBase": "https://docs.example.com",   // optional: citation links on your site instead of github.com
      "every": "1d" },                          // 6h, 12h, 1d or 7d
    // Your docs site: every URL must be on a listed host that serves SITE_PROOF.
    { "id": "site", "kind": "sitemap", "sitemap": "https://docs.example.com/sitemap.xml", "hosts": ["docs.example.com"], "every": "1d" }
  ],
  "inbox": { "enabled": false, "dailyCap": 50, "ownAddresses": ["support@example.com"] },
  "retentionDays": 30,
  // Optional tuning (defaults shown):
  "model": "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
  "embedModel": "@cf/baai/bge-small-en-v1.5",
  "budget": { "hardStop": 9500, "inboxReserve": 1500, "ingestReserve": 1000, "releaseHourUtc": 18, "leanBelow": 1000, "searchBelow": 100 },
  "retrieval": { "minScore": 0.55, "topK": 8, "maxChunks": 5, "maxContextTokens": 1500, "minKeywordCoverage": 0.6 },
  "limits": { "perIpPerMinute": 10, "perIpPerDay": 60, "perSession": 20, "sessionMinutes": 30, "dailyCap": 1000 },
  "maxCorpusTokens": 1500000
}
```

Markdown you upload: `PUT /api/docs/<slug>` with `{"markdown": "...", "title": "...", "url": "https://..."}` (1 MB at most; `url` is the citation link). `DELETE /api/docs/<slug>` removes it at the end of the next ingest run.

**Your own content only.** GitHub fetches go only to `api.github.com` for the configured repo. A sitemap source is crawled only after every listed host serves `https://<host>/.well-known/perchlight-ask.txt` containing your `SITE_PROOF`; if the file disappears, existing docs stay and new crawls stop (`unverified`). Every fetch is `https:` only, never to an IP address, a private or local name or this deployment, never with credentials in the URL; redirects are followed by hand (up to 3), each hop re-checked; pages are capped at 2 MB, files at 1 MB, and each fetch has a time limit.

## How an answer is made

1. Checks: body ≤ 2 KB, question 3–500 characters, a widget session or an API key, rate limits.
2. The same question (normalised) against the same docs version within 24 hours comes from the cache: no neurons.
3. The Keeper reserves the worst-case neuron cost and picks the mode: **full** (5 chunks, up to 300 tokens out), **lean** (3 chunks, 180 out) or **search** (no model at all).
4. Retrieval: Vectorize top 8 + D1 FTS5 keyword top 8, merged by reciprocal-rank fusion. Keyword search catches exact terms like error codes, and keeps search working if Vectorize is down.
5. Weak retrieval (best similarity under `minScore` and no keyword hit covering most of the question): **"I couldn't find that in the docs."** with up to 3 closest pages and your contact line, **without a model call**.
6. Otherwise the model gets your docs as numbered, fenced data and the question, and answers in under 150 words. Citations to sources it wasn't given are removed; an answer with none is marked low confidence ("This answer may not be in the docs").

`POST /v1/ask` → `{answer, sources:[{n,title,url,heading}], confidence: "high"|"low"|"none", mode: "full"|"lean"|"search"|"cache", id}`. Your apps send `X-Api-Key` (add keys to the `ASK_API_KEYS` secret as `{"my-app":{"hash":"<npm run hash-key output>","daily":500}}`). Follow-ups can send `history: {question, answer}` (the last exchange only).

## The daily AI budget

One ledger in the Keeper Durable Object (a single instance, so reservations are atomic). Every AI call reserves its worst case first (input at 4 characters per token plus the output cap) and settles the real cost after, so parallel questions can't overshoot. Defaults: hard stop 9,500 of 10,000; 1,500 held for inbox drafts and 1,000 for ingest until 18:00 UTC, then released to questions; full while the questions' pool has ≥ 1,000 left, lean down to 100, then search. If Workers AI refuses anyway (another Worker used neurons, or our estimate was off), the day is marked exhausted and everything answers from search until 00:00 UTC. **If other Workers on your account use Workers AI, lower `ASK_NEURON_CAP`.**

Ingest only re-embeds changed chunks (about 420 neurons to embed a 200,000-token docs set the first time; an unchanged re-run costs 0). If the ingest pool runs out mid-run, it pauses and resumes after 00:00 UTC.

## Inbox mode

1. Your domain's mail on Cloudflare Email Routing; your real inbox added and verified as a destination address; a rule `support@yourdomain` → this Worker.
2. `wrangler.jsonc`: `FORWARD_TO` (your real inbox), `MAIL_FROM` (an address on your domain, for digests), `INBOX_SIGNATURE`; `ask.json`: `"inbox": {"enabled": true}`.

Each mail is **forwarded first** (so you get it even if the rest fails), then skipped if it's an auto-reply, a list or bulk mail, a bounce, a no-reply sender, one of your own addresses, or over `dailyCap`; otherwise a trimmed copy (first 64 KB read, first text part, quoted history cut, ~800 tokens, no attachments) is stored and the Keeper writes a draft within a minute. Low-confidence drafts are marked *needs you*; with nothing in the docs, the draft is a short holding reply plus the closest links. Drafts whose email looks like a prompt injection ("ignore previous instructions…") or that contain links not from your docs carry a warning. You get at most one digest an hour ("3 new drafts waiting in Perchlight", subjects only) through `send_email` to `FORWARD_TO`.

**Sending:** v0.1 has *Copy* and a `mailto:` link: you reply from your own mail client. *Approve & send* through Resend (with `In-Reply-To`/`References`, an idempotency key, from your own domain) is built but **off**; it's on only with `INBOX_SEND=resend`, `RESEND_API_KEY` and `INBOX_FROM`, and even then only the specific draft you approve is sent. Approving or discarding in the app takes effect at the Keeper's next run (within 10 minutes); discarded drafts are deleted with their email copy. `NOTIFY_PROVIDER=resend` sends digests through Resend instead (100 a day on its free plan).

## No cron trigger: how work is timed

One Durable Object, `Keeper`, with one alarm set to the next due thing: an ingest step (1 second apart while a run is going), a queued draft, a digest or a retry, the daily retention purge, or at most 10 minutes. Each run sets a safety alarm first, works inside a 40-subrequest budget with 5 held back, saves its whole state every run (so an eviction never loses an ingest run's place), and backs off (30 s doubling to 30 min) when a run fails, so a persistent failure never hot-loops. A failed crawl deletes nothing and is retried at 1 h, 6 h, then the normal schedule. A signed GitHub push webhook to `/v1/hooks/github` (`GITHUB_WEBHOOK_SECRET`) re-ingests early. Any request re-arms the alarm if it ever stops; `HEARTBEAT_URL` (e.g. a perchlight-hooks ping URL) hears about it if the Keeper itself stops.

## Admin API

`Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare, 16+ characters; `/api/*` answers `503` until it's set).

| Endpoint | What |
|---|---|
| `GET /api/sources`, `POST /api/sources/:id/reingest\|pause\|resume` | Sources and ingest status |
| `GET /api/docs`, `PUT/DELETE /api/docs/:slug` | Docs; upload markdown |
| `GET /api/runs` | Ingest runs |
| `GET /api/asks?idk=1&limit=`, `DELETE /api/asks/:id`, `DELETE /api/asks` | Questions (the "I don't know" ones show missing docs) |
| `GET /api/unanswered` | Last 7 days' "I don't know" questions, grouped by shared keywords: the docs to write next |
| `GET /api/drafts`, `POST /api/drafts/:id/approve\|discard` | Inbox drafts |
| `GET /api/budget`, `GET /api/footprint`, `GET /api/settings` | Today's neurons by pool and mode; measured counts; what's configured (never secret values) |

## Perchlight desktop app

`perchlight/perchlight.json` adds screens for Sources (*Re-ingest now*, *Pause*, *Resume*), Ingest runs, Questions (filter confidence `none` for missing docs; *Delete*), Drafts (email and draft side by side, sources, the `mailto:` link; *Approve*, *Discard*; copy the draft column), Support mail and Budget. Replace `YOUR-D1-DATABASE-ID`.

## Security notes

- **Docs, questions and emails are untrusted text.** They reach the model only inside delimited data blocks (anything that could close a block is escaped) and the system prompt says they're data. That lowers the risk of prompt injection; it doesn't remove it. The real defences don't depend on the model obeying: **the model has no tools, and nothing it writes decides what the Worker does** (the only thing read from its output is which `[n]` citations it used, checked against the sources given); **links shown to visitors are only the cited sources' URLs, from D1**, never from model text, and the widget renders model text as plain text nodes (no HTML); **drafts are never sent automatically.** A doc page that grows an injected instruction can still make an answer repeat bad text, but it can't add a link or take an action, and the citation shows which page it came from. Your docs are trusted only as far as you control them.
- Widget sessions need Turnstile for an allowed hostname (the `hostname` in Turnstile's answer is checked), last 30 minutes and 20 questions; CORS answers only `ALLOWED_ORIGINS`. Rate limits: 10 questions a minute and 60 a day per IP hash, 20 per session, `ASK_DAILY_CAP` (1,000) a day overall, each API key's own daily cap; over a limit is `429` with `Retry-After`. Every request, even refused, is one Worker request out of 100,000 a day; on a custom domain add a WAF rate-limiting rule if you're flooded.
- Secrets (`ADMIN_TOKEN`, `SESSION_SECRET`, `IP_SALT`, `TURNSTILE_SECRET`, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `RESEND_API_KEY`, `ASK_API_KEYS`, `SITE_PROOF`) are Worker secrets, never in D1, config or logs. Admin token, API keys, sessions and webhook signatures are compared in constant time. All SQL is parameterised; keyword search quotes every term, so a question can't inject FTS syntax.

## Privacy

Stored per question: the question (emails, phone numbers and long digit runs redacted), the answer, cited chunks, confidence, mode, neurons, the page origin, the helpful flag and the time. **Never stored:** IP addresses, user agents, cookies; a daily HMAC of the IP lives only in the rate counters and is deleted after 48 hours. **Opt-out:** the widget's "Don't save my question" (remembered in the visitor's browser), `log: false` in the API and `Sec-GPC: 1` all mean only an anonymous counter is written; `LOG_QUESTIONS=0` turns logging off entirely. Questions, emails and drafts are deleted after `RETENTION_DAYS` (30) by the daily alarm.

If you or your users are in the EU, mention the widget in your privacy policy. A starting point (not legal advice): *"Our help widget sends the question you type to our own server on Cloudflare, which answers it from our documentation using an AI model run by Cloudflare. We keep your question and the answer for up to 30 days to improve our docs, without your IP address. Tick "Don't save my question" (or use Global Privacy Control) and it isn't kept."*

## What it costs

Nothing inside the free tiers: Workers Free, D1, Durable Objects (SQLite), Workers AI (10,000 neurons a day), Vectorize (5 M stored and 30 M queried dimensions a month), Turnstile, Email Routing and `send_email` to your own verified address. From the SDD's example (300 questions a day: 150 answered, 100 cached, 50 search; 600 widget loads; 20 support emails; 200,000 tokens of docs): about 950 Worker requests (1%), about 3,700 neurons (37%), about 1,500 D1 rows written (1.5%), about 230,000 stored vector dimensions (5%). `GET /api/footprint` shows measured counts. Keyword search (FTS5) stores each chunk's text in D1 (a few MB for a typical docs set); note that `wrangler d1 export` doesn't export FTS5 virtual tables.

## Tested, and not tested

- **D1 FTS5:** checked first, in miniflare on 2026-11-12: external-content FTS5 tables with the porter tokenizer, triggers, `MATCH` and `bm25()` work, so keyword search is FTS5 as designed. Not yet checked on a real D1 database.
- **`npm test`: 108 tests** with vitest and the Workers pool (local D1 and the Keeper Durable Object; Workers AI, Vectorize, Turnstile, GitHub, your site and Resend are in-memory fakes, so nothing reaches a Cloudflare account or the internet; the test network refuses any request it wasn't told about). They cover:
  - answering: citations kept only for given sources, links only from D1, low confidence without citations, "I don't know" without a model call, the model's own "can't find it" normalised, cache hit then a docs change costing again, keyword search for error codes, Vectorize down, FTS syntax in questions, follow-ups fenced, API keys with a daily cap, input size limits, the widget script under 15 KB gzipped
  - the budget: full → lean → search as the pool shrinks with no AI call in search, reserves released at 18:00 UTC, a quota error switching to search until 00:00 UTC, 50 back-to-back reservations never passing the hard stop, actual cost settled, `ASK_NEURON_CAP`, the ledger unreachable → search
  - abuse: non-allowed origins, Turnstile solved on another hostname, Turnstile down (503), forged and expired sessions, the 21st question in a session, the 11th in a minute from one IP (429 + `Retry-After`), the global cap, CORS, no raw IPs stored, admin auth
  - ingest: a 50-file GitHub folder into D1 and Vectorize; an unchanged re-run with 0 blob fetches and 0 neurons; one changed section re-embedding one chunk; a deleted file removed only at the end of a complete run; every alarm run within the subrequest budget **with the in-memory state dropped before every run**; failed crawls deleting nothing and retrying at 1 h, 6 h, 1 d; a truncated tree deleting nothing; the ingest pool running out (paused, resumed after 00:00 UTC); AI errors not hot-looping; re-ingest and pause from the app; the corpus cap; mixed embedding models refused; sitemap ownership proof, nav/footer/script stripping, other hosts, `http:`, IP literals, redirects to private addresses and other hosts, non-HTML, ETag 304s, sitemap index depth; uploads (size, `javascript:` and private citation URLs refused)
  - inbox: forward first, trimmed copy, a cited draft with D1 links and a `mailto:`, holding replies without a model call, every skip rule, the daily cap, no `FORWARD_TO` → rejected, HTML-only and quoted-printable mail, approve as copy-only by default, discard deleting the email copy, `INBOX_SEND=resend` sending exactly one threaded reply after approval (and nothing before), one digest an hour with subjects only, quota errors leaving mail queued, the inbox pool
  - prompt injection: a doc telling the model to send users to an evil URL (no link reaches the response), forged `</source>` blocks, a fenced question, no tools ever passed, HTML stripped from output, an injected email that can't cause any send; SSRF rules and redirect hops; retention (30 days, 48 hours for rate rows, expired cache, `RETENTION_DAYS`); the GitHub webhook signature
  - review regressions: a page too big to store flagged `too_large` with the run finishing, a stalled run failing after 5 runs, a stale `running` source re-ingested, a re-ingest requested mid-run kept, 20 discards handled in small batches, only quota wording exhausting the day, degraded and lean answers not cached, feedback rate limits and unguessable ids, `import` lines kept outside MDX, linear HTML stripping on hostile mail, the real sender address, a capped GitHub listing deleting nothing
  - acceptance: a 30 + 10 question test set (≥ 24 cited, ≥ 9 "I don't know", ≥ 7 without a model call) and a simulated example day under 1,500 requests, 2,500 D1 rows and 4,500 neurons. These run against fake bag-of-words embeddings, not bge-small: **`minScore` (0.55) still needs tuning against real embeddings.**
- `npx wrangler deploy --dry-run` bundles the Worker (about 149 KB, 44 KB gzipped); `npm audit` is clean.
- **Not tested on a real Cloudflare account yet** (free, but needs you): deploying with the button; real Workers AI answers and their quality, real bge-small similarity scores (and so `minScore`), whether every model returns token usage, the real wording of the neuron-limit error (matched broadly); Vectorize's eventual consistency right after an ingest; FTS5 on real D1; Turnstile inside a real browser and the widget on real pages; a real GitHub repo and push webhook; Email Routing delivering to the `email()` handler, CPU time for typical Gmail/Outlook/Apple Mail messages on Free, and what Email Routing does if the handler fails after forwarding; `send_email` digests to a verified address; whether D1, Durable Object, AI and Vectorize calls count as subrequests (assumed yes) and whether D1 counts each batched statement against the 50 queries per invocation (assumed yes); real D1 rows written per question; the footprint over a real day.
- **Not tested, because it costs money or needs a paid or card-backed account:** Workers Paid; Workers AI usage past 10,000 neurons and paid-only models; Resend beyond its free plan (*Approve & send* and Resend digests were tested only against a fake); `send_email` to unverified addresses (needs Workers Paid; not used); AI Gateway paid log retention.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Cloudflare, GitHub, Resend, Meta or BAAI.
