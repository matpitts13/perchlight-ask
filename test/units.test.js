import { describe, it, expect, beforeEach } from "vitest";
import { chunkMarkdown, sections, titleOf } from "../src/lib/chunk.js";
import { htmlToText } from "../src/lib/html.js";
import { available, questionMode, emptyDay, genNeurons } from "../src/lib/ledger.js";
import { MODELS } from "../src/lib/config.js";
import { normalizeQuestion, redact, coverage, terms } from "../src/lib/text.js";
import { skipReason, addressOf } from "../src/lib/mailparse.js";
import { rrf } from "../src/lib/retrieve.js";
import { resetAll, installFakes, seedDocs, session, ask, rows, api, setNow, NOW } from "./helpers.js";
import { utcDay } from "../src/lib/http.js";

const B = { hardStop: 9500, inboxReserve: 1500, ingestReserve: 1000, releaseHourUtc: 18, leanBelow: 1000, searchBelow: 100 };

describe("chunking", () => {
  it("splits at headings and keeps the heading path", () => {
    const c = chunkMarkdown("# Install\n\nIntro.\n\n## Windows\n\nRun setup.\n\n### Troubleshooting\n\nReboot.\n\n## Mac\n\nDrag it.");
    expect(c.map((x) => x.headingPath)).toEqual(["Install", "Install › Windows", "Install › Windows › Troubleshooting", "Install › Mac"]);
  });
  it("keeps chunks near 300-400 tokens with overlap, and small code blocks whole", () => {
    const para = (i) => `Paragraph ${i}. ${"word ".repeat(60)}`;
    const code = "```js\n" + "const x = 1;\n".repeat(40) + "```";
    const md = `# Long\n\n${Array.from({ length: 12 }, (_, i) => para(i)).join("\n\n")}\n\n${code}\n\n${para(99)}`;
    const c = chunkMarkdown(md);
    expect(c.length).toBeGreaterThan(2);
    for (const x of c) expect(x.tokens).toBeLessThanOrEqual(420);
    expect(c.some((x) => x.text.includes(code))).toBe(true);
    // Overlap: the start of chunk 2 repeats the end of chunk 1.
    expect(c[0].text.slice(-80).split(" ").filter(Boolean).some((w) => c[1].text.startsWith(w) || c[1].text.slice(0, 300).includes(w))).toBe(true);
  });
  it("ignores headings inside code fences and front matter", () => {
    const s = sections("---\ntitle: x\n---\n# Real\n\n```\n# not a heading\n```\n");
    expect(s).toHaveLength(1);
    expect(s[0].path).toEqual(["Real"]);
    expect(titleOf("---\ntitle: x\n---\n# Hello *world*", "a.md")).toBe("Hello world");
    expect(titleOf("no heading", "docs/getting-started.md")).toBe("getting started");
  });
});

describe("HTML to text", () => {
  it("prefers main, drops chrome, keeps headings and code", async () => {
    const r = await htmlToText(`<html><head><title>T &amp; U</title><style>.x{}</style></head><body><header>Site</header><nav>Menu</nav><main><h2>Setup</h2><p>Use <code>npm i</code> &mdash; done. ${"filler ".repeat(40)}</p><pre><code>line1\nline2</code></pre></main><aside>ads</aside><footer>(c)</footer><script>x()</script></body></html>`);
    expect(r.title).toBe("T & U");
    expect(r.text).toContain("## Setup");
    expect(r.text).toContain("`npm i` — done");
    expect(r.text).toContain("```\nline1\nline2\n```");
    expect(r.text).not.toMatch(/Site|Menu|ads|\(c\)|x\(\)/);
  });
});

