import { describe, it, expect, beforeEach } from "vitest";
import { resetAll, installFakes, fakeNet, runAt, runUntilIdle, inKeeper, rows, api, setNow, NOW, HOUR, DAY, MIN, call } from "./helpers.js";
import { utcDay } from "../src/lib/http.js";

const TREE = "https://api.github.com/repos/acme/widgetron/git/trees/main?recursive=1";
const BLOB = "https://api.github.com/repos/acme/widgetron/git/blobs/";

function repo(files) {
  // files: { path: content }; the sha is derived from the content.
  const sha = (c) => {
    let h = 0;
    for (let i = 0; i < c.length; i++) h = (Math.imul(h, 31) + c.charCodeAt(i)) >>> 0;
    return `s${h.toString(16)}`;
  };
  const tree = Object.entries(files).map(([path, c]) => ({ path, type: "blob", sha: sha(c), size: c.length }));
  const bySha = Object.fromEntries(Object.values(files).map((c) => [sha(c), c]));
  return {
    [TREE]: { status: 200, body: JSON.stringify({ sha: "t", tree: [...tree, { path: "docs", type: "tree", sha: "d" }, { path: "src/app.js", type: "blob", sha: "x", size: 10 }], truncated: false }) },
    [BLOB]: (url) => {
      const c = bySha[url.slice(BLOB.length)];
      return c === undefined ? { status: 404 } : { status: 200, body: c };
    },
  };
}

function page(i, extra = "") {
  return `# Page ${i}\n\n## Setup ${i}\n\nThis is page ${i} about topic ${i}. It explains feature number ${i} in plain words.${extra}\n\n## Details ${i}\n\nMore details for page ${i}: settings, options and examples.`;
}

function fifty() {
  return Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`docs/p${String(i).padStart(2, "0")}.md`, page(i)]));
}

const ghOnly = () => rows("UPDATE sources SET paused = 1 WHERE id <> 'gh'");

