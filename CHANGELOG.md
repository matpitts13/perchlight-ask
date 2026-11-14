# Changelog

## v0.1.0

The first release of perchlight-ask: a free, self-hosted ask-the-docs widget and AI support inbox on your own Cloudflare account (Workers + Workers AI + Vectorize + D1 + one Durable Object).

**Set up in one click** with the Deploy to Cloudflare button in the [README](https://github.com/matpitts13/perchlight-ask#readme), or by hand with `npm run deploy`.

### What's in it

- **Ask the docs:** an embeddable widget (one script tag, Turnstile-protected) and a JSON API. Answers quote only your docs and link to the pages they came from.
- **"I don't know" instead of guessing:** when no doc clearly matches, it says so without calling the model and lists the closest pages.
- **Meaning search plus keyword search:** Vectorize finds matches by meaning, and a D1 full-text index catches exact terms. The keyword index is also the free fallback.
- **A hard daily AI budget:** it stops at 9,500 of the free 10,000 neurons and then keeps working as a plain docs search until midnight UTC.
- **Prompt-injection resistant:** docs and emails are treated as untrusted data, and answers have no tools and can only cite your own pages.
- **Support inbox (optional):** mail arriving through Email Routing is forwarded to you first, then a draft reply is written from the docs for you to edit, copy or discard. It never sends on its own.
- **Docs from a GitHub folder, a sitemap on a site you've verified, or uploaded Markdown,** re-ingested on a Durable Object alarm (no cron trigger).
- **Logs** with an opt-out and a retention period, a report of unanswered questions, and screens for the [Perchlight](https://github.com/matpitts13/perchlight) desktop app.

### Free-plan capacity

About 350 cited answers a day (up to about 475 when the inbox and ingest reserves go unused), plus about 50 email drafts. Docs can be up to roughly 1,000–2,000 pages.

### Tested, and not tested

108 automated tests run against a real local D1 and Durable Object. Workers AI, Vectorize, Turnstile, GitHub and Resend are faked.

Not tested: real answer quality and the match threshold against real embeddings, D1 full-text search on a real database, Turnstile and the widget in a real browser, Email Routing delivery and its CPU use on the Free plan, and real Resend sending (off by default).
