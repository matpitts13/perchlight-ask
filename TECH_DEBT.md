# Tech debt

- **SSRF: 6to4 and Teredo IPv6 prefixes aren't refused** (`src/lib/ssrf.js`, copied from perchlight-hooks, which has the same entry). Low risk here: ingest URLs are refused if they're IP literals at all, and must be on an allowlisted host. Found in perchlight-hooks's v0.1 review (2026-11-11).

From the v0.1 review (2026-11-13), LOW, parked:

- **Draft retry-state write errors are swallowed** (`src/keeper.js`, `draftStep` catch). If D1 keeps failing, the email stays `queued` with `next_at <= now`; the run-level backoff (30 s doubling) bounds it, but a per-email guard would be cleaner.
- **Digest drafts are marked `notified` when the digest is queued**, not when it's sent; a permanently failed digest means those drafts are never announced (they're still on the Drafts screen).
- **Embedding cost without `usage`** falls back to the 4-characters-per-token estimate; dense text could undercount by ~30%. Only matters for a first ingest allowed up to the hard stop; bounded by the 500-neuron margin.
- **Opt-out still writes the answer cache row and rate counters** (the question's hash, no text). Consider skipping the cache write under `log:false`/`Sec-GPC`.
- **API keys are hashed with a fixed-key HMAC** (no per-key salt): keys must be high-entropy (`npm run hash-key` makes 192-bit ones). Document in README if keys are ever user-chosen.
- **No throttle on failed admin auth.** Acceptable with a 16+ character token; a WAF rule covers floods.
- **`PUBLIC_URL` empty by default** disables the own-host SSRF check; the per-source host allowlist still blocks it. Mention in README or default to the request origin.
- **`PAUSE_ALARMS=1` is checked in production code** (test hook, as in perchlight-hooks). Gate it on the test hooks.
- **`verifyHosts` turns a subrequest-budget error into `unverified`** (1 h backoff). Only reachable with many hosts in one source.
- **`over_cap` docs are re-fetched every run** (their etag is NULL): wasted subrequests, not a correctness bug.

## From the focused re-review of 578959b (all LOW)

- `src/keeper.js` stale `running` source: a lost run waits a full `every` (the `upload` source waits until the next PUT). Fix: set a short lease (`now + 1h`) at run start and let `completeRun`/`failRun` set the real schedule.
- `src/keeper.js` stall guard: runs where the budget was spent by drafts/purge before ingest did any work still count toward the 5-run stall limit. Don't count runs that broke on the budget guard before any work.
- `src/keeper.js` `MAX_DOC_STATEMENTS` counts deletes of old chunks too, so an edited large doc can go `too_large` and keep stale chunks (only `run.lastDocError` shows it). Document it in the README or count inserts only.
- `src/keeper.js` a re-ingest request made during a run that then fails is overwritten by `failRun`'s back-off `next_at`.
- `src/ask.js` the feedback limiter shares the per-minute `ip:<hash>` key with asks; give feedback its own key.
- `src/mailparse.js` `stripBlocks` lower-cases before slicing; Unicode whose length changes on lower-casing (e.g. `İ`) can misalign indices and garble text.
