// Every outgoing ingest fetch goes through here (docs/SDD.md, "SSRF"): https
// only, no IP literals, no private or local names, never this deployment's
// own host, no credentials in URLs, only hosts on the allowlist, redirects
// followed by hand (redirect: "manual") and each hop re-checked, up to 3, a
// time limit for the whole fetch and a size cap on the body. Each hop counts
// against the run's subrequest budget.
import { checkTarget } from "./ssrf.js";
import { spend } from "./budget.js";
import { net } from "./net.js";
import { readCapped, errText } from "./http.js";

export class FetchError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // refused | network | timeout | too_large | budget | status
  }
}

/** Checks one URL against the SSRF rules and the host allowlist; returns the URL or throws. */
export function allowedUrl(raw, { hosts, ownHost }) {
  const t = checkTarget(raw);
  if (!t.ok) throw new FetchError("refused", `URL ${t.error}`);
  const u = t.url;
  if (u.protocol !== "https:") throw new FetchError("refused", "URL must use https:");
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) throw new FetchError("refused", "URL mustn't be an IP address");
  if (u.port && u.port !== "443") throw new FetchError("refused", "URL mustn't use a non-standard port");
  if (ownHost && host === String(ownHost).toLowerCase()) throw new FetchError("refused", "URL points at this deployment");
  if (!hosts.includes(host)) throw new FetchError("refused", `host ${host} isn't one of this source's hosts`);
  return u;
}

/**
 * @param {string} url
 * @param {{ hosts: string[], ownHost?: string, headers?: Record<string,string>, maxBytes: number, timeoutMs?: number, maxRedirects?: number, budget?: object, accept304?: boolean }} opts
 * @returns {Promise<{ status: number, headers: Headers, bytes: Uint8Array, url: string }>}
 */
export async function safeFetch(url, { hosts, ownHost = null, headers = {}, maxBytes, timeoutMs = 15_000, maxRedirects = 3, budget = null }) {
  const signal = AbortSignal.timeout(timeoutMs);
  let cur = allowedUrl(url, { hosts, ownHost });
  let hdrs = { ...headers };
  for (let hop = 0; ; hop++) {
    if (!spend(budget, 1)) throw new FetchError("budget", "subrequest budget used up");
    let res;
    try {
      res = await net.fetch(cur.toString(), { method: "GET", headers: hdrs, redirect: "manual", signal });
    } catch (err) {
      const timeout = err && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new FetchError(timeout ? "timeout" : "network", timeout ? "timed out" : errText(err).slice(0, 200));
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      res.body?.cancel().catch(() => {});
      const loc = res.headers.get("Location");
      if (!loc) throw new FetchError("status", `HTTP ${res.status} without a Location`);
      if (hop >= maxRedirects) throw new FetchError("refused", `more than ${maxRedirects} redirects`);
      let next;
      try {
        next = new URL(loc, cur);
      } catch {
        throw new FetchError("refused", "redirect refused: Location isn't a valid URL");
      }
      try {
        next = allowedUrl(next.toString(), { hosts, ownHost });
      } catch (e) {
        throw new FetchError("refused", `redirect refused: ${e.message}`);
      }
      // Credentials never follow a redirect to another host.
      if (next.host !== cur.host) {
        hdrs = Object.fromEntries(Object.entries(hdrs).filter(([k]) => k.toLowerCase() !== "authorization"));
      }
      cur = next;
      continue;
    }
    const len = Number(res.headers.get("Content-Length") ?? "0");
    if (len > maxBytes) {
      res.body?.cancel().catch(() => {});
      throw new FetchError("too_large", `larger than ${Math.round(maxBytes / 1024)} KB`);
    }
    let r;
    try {
      r = await readCapped(res.body, maxBytes + 1);
    } catch (err) {
      throw new FetchError("timeout", errText(err).slice(0, 200));
    }
    if (r.size > maxBytes) throw new FetchError("too_large", `larger than ${Math.round(maxBytes / 1024)} KB`);
    return { status: res.status, headers: res.headers, bytes: r.bytes, url: cur.toString() };
  }
}

export const decode = (bytes) => new TextDecoder().decode(bytes);
