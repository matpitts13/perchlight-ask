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