describe("ledger", () => {
  const at9 = Date.UTC(2026, 10, 12, 9);
  const at19 = Date.UTC(2026, 10, 12, 19);
  it("holds reserves until 18:00 UTC", () => {
    expect(available(emptyDay("d"), B, at9).questions).toBe(7000);
    expect(available(emptyDay("d"), B, at19).questions).toBe(9500);
  });
  it("modes by pool left and estimate", () => {
    const est = { full: 20, lean: 12 };
    expect(questionMode(1000, est, B)).toBe("full");
    expect(questionMode(999, est, B)).toBe("lean");
    expect(questionMode(100, est, B)).toBe("lean");
    expect(questionMode(99, est, B)).toBe("search");
  });
  it("inbox and ingest check only their pools and the hard stop; first ingest may use questions'", () => {
    const d = { ...emptyDay("d"), used: 9000, inbox: 1400 };
    const a = available(d, B, at9);
    expect(a.inbox).toBe(100);
    expect(a.ingest).toBe(500);
    expect(available(emptyDay("d"), B, at9, { firstIngest: true }).ingest).toBe(8000);
    expect(available({ ...emptyDay("d"), exhausted: true }, B, at9)).toEqual({ questions: 0, inbox: 0, ingest: 0, hardLeft: 0 });
  });
  it("an answer is budgeted near 20 neurons, as the SDD works out", () => {
    const n = genNeurons(MODELS["@cf/meta/llama-3.1-8b-instruct-fp8-fast"], 2000, 300);
    expect(n).toBeGreaterThan(18);
    expect(n).toBeLessThan(20);
  });
});

describe("text helpers", () => {
  it("normalises questions for the cache", () => {
    expect(normalizeQuestion("  How   do I Install?? ")).toBe("how do i install");
  });
  it("redacts long digit runs but keeps short numbers", () => {
    expect(redact("order 12345678 version 2.1")).toBe("order [number] version 2.1");
  });
  it("coverage and rrf", () => {
    expect(coverage(terms("licence expired E42"), "Error code E42 means your licence key expired.")).toBe(1);
    expect(rrf([["a", "b"], ["b", "c"]])[0]).toBe("b");
  });
  it("mail skip rules and addresses", () => {
    expect(addressOf('"Bob" <BOB@Example.com>')).toBe("bob@example.com");
    expect(skipReason(new Map([["auto-submitted", "no"]]), "a@b.example", [])).toBeNull();
    expect(skipReason(new Map(), "do-not-reply@b.example", [])).toMatch(/no-reply/);
  });
});

// A small test set (acceptance criterion, run against the fake bag-of-words
// embeddings; real bge-small thresholds still need tuning on a real account).
const SET_DOCS = [
  ["install", "Install", "# Install\n\n## Windows\n\nDownload the installer and run setup.exe. It adds a Start menu entry.\n\n## Mac\n\nDrag the app into Applications and open it.\n\n## Linux\n\nInstall the deb package with apt install ./widgetron.deb."],
  ["licence", "Licence", "# Licence\n\n## Activate\n\nPaste your licence key under Settings, Licence, Activate.\n\n## Transfer\n\nDeactivate the licence on the old computer first, then activate it on the new one.\n\n## Expired\n\nError E42 means the licence expired; renew it from your account page."],
  ["sync", "Sync", "# Sync\n\n## Turn on sync\n\nOpen Settings, Sync and sign in with your account.\n\n## Conflicts\n\nWhen two devices edit the same note, both versions are kept as a conflict copy.\n\n## Offline\n\nChanges made offline sync when the connection returns. Error E7 means the sync server is unreachable."],
  ["export", "Export", "# Export\n\n## PDF\n\nChoose File, Export, PDF to save a note as a PDF.\n\n## Markdown\n\nChoose File, Export, Markdown to save plain markdown files.\n\n## Backup\n\nSettings, Backup makes a zip of all notes every day."],
  ["billing", "Billing", "# Billing\n\n## Price\n\nWidgetron costs 5 dollars a month or 50 dollars a year.\n\n## Cancel\n\nCancel your subscription from the billing page; it ends at the end of the period.\n\n## Invoices\n\nInvoices are emailed each month and listed on the billing page."],
];
const KNOWN = [
  "How do I install on Windows?", "How do I install on Mac?", "How do I install on Linux?", "Where do I paste my licence key?", "How do I transfer my licence to a new computer?",
  "What does error E42 mean?", "How do I turn on sync?", "What happens with sync conflicts?", "Do offline changes sync?", "What does E7 mean?",
  "How do I export a PDF?", "How do I export markdown?", "How do backups work?", "How much does Widgetron cost?", "How do I cancel my subscription?",
  "Where are my invoices?", "Run setup.exe for Windows install?", "Activate licence where?", "Licence expired error", "Sync server unreachable",
  "Export note as PDF", "Zip backup of notes", "Yearly price", "Billing page cancel", "Deb package apt install",
  "Applications folder Mac", "Conflict copy two devices", "Deactivate licence old computer", "Markdown files export", "Invoices emailed monthly",
];
const UNKNOWN = ["What is the capital of Mongolia?", "Who won the 1998 World Cup?", "Recipe for banana bread", "How tall is Mount Everest?", "Translate hello into Japanese", "What is quantum chromodynamics?", "Best hiking boots for winter", "How do volcanoes form?", "Stock price of ACME corp", "Write me a poem about cats"];

