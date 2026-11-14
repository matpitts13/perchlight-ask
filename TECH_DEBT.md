# Tech debt

- **SSRF: 6to4 and Teredo IPv6 prefixes aren't refused** (`src/lib/ssrf.js`, copied from perchlight-hooks, which has the same entry). Low risk here: ingest URLs are refused if they're IP literals at all, and must be on an allowlisted host. Found in perchlight-hooks's v0.1 review (2026-11-11).
