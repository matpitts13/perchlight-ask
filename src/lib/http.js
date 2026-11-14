// Small HTTP helpers. From perchlight-hooks src/lib/http.js (itself from
// perchlight-status / perchlight-forms). Errors here are JSON {error, message}
// (docs/SDD.md, "API").

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders },
  });
}

/** An API error: { error, message }. */
export function fail(status, error, message = error, extraHeaders = {}) {
  return json({ error, message }, status, extraHeaders);
}

export function text(body, status = 200, extraHeaders = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders } });
}

/**
 * Reads a stream up to `max` bytes. Stops (and cancels) beyond it.
 * @returns {Promise<{ bytes: Uint8Array, size: number, over: boolean }>}
 */
export async function readCapped(stream, max) {
  if (!stream) return { bytes: new Uint8Array(0), size: 0, over: false };
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  let over = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const v = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (size + v.byteLength > max) {
      chunks.push(v.subarray(0, max - size));
      size = max;
      over = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(v);
    size += v.byteLength;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { bytes: all, size, over };
}

/** Reads a JSON object of at most maxBytes: { ok: true, value } | { ok: false, tooLarge }. */
export async function readJson(request, maxBytes) {
  const len = Number(request.headers.get("Content-Length") ?? "0");
  if (len > maxBytes) return { ok: false, tooLarge: true };
  if (!request.body) return { ok: true, value: {} };
  const r = await readCapped(request.body, maxBytes);
  if (r.over) return { ok: false, tooLarge: true };
  try {
    const v = JSON.parse(new TextDecoder().decode(r.bytes) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? { ok: true, value: v } : { ok: false, tooLarge: false };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

export function utcDay(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Milliseconds of the next 00:00 UTC after ms. */
export function nextMidnight(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Seconds until the next UTC midnight (for Retry-After on a daily cap). */
export function secondsToMidnight(ms) {
  return Math.max(1, Math.ceil((nextMidnight(ms) - ms) / 1000));
}

export const parseJson = (s, d) => {
  try {
    return s == null ? d : JSON.parse(s);
  } catch {
    return d;
  }
};

export const errText = (err) => (err instanceof Error ? err.message : String(err));
