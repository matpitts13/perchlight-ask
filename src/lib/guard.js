// Who may ask, and how often (docs/SDD.md, "Abuse and rate limits").
// - Widget: Turnstile once, then a session token HMAC(SESSION_SECRET, sid.exp)
//   valid for 30 minutes and 20 questions.
// - Apps: X-Api-Key, checked against ASK_API_KEYS (HMAC-stored), each with a daily cap.
// - Per IP hash 10 a minute (isolate memory) and 60 a day (D1), per session 20,
//   global ASK_DAILY_CAP. The IP hash is HMAC(IP_SALT, ip + UTC date); raw IPs
//   are never stored.
import { hmacHex, safeEqual, apiKeyHash, randomToken } from "./crypto.js";
import { net } from "./net.js";
import { parseJson, utcDay, errText } from "./http.js";

const VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** ALLOWED_ORIGINS: comma- or space-separated origins, e.g. "https://example.com, https://docs.example.com". */
export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS ?? "")
    .split(/[\s,]+/)
    .map((o) => o.trim().replace(/\/+$/, "").toLowerCase())
    .filter((o) => /^https?:\/\/[^/]+$/.test(o));
}

export function originAllowed(env, origin) {
  return Boolean(origin) && allowedOrigins(env).includes(String(origin).toLowerCase());
}

const secretOk = (s) => typeof s === "string" && s.length >= 16;

/**
 * Turnstile siteverify, with the hostname checked against ALLOWED_ORIGINS.
 * @returns {Promise<"ok"|"refused"|"unavailable"|"not_configured">}
 */
export async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return "not_configured";
  if (typeof token !== "string" || !token || token.length > 2048) return "refused";
  let data;
  try {
    const body = new FormData();
    body.set("secret", env.TURNSTILE_SECRET);
    body.set("response", token);
    if (ip) body.set("remoteip", ip);
    const res = await net.fetch(VERIFY, { method: "POST", body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return "unavailable";
    data = await res.json();
  } catch (err) {
    console.error(`turnstile: unreachable: ${errText(err)}`);
    return "unavailable";
  }
  if (data?.success !== true) return "refused";
  const hosts = allowedOrigins(env).map((o) => new URL(o).hostname);
  if (!hosts.includes(String(data.hostname ?? "").toLowerCase())) return "refused";
  return "ok";
}

export async function issueSession(env, now, minutes) {
  const sid = randomToken();
  const exp = now + minutes * 60_000;
  const mac = await hmacHex(env.SESSION_SECRET, `${sid}.${exp}`);
  return { session: `${sid}.${exp}.${mac}`, sid, exp };
}

/** @returns {Promise<string|null>} the session id, or null if missing, forged or expired. */
export async function checkSession(env, token, now) {
  if (!secretOk(env.SESSION_SECRET) || typeof token !== "string" || token.length > 200) return null;
  const m = /^([A-Za-z0-9_-]{22})\.(\d{13})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  if (Number(m[2]) < now) return null;
  const want = await hmacHex(env.SESSION_SECRET, `${m[1]}.${m[2]}`);
  return (await safeEqual(want, m[3])) ? m[1] : null;
}

/** @returns {Promise<{ name: string, daily: number } | null>} */
export async function checkApiKey(env, key) {
  if (typeof key !== "string" || key.length < 16 || key.length > 200) return null;
  const keys = parseJson(env.ASK_API_KEYS, null);
  if (!keys || typeof keys !== "object") return null;
  const h = await apiKeyHash(key);
  let found = null;
  // Every entry is compared, so timing doesn't tell which one matched.
  for (const [name, v] of Object.entries(keys)) {
    if (v && typeof v.hash === "string" && (await safeEqual(v.hash.toLowerCase(), h)) && !found) found = { name, daily: Number.isFinite(v.daily) ? v.daily : 500 };
  }
  return found;
}

export async function ipHash(env, ip, now) {
  return (await hmacHex(env.IP_SALT, `${ip}|${utcDay(now)}`)).slice(0, 32);
}

// Per-isolate minute window per IP hash (as perchlight-keys: isolate first, then D1).
const minute = new Map();
export function resetMinuteWindows() {
  minute.clear();
}

/** Counts one request in this isolate's minute window; false if over. */
export function minuteOk(key, now, limit) {
  const w = Math.floor(now / 60_000);
  const cur = minute.get(key);
  if (!cur || cur.w !== w) {
    if (minute.size > 5000) minute.clear();
    minute.set(key, { w, n: 1 });
    return true;
  }
  cur.n++;
  return cur.n <= limit;
}

/**
 * Daily counters in one D1 batch: each { key, limit } is incremented and
 * checked. Returns the first key over its limit, or null.
 */
export async function countDaily(db, day, items) {
  const stmts = items.map((it) => db.prepare("INSERT INTO rate (key, day, n) VALUES (?1, ?2, 1) ON CONFLICT (key, day) DO UPDATE SET n = n + 1 RETURNING n").bind(it.key, day));
  const res = await db.batch(stmts);
  let rows = 0;
  let over = null;
  res.forEach((r, i) => {
    rows += r.meta?.rows_written ?? 0;
    const n = r.results?.[0]?.n ?? 0;
    if (!over && n > items[i].limit) over = items[i].key;
  });
  return { over, rows };
}