describe("GitHub ingest", () => {
  let f;
  beforeEach(async () => {
    await resetAll();
    f = installFakes();
  });

  it("50 markdown files -> chunks in D1 and Vectorize; unchanged re-run embeds nothing; one change re-embeds only its chunks; a deletion removes its chunks after a complete run", async () => {
    let files = fifty();
    const calls = fakeNet(repo(files));
    await runUntilIdle(NOW);
    const chunks = await rows("SELECT c.id, c.embedded_at, d.path FROM chunks c JOIN docs d ON d.id = c.doc_id");
    expect(chunks.length).toBe(100); // 2 sections per page
    expect(chunks.every((c) => c.embedded_at)).toBe(true);
    expect(f.vz.store.size).toBe(100);
    expect(calls.filter((c) => c.url.startsWith(BLOB))).toHaveLength(50);
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
    const [src] = await rows("SELECT status, docs, chunks FROM sources WHERE id = 'gh'");
    expect(src).toEqual({ status: "ok", docs: 50, chunks: 100 });
    const [run] = await rows("SELECT status, chunks_embedded, docs_seen FROM ingest_runs");
    expect(run).toEqual({ status: "ok", chunks_embedded: 100, docs_seen: 50 });
    const v1 = (await rows("SELECT v FROM state WHERE k = 'docs_version'"))[0].v;

    // No changes: 0 neurons, no blob fetches, no embeddings.
    const embedsBefore = f.ai.embeddings().length;
    const used = (await inKeeper((k) => k.budget(NOW))).byPool.ingest;
    await rows("UPDATE sources SET next_at = 0 WHERE id = 'gh'");
    const calls2 = fakeNet(repo(files));
    await runUntilIdle(NOW + HOUR);
    expect(calls2.filter((c) => c.url.startsWith(BLOB))).toHaveLength(0);
    expect(f.ai.embeddings().length).toBe(embedsBefore);
    expect((await inKeeper((k) => k.budget(NOW + HOUR))).byPool.ingest).toBe(used);
    expect((await rows("SELECT v FROM state WHERE k = 'docs_version'"))[0].v).toBe(v1);

    // One file changed in one section: only that chunk is re-embedded.
    files = { ...files, "docs/p07.md": page(7).replace("More details for page 7", "Changed details for page 7") };
    await rows("UPDATE sources SET next_at = 0 WHERE id = 'gh'");
    const calls3 = fakeNet(repo(files));
    const e0 = f.ai.embeddings().length;
    await runUntilIdle(NOW + 2 * HOUR);
    expect(calls3.filter((c) => c.url.startsWith(BLOB))).toHaveLength(1);
    const newEmbeds = f.ai.embeddings().slice(e0);
    expect(newEmbeds.reduce((n, c) => n + c.input.text.length, 0)).toBe(1);
    expect(Number((await rows("SELECT v FROM state WHERE k = 'docs_version'"))[0].v)).toBe(Number(v1) + 1);

    // One file deleted: its chunks go from D1 and Vectorize at the end of the run.
    const gone = await rows("SELECT c.id FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE d.path = 'docs/p03.md'");
    delete files["docs/p03.md"];
    await rows("UPDATE sources SET next_at = 0 WHERE id = 'gh'");
    fakeNet(repo(files));
    await runUntilIdle(NOW + 3 * HOUR);
    expect(await rows("SELECT c.id FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE d.path = 'docs/p03.md'")).toHaveLength(0);
    for (const g of gone) expect(f.vz.store.has(g.id)).toBe(false);
    expect((await rows("SELECT deleted_at FROM docs WHERE path = 'docs/p03.md'"))[0].deleted_at).not.toBeNull();
    expect((await rows("SELECT docs FROM sources WHERE id = 'gh'"))[0].docs).toBe(49);
  });

  it("each alarm run stays within the subrequest budget and the state survives eviction between runs", async () => {
    fakeNet(repo(fifty()));
    const { newBudget } = await import("../src/lib/budget.js");
    let t = NOW;
    let runs = 0;
    for (; runs < 60; runs++) {
      setNow(t);
      await inKeeper((k) => k.evict()); // drop memory: everything must come from storage
      const used = await inKeeper(async (k) => {
        const orig = k.d1.bind(k);
        let max = 0;
        k.d1 = async (budget, stmts) => {
          const r = await orig(budget, stmts);
          max = Math.max(max, budget.used);
          return r;
        };
        await k.run(t);
        k.d1 = orig;
        return max;
      });
      expect(used).toBeLessThanOrEqual(newBudget().left);
      const st = await inKeeper((k) => k.load().run);
      if (!st) break;
      t += 1000;
    }
    expect(runs).toBeGreaterThan(1);
    expect((await rows("SELECT COUNT(*) AS n FROM chunks WHERE embedded_at IS NOT NULL"))[0].n).toBe(100);
  });

  it("a failed crawl deletes nothing and retries at 1 h, 6 h, then the normal schedule", async () => {
    fakeNet(repo(fifty()));
    await runUntilIdle(NOW);
    const before = (await rows("SELECT COUNT(*) AS n FROM chunks"))[0].n;
    for (const [i, wait] of [HOUR, 6 * HOUR, DAY].entries()) {
      await rows("UPDATE sources SET next_at = 0 WHERE id = 'gh'");
      fakeNet({ [TREE]: { status: 503 } });
      const t = NOW + (i + 1) * DAY;
      setNow(t);
      await runAt(t);
      const [s] = await rows("SELECT status, fail_count, next_at, last_error FROM sources WHERE id = 'gh'");
      expect(s.status).toBe("failed");
      expect(s.fail_count).toBe(wait === HOUR ? 1 : wait === 6 * HOUR ? 2 : 3);
      expect(s.next_at).toBe(t + wait);
      expect(s.last_error).toContain("503");
    }
    expect((await rows("SELECT COUNT(*) AS n FROM chunks"))[0].n).toBe(before);
  });

  it("a truncated tree deletes nothing", async () => {
    const files = fifty();
    fakeNet(repo(files));
    await runUntilIdle(NOW);
    const r = repo({ "docs/p00.md": files["docs/p00.md"] });
    r[TREE].body = r[TREE].body.replace('"truncated":false', '"truncated":true');
    fakeNet(r);
    await rows("UPDATE sources SET next_at = 0 WHERE id = 'gh'");
    await runUntilIdle(NOW + HOUR);
    expect((await rows("SELECT COUNT(*) AS n FROM docs WHERE deleted_at IS NULL"))[0].n).toBe(50);
  });

  it("pauses when the ingest pool runs out, and resumes after 00:00 UTC", async () => {
    // Docs already exist (not a first ingest), so only the 1,000 ingest reserve is usable.
    await rows("INSERT INTO docs (id, source_id, path, updated_at) VALUES ('old', 'x', 'x', 0)");
    await rows("INSERT INTO chunks (id, doc_id, ordinal, text, tokens, content_hash, embedded_at) VALUES ('oldc', 'old', 0, 'x', 1, 'h', 1)");
    await inKeeper((k) => k.setLedger(utcDay(NOW), { used: 1000, ingest: 1000 }));
    fakeNet(repo(fifty()));
    await runUntilIdle(NOW);
    const [s] = await rows("SELECT status FROM sources WHERE id = 'gh'");
    expect(s.status).toBe("paused_budget");
    expect(f.ai.embeddings()).toHaveLength(0);
    const run = await inKeeper((k) => k.load().run);
    expect(run.pausedUntil).toBeGreaterThan(Date.UTC(2026, 10, 13));
    const [ir] = await rows("SELECT status FROM ingest_runs");
    expect(ir.status).toBe("paused_budget");
    await runUntilIdle(Date.UTC(2026, 10, 13, 0, 2));
    expect((await rows("SELECT status FROM sources WHERE id = 'gh'"))[0].status).toBe("ok");
    expect((await rows("SELECT COUNT(*) AS n FROM chunks WHERE embedded_at IS NULL"))[0].n).toBe(0);
  });

  it("an AI error during embedding doesn't hot-loop", async () => {
    f.ai.embedError = "internal error";
    fakeNet(repo(fifty()));
    const r = await runAt(NOW);
    let report = r;
    for (let i = 0; i < 40 && (await inKeeper((k) => k.load().run)); i++) report = await runAt(NOW + (i + 1) * 1000);
    const [s] = await rows("SELECT status, next_at FROM sources WHERE id = 'gh'");
    expect(s.status).toBe("failed");
    expect(s.next_at).toBeGreaterThanOrEqual(NOW + HOUR - 10_000);
    expect(report.nextAlarm).toBeGreaterThan(NOW + 30_000);
  });

  it("re-ingest now and pause through requested actions", async () => {
    fakeNet(repo(fifty()));
    await runUntilIdle(NOW);
    expect((await api("POST", "sources/gh/reingest")).status).toBe(202);
    await runAt(NOW + MIN);
    expect((await rows("SELECT requested_action FROM sources WHERE id = 'gh'"))[0].requested_action).toBeNull();
    expect((await rows("SELECT COUNT(*) AS n FROM ingest_runs"))[0].n).toBe(2);
    await runUntilIdle(NOW + 2 * MIN);
    expect((await api("POST", "sources/gh/pause")).status).toBe(202);
    await runAt(NOW + 3 * MIN);
    expect((await rows("SELECT paused, status FROM sources WHERE id = 'gh'"))[0]).toEqual({ paused: 1, status: "paused" });
    expect((await api("POST", "sources/nope/pause")).status).toBe(404);
  });

  it("refuses to mix embedding models in one index, and says what to do", async () => {
    await rows("INSERT INTO state (k, v) VALUES ('embed_model', '@cf/baai/bge-m3')");
    fakeNet(repo(fifty()));
    await runUntilIdle(NOW);
    const [s] = await rows("SELECT status, last_error FROM sources WHERE id = 'gh'");
    expect(s.status).toBe("failed");
    expect(s.last_error).toMatch(/new index/);
    expect(f.ai.embeddings()).toHaveLength(0);
    expect((await api("GET", "settings")).data.embedModelWarning).toMatch(/bge-m3/);
  });

  it("caps the corpus at maxCorpusTokens and flags the rest", async () => {
    const { checkConfig } = await import("../src/lib/config.js");
    expect(checkConfig({ maxCorpusTokens: 5 }).maxCorpusTokens).toBe(5);
    // Simulate a nearly full corpus.
    await rows("INSERT INTO docs (id, source_id, path, tokens, status, updated_at) VALUES ('big', 'x', 'x', 1499990, 'ok', 0)");
    fakeNet(repo(fifty()));
    await runUntilIdle(NOW);
    expect((await rows("SELECT COUNT(*) AS n FROM docs WHERE status = 'over_cap'"))[0].n).toBe(50);
    expect((await rows("SELECT last_error FROM sources WHERE id = 'gh'"))[0].last_error).toMatch(/maxCorpusTokens/);
  });
});

