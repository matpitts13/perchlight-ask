// The email() handler for inbox mode (docs/SDD.md, "Inbox mode"). Kept
// minimal because Free handlers can fail on CPU:
// 1. Forward first, so you get the mail even if everything after fails.
// 2. Skip what shouldn't be drafted (auto-replies, lists, bounces, no-reply,
//    your own addresses, over the daily cap), recorded with the reason.
// 3. Store a trimmed copy (first 64 KB read, first text part, quoted history
//    cut, ~800 tokens) and wake the Keeper. Attachments are never read.
// It never sends anything to the customer.
import { readCapped, utcDay, errText } from "../lib/http.js";
import { sortableId } from "../lib/crypto.js";
import { parseMail, addressOf, skipReason, RAW_LIMIT } from "../lib/mailparse.js";
import { keeperStub, clock } from "../lib/appctx.js";
import { countDaily } from "../lib/guard.js";
import { looksLikeInjection } from "../lib/text.js";

export async function handleEmail(message, app, ctx) {
  const { env, cfg } = app;
  const forwardTo = String(env.FORWARD_TO ?? "").trim();
  if (!forwardTo) {
    // Nowhere to forward: refuse rather than lose the mail silently.
    message.setReject("This address isn't set up yet.");
    return;
  }
  await message.forward(forwardTo);
  if (!cfg.inbox.enabled) return;
  const now = clock.now();
  try {
    const raw = await readCapped(message.raw, RAW_LIMIT);
    let text = "";
    for (const b of raw.bytes) text += String.fromCharCode(b);
    let mail;
    try {
      mail = parseMail(text);
    } catch {
      mail = { ok: false, headers: new Map(), from: "", subject: "", messageId: "", inReplyTo: "", body: "" };
    }
    const hdr = (k) => message.headers.get(k) ?? mail.headers.get(k.toLowerCase()) ?? null;
    const headers = new Map([["auto-submitted", hdr("Auto-Submitted")], ["precedence", hdr("Precedence")], ["list-id", hdr("List-Id")]].filter(([, v]) => v !== null));
    const fromAddr = addressOf(hdr("From") ?? message.from ?? "");
    const own = [...cfg.inbox.ownAddresses, forwardTo.toLowerCase(), String(env.INBOX_FROM ?? "").toLowerCase(), String(env.MAIL_FROM ?? "").toLowerCase(), String(message.to ?? "").toLowerCase()].map((a) => addressOf(a) || a).filter(Boolean);
    let reason = skipReason(headers, fromAddr, own);
    if (!reason) {
      const c = await countDaily(env.DB, utcDay(now), [{ key: "inbox", limit: cfg.inbox.dailyCap }]);
      if (c.over) reason = `over INBOX_DAILY_CAP (${cfg.inbox.dailyCap} a day)`;
    }
    const status = reason ? "skipped" : mail.ok ? "queued" : "unparsed";
    const flags = looksLikeInjection(`${mail.subject}\n${mail.body}`) ? "possible prompt injection in the email" : "";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO emails (id, message_id, in_reply_to, from_addr, subject, body, received_at, status, skip_reason, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
        sortableId("em_", now),
        mail.messageId,
        mail.inReplyTo,
        fromAddr,
        mail.subject,
        reason ? "" : mail.body,
        now,
        status,
        reason,
        flags,
      ),
      env.DB.prepare("INSERT INTO daily (day, emails) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET emails = emails + 1").bind(utcDay(now)),
    ]);
    if (status === "queued") ctx.waitUntil(keeperStub(env).wake().catch((e) => console.error(`email: wake failed: ${errText(e)}`)));
  } catch (err) {
    // Already forwarded: log and stop (the mail isn't lost).
    console.error(`email: storing failed after forward: ${errText(err)}`);
  }
}
