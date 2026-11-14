// Hashes, HMAC, ids and constant-time comparison.
// From perchlight-status src/lib/crypto.js (hmacHex / safeEqual / randomId),
// via perchlight-hooks.

const enc = new TextEncoder();

export function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data) {
  return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}

export async function hmacHex(key, message) {
  const k = await crypto.subtle.importKey("raw", enc.encode(String(key)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(String(message))));
}

/** Constant-time comparison of two strings (hashes both first, so lengths don't leak either). */
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(String(a))), crypto.subtle.digest("SHA-256", enc.encode(String(b)))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

let lastMs = 0;
let seq = 0;
/** A time-sortable id: prefix, 9 base-36 characters of ms, a 3-character sequence, 6 random. */
export function sortableId(prefix, now = Date.now()) {
  const ms = Math.floor(now);
  seq = ms === lastMs ? seq + 1 : 0;
  lastMs = ms;
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let r = "";
  for (const b of bytes) r += ALPHABET[b & 31];
  return `${prefix}${ms.toString(36).padStart(9, "0")}${Math.min(seq, 46655).toString(36).padStart(3, "0")}${r}`;
}

/** 128 random bits as base64url. */
export function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The stored form of an API key (ASK_API_KEYS[name].hash): HMAC-SHA256("perchlight-ask:api-key", key). */
export function apiKeyHash(key) {
  return hmacHex("perchlight-ask:api-key", key);
}