describe("sitemap ingest (your own content only)", () => {
  let f;
  beforeEach(async () => {
    await resetAll();
    f = installFakes();
    await runAt(NOW); // sync sources
    await rows("UPDATE sources SET paused = CASE WHEN id = 'site' THEN 0 ELSE 1 END, status = 'new', next_at = 0");
  });

  const html = (t, body) => ({ status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ETag: `"${t}"` }, body: `<html><head><title>${t}</title></head><body><nav>Menu Home Pricing</nav><main><h1>${t}</h1><p>${body}</p><script>evil()</script></main><footer>Copyright</footer></body></html>` });
  const sitemap = (urls) => ({ status: 200, headers: { "Content-Type": "application/xml" }, body: `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>` });

  it("refuses a host without the proof file", async () => {
    const calls = fakeNet({ "https://docs.example.com/.well-known/perchlight-ask.txt": { status: 404 }, "https://docs.example.com/sitemap.xml": sitemap(["https://docs.example.com/a"]) });
    await runAt(NOW + 1000);
    const [s] = await rows("SELECT status, last_error FROM sources WHERE id = 'site'");
    expect(s.status).toBe("unverified");
    expect(s.last_error).toMatch(/SITE_PROOF/);
    expect(calls.some((c) => c.url.includes("sitemap.xml"))).toBe(false);
  });

  it("crawls pages on the proven host, drops nav/footer/scripts, refuses other hosts, private redirects and http:", async () => {
    const calls = fakeNet({
      "https://docs.example.com/.well-known/perchlight-ask.txt": { status: 200, body: "proof-0123456789abcdef\n" },
      "https://docs.example.com/sitemap.xml": sitemap(["https://docs.example.com/a", "https://docs.example.com/redir-private", "https://docs.example.com/redir-other", "https://evil.example/x", "http://docs.example.com/plain", "https://127.0.0.1/x", "https://docs.example.com/pdf"]),
      "https://docs.example.com/a": html("Alpha", "Alpha explains the alpha feature in detail."),
      "https://docs.example.com/redir-private": { status: 302, headers: { Location: "https://10.0.0.5/admin" } },
      "https://docs.example.com/redir-other": { status: 301, headers: { Location: "https://other.example/page" } },
      "https://docs.example.com/pdf": { status: 200, headers: { "Content-Type": "application/pdf" }, body: "%PDF" },
    });
    await runUntilIdle(NOW + 1000);
    expect(calls.some((c) => c.url.startsWith("https://evil.example") || c.url.startsWith("http:") || c.url.includes("127.0.0.1") || c.url.includes("10.0.0.5") || c.url.includes("other.example"))).toBe(false);
    const docs = await rows("SELECT path, title, url FROM docs WHERE source_id = 'site' AND status = 'ok'");
    expect(docs).toEqual([{ path: "https://docs.example.com/a", title: "Alpha", url: "https://docs.example.com/a" }]);
    const [c] = await rows("SELECT text, heading_path FROM chunks");
    expect(c.heading_path).toBe("Alpha");
    expect(c.text).toContain("alpha feature");
    expect(c.text).not.toMatch(/Menu|Copyright|evil/);
    const [s] = await rows("SELECT status, last_error, verified_at FROM sources WHERE id = 'site'");
    expect(s.status).toBe("ok");
    expect(s.verified_at).not.toBeNull();
    expect(s.last_error).toMatch(/page\(s\) failed/);

    // Re-crawl: a 304 (ETag) costs no embedding.
    const e0 = f.ai.embeddings().length;
    await rows("UPDATE sources SET next_at = 0 WHERE id = 'site'");
    const calls2 = fakeNet({
      "https://docs.example.com/.well-known/perchlight-ask.txt": { status: 200, body: "proof-0123456789abcdef" },
      "https://docs.example.com/sitemap.xml": sitemap(["https://docs.example.com/a"]),
      "https://docs.example.com/a": (url, init) => (new Headers(init.headers).get("If-None-Match") === '"Alpha"' ? { status: 304 } : html("Alpha", "changed")),
    });
    await runUntilIdle(NOW + HOUR);
    expect(f.ai.embeddings().length).toBe(e0);
    expect(calls2.find((c) => c.url === "https://docs.example.com/a").headers.get("If-None-Match")).toBe('"Alpha"');
  });

  it("a sitemap index is followed up to 2 levels", async () => {
    fakeNet({
      "https://docs.example.com/.well-known/perchlight-ask.txt": { status: 200, body: "proof-0123456789abcdef" },
      "https://docs.example.com/sitemap.xml": { status: 200, body: "<sitemapindex><sitemap><loc>https://docs.example.com/s1.xml</loc></sitemap></sitemapindex>" },
      "https://docs.example.com/s1.xml": { status: 200, body: "<sitemapindex><sitemap><loc>https://docs.example.com/s2.xml</loc></sitemap></sitemapindex>" },
      "https://docs.example.com/s2.xml": { status: 200, body: "<sitemapindex><sitemap><loc>https://docs.example.com/s3.xml</loc></sitemap></sitemapindex>" },
      "https://docs.example.com/s3.xml": () => {
        throw new Error("level 3 must not be fetched");
      },
    });
    await runUntilIdle(NOW + 1000);
    expect((await rows("SELECT status FROM sources WHERE id = 'site'"))[0].status).toBe("ok");
  });
});

