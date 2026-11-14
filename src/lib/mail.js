// Outgoing mail: owner digests and (off by default) approved replies.
// Resend part adapted from perchlight-list src/lib/senders/resend.js (POST
// /emails with an Idempotency-Key, so a retry can't deliver twice); send_email
// part from perchlight-hooks (raw MIME via src/lib/mime.js).
import { EmailMessage } from "cloudflare:email";
import { net } from "./net.js";
import { mime, headerSafe, redactAddresses, encodeHeader, addressOnly } from "./mime.js";
import { errText } from "./http.js";

const RESEND = "https://api.resend.com/emails";

/** @returns {Promise<{ status: "sent"|"retry"|"failed"|"unknown", error?: string, id?: string }>} */
export async function sendResend(env, { from, to, subject, text, headers = {}, idempotencyKey }) {
  if (!env.RESEND_API_KEY) return { status: "failed", error: "RESEND_API_KEY isn't set" };
  let res;
  let body = "";
  try {
    res = await net.fetch(RESEND, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": String(idempotencyKey).slice(0, 256) },
      body: JSON.stringify({ from, to: [to], subject: headerSafe(subject), text, headers }),
      signal: AbortSignal.timeout(15_000),
    });
    body = await res.text();
  } catch (err) {
    // May or may not have reached Resend: retried with the same Idempotency-Key.
    return { status: "unknown", error: `Resend unreachable: ${errText(err).slice(0, 200)}` };
  }
  if (res.ok) {
    let id = null;
    try {
      id = JSON.parse(body)?.id ?? null;
    } catch {
      // not JSON
    }
    return { status: "sent", id };
  }
  const error = `Resend ${res.status}: ${redactAddresses(body.slice(0, 300))}`;
  if (res.status === 429 || res.status >= 500 || res.status === 409) return { status: "retry", error };
  return { status: "failed", error };
}

/** Through the send_email binding (free to your verified destination addresses). */
export async function sendBinding(env, { from, to, subject, text }) {
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") return { status: "failed", error: "the EMAIL send_email binding is missing from wrangler.jsonc" };
  if (!from) return { status: "failed", error: "MAIL_FROM isn't set" };
  try {
    const raw = mime({ from, to, subject, text, html: `<pre style="font-family:inherit;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</pre>` });
    await env.EMAIL.send(new EmailMessage(addressOnly(from), addressOnly(to), raw));
    return { status: "sent" };
  } catch (err) {
    return { status: "retry", error: redactAddresses(errText(err).slice(0, 300)) };
  }
}

export { encodeHeader };