describe("acceptance: test set", () => {
  let f;
  beforeEach(async () => {
    await resetAll();
    f = installFakes();
    await seedDocs(f.vz, SET_DOCS.map(([p, t, md]) => ({ path: `docs/${p}.md`, title: t, url: `https://docs.example.com/${p}`, markdown: md })));
    // A model that cites the first source, as a good answer would.
    f.ai.reply = () => "Here is how [1].";
  });

  it(">= 24 of 30 covered questions get cited answers; >= 9 of 10 uncovered get I don't know, >= 7 without a model call", async () => {
    let cited = 0;
    let t = NOW;
    for (const q of KNOWN) {
      t += 7000;
      setNow(t);
      const r = await ask(q, { sess: await session(), ip: `198.51.100.${(t / 7000) % 250 | 0}` });
      if (r.data.confidence === "high" && r.data.sources.length) cited++;
    }
    expect(cited).toBeGreaterThanOrEqual(24);
    let idk = 0;
    let noModel = 0;
    for (const q of UNKNOWN) {
      t += 7000;
      setNow(t);
      const before = f.ai.generations().length;
      const r = await ask(q, { sess: await session(), ip: `203.0.113.${(t / 7000) % 250 | 0}` });
      if (r.data.confidence === "none") idk++;
      if (r.data.confidence === "none" && f.ai.generations().length === before) noModel++;
    }
    expect(idk).toBeGreaterThanOrEqual(9);
    expect(noModel).toBeGreaterThanOrEqual(7);
  });
});

describe("acceptance: footprint of a simulated day", () => {
  it("300 questions (150 answered, 100 cached, 50 search) stay under 1,500 requests, 2,500 D1 rows and 4,500 neurons", async () => {
    await resetAll();
    const f = installFakes();
    await seedDocs(f.vz, SET_DOCS.map(([p, t, md]) => ({ path: `docs/${p}.md`, title: t, url: `https://docs.example.com/${p}`, markdown: md })));
    f.ai.reply = () => "Here is how [1].";
    let t = NOW;
    const go = async (q, i) => {
      t += 7000;
      setNow(t);
      return ask(q, { sess: await session(), ip: `198.51.${(i / 200) | 0}.${i % 200}` });
    };
    let i = 0;
    for (; i < 150; i++) await go(`${KNOWN[i % 30]} (variant ${i})`, i);
    for (let j = 0; j < 100; j++, i++) await go(`${KNOWN[j % 30]} (variant ${j})`, i); // repeats -> cache
    const { inKeeper } = await import("./helpers.js");
    await inKeeper((k) => k.setLedger(utcDay(NOW), { used: 9450 }));
    for (let j = 0; j < 50; j++, i++) await go(`${KNOWN[j % 30]} search ${j}`, i);
    await go("Billing?", i++); // flushes the isolate counters
    const fp = await api("GET", "footprint");
    const day = fp.data.today;
    expect(day.counters.cached).toBe(100);
    expect(day.counters.search).toBeGreaterThanOrEqual(50);
    expect(day.workerRequests).toBeLessThan(1500);
    // Widget sessions (300 here, one per question in this simulation) aren't D1 writes.
    expect(day.d1RowsWritten).toBeLessThan(2500);
    const real = (await rows("SELECT COUNT(*) AS n FROM asks"))[0].n + (await rows("SELECT COUNT(*) AS n FROM answer_cache"))[0].n;
    expect(real).toBeGreaterThan(0);
    // Neurons we spent ourselves (the 9,450 was set by the test).
    const asked = (await rows("SELECT SUM(neurons) AS n FROM asks"))[0].n;
    expect(asked).toBeLessThan(4500);
  }, 120_000);
});