describe("uploads", () => {
  let f;
  beforeEach(async () => {
    await resetAll();
    f = installFakes();
    await runAt(NOW);
    await rows("UPDATE sources SET paused = 1");
  });

  it("PUT /api/docs/:slug ingests markdown; DELETE removes it at the end of the next run", async () => {
    const put = await api("PUT", "docs/getting-started", { markdown: "# Getting started\n\nCreate a project with widgetron new.", url: "https://docs.example.com/start" });
    expect(put.status).toBe(202);
    await runUntilIdle(NOW + 1000);
    const [d] = await rows("SELECT title, url, status FROM docs WHERE source_id = 'upload'");
    expect(d).toEqual({ title: "Getting started", url: "https://docs.example.com/start", status: "ok" });
    expect(f.vz.store.size).toBe(1);
    expect((await api("PUT", "docs/x", { markdown: "hi", url: "javascript:alert(1)" })).status).toBe(400);
    expect((await api("PUT", "docs/x", { markdown: "hi", url: "http://10.0.0.1/" })).status).toBe(400);
    expect((await api("PUT", "docs/Bad Slug", { markdown: "hi" })).status).toBe(404);
    const big = await call("/api/docs/big", { method: "PUT", headers: { Authorization: "Bearer test-admin-token-0123456789", "Content-Type": "application/json" }, body: JSON.stringify({ markdown: "x".repeat(1024 * 1024 + 10) }) });
    expect(big.status).toBe(413);
    expect((await api("DELETE", "docs/getting-started")).status).toBe(202);
    await runUntilIdle(NOW + 2000);
    expect(await rows("SELECT * FROM chunks")).toHaveLength(0);
    expect(f.vz.store.size).toBe(0);
  });
});

describe("config sync", () => {
  beforeEach(async () => {
    await resetAll();
    installFakes();
  });
  it("creates sources from ask.json and marks bad ones", async () => {
    const { checkConfig } = await import("../src/lib/config.js");
    const c = checkConfig({ sources: [{ id: "a", kind: "sitemap", sitemap: "http://x.example/s.xml", hosts: ["x.example"] }, { id: "b", kind: "sitemap", sitemap: "https://x.example/s.xml", hosts: ["10.0.0.1"] }, { id: "c", kind: "github", repo: "../etc" }, { id: "d", kind: "ftp" }] });
    expect(c.sources.map((s) => Boolean(s.error))).toEqual([true, true, true, true]);
    await runAt(NOW);
    const s = await rows("SELECT id, paused FROM sources ORDER BY id");
    expect(s).toEqual([
      { id: "gh", paused: 0 },
      { id: "site", paused: 1 },
    ]);
  });
  it("wrangler.jsonc has no cron trigger", async () => {
    // Read at build time by the test: the file is plain text in the repo.
    const { WRANGLER_TEXT } = await import("./wrangler-text.js");
    expect(WRANGLER_TEXT).not.toMatch(/"triggers"|"crons"/);
  });
});
