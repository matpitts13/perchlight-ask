// A small purpose-built MIME reader for inbox mode (docs/SDD.md, "Inbox
// mode"): headers, then the first text/plain part (or text from the first
// text/html part), one level of nesting, base64 and quoted-printable,
// quoted history cut off, cut to about 800 tokens. Attachments are never
// decoded. Not a full MIME library, on purpose: Free email handlers get 10 ms.

export const RAW_LIMIT = 64 * 1024;
export const BODY_CHARS = 3200; // ~800 tokens

/** Header block -> Map of lower-case name -> first value (unfolded). */
export function parseHeaders(block) {
  const out = new Map();
  const lines = block.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ").split("\n");
  for (const l of lines) {
    const i = l.indexOf(":");
    if (i <= 0) continue;
    const k = l.slice(0, i).trim().toLowerCase();
    if (!out.has(k)) out.set(k, l.slice(i + 1).trim());
  }
  return out;
}

function decodeBytes(bytes, charset) {
  try {
    return new TextDecoder(charset || "utf-8", { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function latin1Bytes(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

function b64Bytes(s) {
  try {
    return latin1Bytes(atob(s.replace(/[^A-Za-z0-9+/=]/g, "")));
  } catch {
    return new Uint8Array(0);
  }
}

function qpBytes(s) {
  const t = s.replace(/=\r?\n/g, "");
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
      out.push(parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(t.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

/** RFC 2047 encoded words in a header value. */
export function decodeWords(v) {
  return String(v ?? "")
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, e, data) => {
      const bytes = e.toUpperCase() === "B" ? b64Bytes(data) : qpBytes(data.replace(/_/g, " "));
      return decodeBytes(bytes, cs);
    });
}

function param(ct, name) {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(ct ?? "");
  return m ? (m[1] ?? m[2]) : null;
}

function splitHead(raw) {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? [raw.slice(0, m.index), raw.slice(m.index + m[0].length)] : [raw, ""];
}

function decodePart(headers, body) {
  const cte = (headers.get("content-transfer-encoding") ?? "").toLowerCase();
  const cs = param(headers.get("content-type"), "charset");
  if (cte === "base64") return decodeBytes(b64Bytes(body), cs);
  if (cte === "quoted-printable") return decodeBytes(qpBytes(body), cs);
  return decodeBytes(latin1Bytes(body), cs);
}

/** The first text part: { type: "plain"|"html", text } or null. depth: nesting allowed. */
function firstText(headers, body, depth) {
  const ct = (headers.get("content-type") ?? "text/plain").toLowerCase();
  if (ct.startsWith("multipart/")) {
    if (depth <= 0) return null;
    const boundary = param(headers.get("content-type"), "boundary");
    if (!boundary) return null;
    const parts = body.split(`--${boundary}`).slice(1);
    let html = null;
    for (const p of parts) {
      if (p.startsWith("--")) break;
      const [h, b] = splitHead(p.replace(/^\r?\n/, ""));
      const ph = parseHeaders(h);
      if (/attachment/i.test(ph.get("content-disposition") ?? "")) continue;
      const t = firstText(ph, b, depth - 1);
      if (t?.type === "plain") return t;
      if (t && !html) html = t;
    }
    return html;
  }
  if (ct.startsWith("text/plain")) return { type: "plain", text: decodePart(headers, body) };
  if (ct.startsWith("text/html")) return { type: "html", text: decodePart(headers, body) };
  return null;
}

/** Cheap HTML -> text for mail bodies (no HTMLRewriter in this hot path). */
/** Removes <tag>…</tag> blocks in one linear pass (an unclosed tag drops the rest): no backtracking regex on untrusted mail. */
export function stripBlocks(s, tags) {
  const low = s.toLowerCase();
  let out = "";
  let at = 0;
  for (;;) {
    let best = -1;
    let tag = null;
    for (const t of tags) {
      const i = low.indexOf(`<${t}`, at);
      if (i >= 0 && (best < 0 || i < best)) {
        best = i;
        tag = t;
      }
    }
    if (best < 0) return out + s.slice(at);
    out += `${s.slice(at, best)} `;
    const end = low.indexOf(`</${tag}`, best);
    if (end < 0) return out;
    const close = low.indexOf(">", end);
    if (close < 0) return out;
    at = close + 1;
  }
}

export function mailHtmlToText(h) {
  return stripBlocks(String(h), ["script", "style", "head", "blockquote"])
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Cuts quoted history: "> " lines and everything after "On ... wrote:" / "Original Message" / an Outlook header block. */
export function cutQuoted(t) {
  const lines = String(t).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*>/.test(l)) continue;
    if (/^On .{4,200}wrote:\s*$/i.test(l.trim()) || (/^On .{4,200}$/i.test(l.trim()) && /wrote:\s*$/i.test(lines[i + 1] ?? ""))) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim())) break;
    if (/^From:\s.+/i.test(l) && /^(Sent|Date):\s/i.test(lines[i + 1] ?? "")) break;
    if (/^_{10,}\s*$/.test(l)) break;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * @param {string} raw  the first RAW_LIMIT bytes as latin1 text
 * @returns {{ ok: boolean, from: string, subject: string, messageId: string, inReplyTo: string, body: string, headers: Map }}
 */
export function parseMail(raw) {
  const [h, b] = splitHead(raw);
  const headers = parseHeaders(h);
  const base = {
    headers,
    from: decodeWords(headers.get("from") ?? "").slice(0, 300),
    subject: decodeWords(headers.get("subject") ?? "").replace(/[\r\n]+/g, " ").slice(0, 300),
    messageId: (headers.get("message-id") ?? "").slice(0, 300),
    inReplyTo: (headers.get("in-reply-to") ?? "").slice(0, 300),
  };
  const t = firstText(headers, b, 2);
  if (!t) return { ...base, ok: false, body: "" };
  let body = cutQuoted(t.type === "html" ? mailHtmlToText(t.text) : t.text);
  body = body.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  if (body.length > BODY_CHARS) body = `${body.slice(0, BODY_CHARS)}\n[…cut]`;
  return { ...base, ok: true, body };
}

/** "Name <a@b>" -> "a@b" (lower-case). */
export function addressOf(v) {
  // The LAST <addr> is the real one: a display name can itself contain "<someone@else>".
  const all = [...String(v).matchAll(/<([^<>\s]+@[^<>\s]+)>/g)];
  const m = all[all.length - 1];
  const a = (m ? m[1] : String(v).trim().split(/\s+/)[0] ?? "").toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) ? a : "";
}

/** Why a mail shouldn't be drafted, or null (docs/SDD.md, "Inbox mode" step 2). */
export function skipReason(headers, fromAddr, own) {
  const auto = (headers.get("auto-submitted") ?? "").toLowerCase();
  if (auto && auto !== "no") return `Auto-Submitted: ${auto.slice(0, 40)}`;
  const prec = (headers.get("precedence") ?? "").toLowerCase();
  if (/bulk|list|junk/.test(prec)) return `Precedence: ${prec.slice(0, 20)}`;
  if (headers.has("list-id")) return "mailing list (List-Id)";
  if (!fromAddr) return "no sender address";
  const local = fromAddr.split("@")[0];
  if (/^(mailer-daemon|postmaster)$/i.test(local)) return "bounce (MAILER-DAEMON)";
  if (/^(no-?reply|do-?not-?reply)/i.test(local)) return "no-reply sender";
  if (own.includes(fromAddr)) return "from one of your own addresses";
  return null;
}
