// Regressions for the v0.1 review findings (HIGH and MEDIUM, plus the cheap LOWs).
import { describe, it, expect, beforeEach } from "vitest";
import { resetAll, installFakes, seedDocs, DOCS, fakeNet, runAt, runUntilIdle, inKeeper, rows, api, session, ask, call, setNow, NOW, HOUR, MIN, SITE } from "./helpers.js";
import { isQuotaError } from "../src/lib/ai.js";
import { chunkMarkdown } from "../src/lib/chunk.js";
import { stripBlocks, mailHtmlToText, addressOf } from "../src/lib/mailparse.js";
import { listGithub } from "../src/lib/ingest.js";

const TREE = "https://api.github.com/repos/acme/widgetron/git/trees/main?recursive=1";
const BLOB = "https://api.github.com/repos/acme/widgetron/git/blobs/";

function repo(files) {
  const tree = Object.keys(files).map((path, i) => ({ path, type: "blob", sha: `sha${i}-${files[path].length}`, size: files[path].length }));
  const bySha = Object.fromEntries(tree.map((t) => [t.sha, files[t.path]]));
  return {
    [TREE]: { status: 200, body: JSON.stringify({ tree, truncated: false }) },
    [BLOB]: (url) => ({ status: 200, body: bySha[url.slice(BLOB.length)] }),
  };
}

const many = () => Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`docs/p${i}.md`, `# P${i}\n\nPage ${i} text.`]));

describe("review regressions", () => {
  let f;
  beforeEach(async () => {
    await resetAll();
    f = installFakes();
  });

  it("HIGH: a doc with too many chunks is flagged too_large and the run finishes (no livelock)", async () => {
    const huge = `# Huge\n\n${Array.from({ length: 500 }, (_, i) => `## S${i}\n\nSection ${i} text.`).join("\n\n")}`;
    fakeNet(repo({ "docs/huge.md": huge, "docs/ok.md": "# Ok\n\nFine." }));
    const last = await runUntilIdle(NOW, 30);
    expect(await inKeeper((k) => k.load().run)).toBeNull();
    expect((await rows("SELECT status FROM docs WHERE path = 'docs/huge.md'"))[0].status).toBe("too_large");
    expect((await rows("SELECT status FROM docs WHERE path = 'docs/ok.md'"))[0].status).toBe("ok");
    expect((await rows("SELECT status, last_error FROM sources WHERE id = 'gh'"))[0]).toMatchObject({ status: "ok" });
    expect(last.nextAlarm).toBeGreaterThan(NOW + 30 * 1000);
  });

  it("HIGH: a run that stops making progress fails after 5 runs instead of re-arming every second", async () => {
    fakeNet(repo(many()));
    await runAt(NOW); // starts the run
    // Force a phase that can't progress: a queue item whose fetch keeps returning "budget".
    await inKeeper((k) => {
      k.load().run.phase = "docs";
      k.sql.exec("INSERT OR IGNORE INTO queue (path, etag) VALUES ('docs/stuck.md', 'x')");
      k.docsStep = async () => ({ done: false, bytes: 0 });
      return true;
    });
    for (let i = 1; i <= 6 && (await inKeeper((k) => k.load().run)); i++) await runAt(NOW + i * 1000);
    expect(await inKeeper((k) => k.load().run)).toBeNull();
    await inKeeper((k) => delete k.docsStep); // back to the real method for later tests
    expect((await rows("SELECT last_error FROM sources WHERE id = 'gh'"))[0].last_error).toMatch(/no progress/);
  });

  it("MEDIUM: a source left 'running' in D1 with no run in memory is ingested again", async () => {
    await runAt(NOW);
    await inKeeper((k) => {
      k.load().run = null;
      return true;
    });
    await rows("UPDATE sources SET status = 'running', next_at = 0 WHERE id = 'gh'");
    fakeNet(repo({ "docs/a.md": "# A\n\nText." }));
    await runUntilIdle(NOW + MIN);
    expect((await rows("SELECT status FROM sources WHERE id = 'gh'"))[0].status).toBe("ok");
  });

  it("MEDIUM: a re-ingest request during a run survives the run's completion", async () => {
    fakeNet(repo(many()));
    await runAt(NOW); // the run spans several alarm runs
    expect(await inKeeper((k) => Boolean(k.load().run))).toBe(true);
    await rows("UPDATE sources SET next_at = 0 WHERE id = 'gh'"); // as a webhook/upload/re-ingest would
    await runUntilIdle(NOW + 1000);
    expect((await rows("SELECT next_at FROM sources WHERE id = 'gh'"))[0].next_at).toBe(0);
  });

  it("MEDIUM: 20 discards are processed in small batches across runs without failing", async () => {
    await runAt(NOW);
    await rows("UPDATE sources SET paused = 1, status = 'paused'");
    for (let i = 0; i < 20; i++) {
      await rows("INSERT INTO emails (id, received_at, status) VALUES (?, ?, 'drafted')", `e${i}`, NOW);
      await rows("INSERT INTO drafts (id, email_id, created_at, body, confidence, requested_action) VALUES (?, ?, ?, 'b', 'high', 'discard')", `d${i}`, `e${i}`, NOW);
    }
    for (let i = 1; i <= 4; i++) {
      const r = await runAt(NOW + i * 1000);
      expect(r.error).toBeNull();
    }
    expect(await rows("SELECT * FROM drafts")).toHaveLength(0);
    expect(await rows("SELECT * FROM emails")).toHaveLength(0);
  });

  it("MEDIUM: only quota wording exhausts the day; 429s and 'exceeded' count as ordinary errors", () => {
    expect(isQuotaError(new Error("4006: you have used up your daily free allocation of 10,000 neurons"))).toBe(true);
    expect(isQuotaError(new Error("429 Too Many Requests: rate limit"))).toBe(false);
    expect(isQuotaError(new Error("context length exceeded"))).toBe(false);
  });
});

