import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { resetAll, installFakes, seedDocs, DOCS, runAt, rows, api, worker, fakeNet, setNow, NOW, HOUR, DAY, MIN, inKeeper } from "./helpers.js";
import { parseMail, cutQuoted } from "../src/lib/mailparse.js";

function rawMail({ from = "Customer <cust@buyer.example>", subject = "How do I install on Windows?", body = "Hi, how do I install Widgetron on Windows? Thanks", headers = {}, html = false } = {}) {
  const h = { From: from, To: "support@example.com", Subject: subject, "Message-ID": "<m1@buyer.example>", ...headers };
  const head = Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n");
  if (html) return `${head}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>${body}</p><blockquote>old</blockquote>\r\n--b1--\r\n`;
  return `${head}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
}

function message(raw, { to = "support@example.com" } = {}) {
  const bytes = new TextEncoder().encode(raw);
  const [head] = raw.split("\r\n\r\n");
  const headers = new Headers();
  for (const l of head.split("\r\n")) {
    const i = l.indexOf(":");
    if (i > 0) headers.append(l.slice(0, i), l.slice(i + 1).trim());
  }
  const m = {
    from: "cust@buyer.example",
    to,
    headers,
    rawSize: bytes.length,
    raw: new Response(bytes).body,
    forwarded: [],
    rejected: null,
    async forward(addr) {
      m.forwarded.push(addr);
    },
    setReject(r) {
      m.rejected = r;
    },
  };
  return m;
}

async function deliver(m, overrides = {}) {
  const ctx = createExecutionContext();
  const { testHooks } = await import("../src/lib/appctx.js");
  await worker.email(m, { ...env, ...(testHooks.env ?? {}), ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return m;
}

describe("inbox mode", () => {
  let f;
  beforeEach(async () => {
    await resetAll();
    f = installFakes();
    await seedDocs(f.vz, DOCS);
    await runAt(NOW); // sync sources; pause them so ingest stays out of the way
    await rows("UPDATE sources SET paused = 1, status = 'paused'");
  });

  it("forwards first, stores a trimmed copy, drafts in the next alarm run, and sends nothing to the customer", async () => {
    f.ai.reply = () => "Thanks for asking! Download the installer and run setup.exe [1].\n\n— The Example team";
    const m = await deliver(message(rawMail()));
    expect(m.forwarded).toEqual(["owner@example.com"]);
    const [e] = await rows("SELECT status, from_addr, subject, body FROM emails");
    expect(e).toMatchObject({ status: "queued", from_addr: "cust@buyer.example", subject: "How do I install on Windows?" });
    const r = await runAt(NOW + MIN);
    expect(r.drafted).toBe(1);
    const [d] = await rows("SELECT body, confidence, needs_you, status, sources, mailto FROM drafts");
    expect(d.status).toBe("new");
    expect(d.confidence).toBe("high");
    expect(d.needs_you).toBe(0);
    expect(d.body).toContain("Sources:\n[1] Install: https://docs.example.com/install");
    expect(d.mailto).toMatch(/^mailto:cust%40buyer\.example\?subject=Re%3A%20How/);
    expect((await rows("SELECT status FROM emails"))[0].status).toBe("drafted");
    // The draft prompt carries the email as fenced data.
    const user = f.ai.generations()[0].input.messages[1].content;
    expect(user).toContain("<email>");
    // Nothing went to the customer (the only mail is the owner digest, through send_email to FORWARD_TO).
    const digests = await rows("SELECT kind, channel, status, body FROM deliveries");
    expect(digests.every((x) => x.kind === "digest")).toBe(true);
  });

  it("a weak match gets a holding reply without a model call, marked needs-you", async () => {
    await deliver(message(rawMail({ subject: "Partnership", body: "We would like to discuss a reseller partnership in Mongolia." })));
    await runAt(NOW + MIN);
    const [d] = await rows("SELECT body, confidence, needs_you FROM drafts");
    expect(d.confidence).toBe("none");
    expect(d.needs_you).toBe(1);
    expect(d.body).toMatch(/looking into this/);
    expect(f.ai.generations()).toHaveLength(0);
  });

  it("skips auto-replies, lists, bounces, no-reply and own addresses, and records why", async () => {
    await deliver(message(rawMail({ headers: { "Auto-Submitted": "auto-replied" } })));
    await deliver(message(rawMail({ headers: { "List-Id": "<news.example>" } })));
    await deliver(message(rawMail({ headers: { Precedence: "bulk" } })));
    await deliver(message(rawMail({ from: "MAILER-DAEMON@mx.example" })));
    await deliver(message(rawMail({ from: "noreply@shop.example" })));
    await deliver(message(rawMail({ from: "Owner <owner@example.com>" })));
    const e = await rows("SELECT status, skip_reason, body FROM emails ORDER BY id");
    expect(e.map((x) => x.status)).toEqual(Array(6).fill("skipped"));
    expect(e[0].skip_reason).toMatch(/Auto-Submitted/);
    expect(e.every((x) => x.body === "")).toBe(true);
    await runAt(NOW + MIN);
    expect(await rows("SELECT * FROM drafts")).toHaveLength(0);
  });

  it("stops drafting past the daily inbox cap", async () => {
    for (let i = 0; i < 7; i++) await deliver(message(rawMail({ subject: `Q${i}` })));
    const e = await rows("SELECT status FROM emails");
    expect(e.filter((x) => x.status === "queued")).toHaveLength(5);
    expect(e.filter((x) => x.status === "skipped")).toHaveLength(2);
  });

  it("without FORWARD_TO the mail is refused, not lost; with inbox off it's only forwarded", async () => {
    const m = await deliver(message(rawMail()), { FORWARD_TO: "" });
    expect(m.rejected).toBeTruthy();
    expect(m.forwarded).toEqual([]);
  });

  it("stores HTML-only mail as text and cuts quoted history", async () => {
    await deliver(message(rawMail({ html: true, body: "How do I <b>install</b> on Windows?" })));
    const [e] = await rows("SELECT body FROM emails");
    expect(e.body).toBe("How do I install on Windows?");
    expect(cutQuoted("Thanks!\n\nOn Mon, 1 Jan 2026, Bob wrote:\n> old stuff")).toBe("Thanks!");
    const p = parseMail("Subject: =?UTF-8?B?w6l0w6k=?=\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9 =\r\nlatte");
    expect(p.subject).toBe("été");
    expect(p.body).toBe("Café latte");
  });

  it("approve keeps it a copy/mailto flow by default; discard deletes the draft and the email copy", async () => {
    await deliver(message(rawMail()));
    await runAt(NOW + MIN);
    const [d] = await rows("SELECT id FROM drafts");
    expect((await api("POST", `drafts/${d.id}/approve`)).data.sends).toBe(false);
    await runAt(NOW + 2 * MIN);
    expect((await rows("SELECT status FROM drafts"))[0].status).toBe("approved");
    expect(await rows("SELECT * FROM deliveries WHERE kind = 'reply'")).toHaveLength(0);
    expect((await api("POST", `drafts/${d.id}/discard`)).status).toBe(202);
    await runAt(NOW + 3 * MIN);
    expect(await rows("SELECT * FROM drafts")).toHaveLength(0);
    expect(await rows("SELECT * FROM emails")).toHaveLength(0);
  });

  it("with INBOX_SEND=resend, an approved draft is sent through Resend with threading headers, once", async () => {
    await resetAll();
    f = installFakes({ env: { INBOX_SEND: "resend", RESEND_API_KEY: "re_test_key" } });
    await seedDocs(f.vz, DOCS);
    await runAt(NOW);
    await rows("UPDATE sources SET paused = 1, status = 'paused'");
    await deliver(message(rawMail()));
    await runAt(NOW + MIN);
    const [d] = await rows("SELECT id FROM drafts");
    // Nothing is sent before approval.
    const calls = fakeNet({ "https://api.resend.com/emails": { status: 200, body: '{"id":"re_1"}' } });
    await runAt(NOW + 2 * MIN);
    expect(calls).toHaveLength(0);
    await rows("UPDATE drafts SET requested_action = 'approve' WHERE id = ?", d.id);
    await runAt(NOW + 3 * MIN);
    await runAt(NOW + 4 * MIN);
    const sends = calls.filter((c) => c.url === "https://api.resend.com/emails");
    expect(sends).toHaveLength(1);
    const payload = JSON.parse(sends[0].body);
    expect(payload.to).toEqual(["cust@buyer.example"]);
    expect(payload.headers["In-Reply-To"]).toBe("<m1@buyer.example>");
    expect(sends[0].headers.get("Idempotency-Key")).toMatch(/^dl_/);
    expect((await rows("SELECT status FROM drafts"))[0].status).toBe("sent");
  });

  it("sends one owner digest an hour through send_email, with subjects only", async () => {
    const mail = installFakes();
    await seedDocs(mail.vz, DOCS);
    await deliver(message(rawMail({ body: "My secret account number is 99" })));
    await runAt(NOW + MIN);
    await runAt(NOW + 2 * MIN);
    const [dl] = await rows("SELECT kind, channel, status, body FROM deliveries");
    expect(dl).toMatchObject({ kind: "digest", channel: "send_email", status: "sent" });
    expect(dl.body).toContain("How do I install on Windows?");
    expect(dl.body).not.toContain("secret account");
    expect(mail.mail.sent).toHaveLength(1);
    await deliver(message(rawMail({ subject: "Second" })));
    await runAt(NOW + 3 * MIN);
    await runAt(NOW + 4 * MIN);
    expect(mail.mail.sent).toHaveLength(1); // within the hour
    setNow(NOW + 2 * HOUR);
    await runAt(NOW + 2 * HOUR);
    await runAt(NOW + 2 * HOUR + 1000);
    expect(mail.mail.sent).toHaveLength(2);
  });

  it("a quota error while drafting leaves the email queued until tomorrow", async () => {
    f.ai.reply = () => {
      throw new Error("daily free allocation of neurons exceeded");
    };
    await deliver(message(rawMail()));
    await runAt(NOW + MIN);
    expect((await rows("SELECT status FROM emails"))[0].status).toBe("queued");
    const h = await inKeeper((k) => k.load());
    expect(h.draftsBlockedUntil).toBe(Date.UTC(2026, 10, 13));
  });

  it("drafts only within the inbox pool", async () => {
    await inKeeper((k) => k.setLedger("2026-11-12", { used: 1500, inbox: 1500 }));
    await deliver(message(rawMail()));
    await runAt(NOW + MIN);
    expect(await rows("SELECT * FROM drafts")).toHaveLength(0);
    expect(f.ai.calls).toHaveLength(0);
  });
});

describe("retention", () => {
  beforeEach(async () => {
    await resetAll();
    installFakes();
    await runAt(NOW);
    await rows("UPDATE sources SET paused = 1, status = 'paused'");
  });

  it("the daily alarm deletes questions, emails and drafts older than RETENTION_DAYS, rate rows after 48 h, and expired cache", async () => {
    const old = NOW - 31 * DAY;
    await rows("INSERT INTO asks (id, at, question, answer, confidence, mode) VALUES ('q_old', ?, 'q', 'a', 'none', 'search'), ('q_new', ?, 'q', 'a', 'none', 'search')", old, NOW - DAY);
    await rows("INSERT INTO emails (id, received_at, status) VALUES ('e_old', ?, 'drafted')", old);
    await rows("INSERT INTO drafts (id, email_id, created_at, body, confidence) VALUES ('d_old', 'e_old', ?, 'b', 'high')", old);
    await rows("INSERT INTO rate (key, day, n) VALUES ('ip:x', '2026-11-09', 3), ('ip:y', '2026-11-12', 1)");
    await rows("INSERT INTO answer_cache (key, docs_version, response, expires_at) VALUES ('k', 1, '{}', ?)", NOW - 1);
    // The purge runs once per UTC day: tomorrow's first run.
    const t = Date.UTC(2026, 10, 13, 0, 5);
    setNow(t);
    await runAt(t);
    expect((await rows("SELECT id FROM asks")).map((r) => r.id)).toEqual(["q_new"]);
    expect(await rows("SELECT * FROM emails")).toHaveLength(0);
    expect(await rows("SELECT * FROM drafts")).toHaveLength(0);
    expect((await rows("SELECT key FROM rate")).map((r) => r.key)).toEqual(["ip:y"]);
    expect(await rows("SELECT * FROM answer_cache")).toHaveLength(0);
  });

  it("RETENTION_DAYS shortens it; DELETE /api/asks removes all", async () => {
    await rows("INSERT INTO asks (id, at, question, answer, confidence, mode) VALUES ('q1', ?, 'q', 'a', 'none', 'search')", NOW - 3 * DAY);
    const t = Date.UTC(2026, 10, 13, 0, 5);
    await inKeeper(async () => {
      const { testHooks } = await import("../src/lib/appctx.js");
      testHooks.env = { ...testHooks.env, RETENTION_DAYS: "2" };
    });
    await runAt(t);
    expect(await rows("SELECT * FROM asks")).toHaveLength(0);
    await rows("INSERT INTO asks (id, at, question, answer, confidence, mode) VALUES ('q2', ?, 'q', 'a', 'none', 'search')", NOW);
    expect((await api("DELETE", "asks")).data.deleted).toBe(1);
  });
});