describe("review regressions: answers", () => {
  let f;
  beforeEach(async () => {
    await resetAll();
    f = installFakes();
    await seedDocs(f.vz, DOCS);
  });

  it("MEDIUM: an I-don't-know from degraded retrieval (Vectorize down) isn't cached", async () => {
    const s = await session();
    const q = f.vz.query;
    f.vz.query = async () => {
      throw new Error("down");
    };
    const r1 = await ask("Where is the Start menu entry added by setup?", { sess: s });
    expect(r1.data.mode).toBe("full");
    expect(await rows("SELECT * FROM answer_cache")).toHaveLength(0);
    f.vz.query = q;
    const r2 = await ask("Where is the Start menu entry added by setup?", { sess: s });
    expect(r2.data.mode).not.toBe("cache");
  });

  it("MEDIUM: lean answers aren't cached", async () => {
    await inKeeper((k) => k.setLedger("2026-11-12", { used: 6200 }));
    const r = await ask("How do I install on Windows?", { sess: await session() });
    expect(r.data.mode).toBe("lean");
    expect(await rows("SELECT * FROM answer_cache")).toHaveLength(0);
  });

  it("MEDIUM: feedback is rate limited and ids are unguessable", async () => {
    const s = await session();
    const r = await ask("How do I install on Windows?", { sess: s });
    expect(r.data.id).toMatch(/^q_[A-Za-z0-9_-]{22}$/);
    let last;
    for (let i = 0; i < 12; i++) last = await call("/v1/feedback", { method: "POST", headers: { Origin: SITE, "X-Session": s, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.7" }, body: JSON.stringify({ id: r.data.id, helpful: true }) });
    // The ask itself used 1 of the minute's 10.
    expect(last.status).toBe(429);
  });
});

describe("review regressions: parsing", () => {
  it("MEDIUM: import/export lines are kept in .md and in code fences; stripped only as MDX statements", () => {
    const md = "# Use\n\nimport the file first.\n\n```py\nimport os\nexport_x = 1\n```\n\nexport your data from Settings.";
    const plain = chunkMarkdown(md).map((c) => c.text).join("\n");
    expect(plain).toContain("import the file first");
    expect(plain).toContain("import os");
    const mdx = chunkMarkdown("import X from './x'\n\n# Use\n\n```js\nimport y from 'y'\n```", { mdx: true }).map((c) => c.text).join("\n");
    expect(mdx).not.toContain("./x");
    expect(mdx).toContain("import y from 'y'");
  });

  it("MEDIUM: stripping HTML blocks is linear on hostile mail", () => {
    const evil = "<head".repeat(13000);
    const t0 = Date.now();
    expect(stripBlocks(evil, ["head", "script"]).trim()).toBe("");
    expect(Date.now() - t0).toBeLessThan(200);
    expect(mailHtmlToText("<p>Hi</p><style>x{}</style><blockquote>old</blockquote><p>there</p>").replace(/\s+/g, " ").trim()).toBe("Hi there");
  });

  it("LOW: the real sender is the last <address>", () => {
    expect(addressOf('"<victim@x.com>" <attacker@evil.example>')).toBe("attacker@evil.example");
  });

  it("LOW: a listing capped at 5,000 files counts as truncated (nothing deleted)", async () => {
    const { fakeNet: fn } = await import("./helpers.js");
    const tree = Array.from({ length: 5001 }, (_, i) => ({ path: `docs/p${i}.md`, type: "blob", sha: `s${i}`, size: 10 }));
    fn({ [TREE]: { status: 200, body: JSON.stringify({ tree, truncated: false }) } });
    const r = await listGithub({}, { repo: "acme/widgetron", branch: "main", path: "docs", exts: [".md"] }, null, null);
    expect(r.files).toHaveLength(5000);
    expect(r.truncated).toBe(true);
  });
});

export { HOUR, setNow, api };
