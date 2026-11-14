// POST /v1/hooks/github: a signed push webhook that starts a re-ingest of the
// matching GitHub source early (checked as perchlight-hooks checks GitHub:
// X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, raw body), constant-time).
import { json, fail, readCapped } from "../lib/http.js";
import { hmacHex, safeEqual } from "../lib/crypto.js";
import { keeperStub } from "../lib/appctx.js";

export const MAX_HOOK_BODY = 1024 * 1024;

export async function handleGithubHook(request, app, ctx) {
  const { env, cfg } = app;
  if (request.method !== "POST") return fail(405, "method", "POST only.");
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (typeof secret !== "string" || secret.length < 16) return fail(503, "not_configured", "GITHUB_WEBHOOK_SECRET isn't set (16+ characters).");
  if (Number(request.headers.get("Content-Length") ?? "0") > MAX_HOOK_BODY) return fail(413, "too_large", "Too large.");
  const r = await readCapped(request.body, MAX_HOOK_BODY + 1);
  if (r.size > MAX_HOOK_BODY) return fail(413, "too_large", "Too large.");
  const raw = new TextDecoder().decode(r.bytes);
  const want = `sha256=${await hmacHex(secret, raw)}`;
  const got = request.headers.get("X-Hub-Signature-256") ?? "";
  if (!(await safeEqual(want, got))) return fail(401, "signature", "Signature check failed.");
  const event = request.headers.get("X-GitHub-Event");
  if (event === "ping") return json({ ok: true, pong: true });
  if (event !== "push") return json({ ok: true, ignored: event ?? "no event" });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "bad_request", "Not JSON.");
  }
  const repo = String(body?.repository?.full_name ?? "").toLowerCase();
  const ref = String(body?.ref ?? "");
  const hit = cfg.sources.filter((s) => !s.error && s.kind === "github" && s.repo.toLowerCase() === repo && ref === `refs/heads/${s.branch}`);
  if (!hit.length) return json({ ok: true, matched: [] });
  await env.DB.batch(hit.map((s) => env.DB.prepare("UPDATE sources SET requested_action = 'reingest' WHERE id = ? AND paused = 0").bind(s.id)));
  ctx.waitUntil(keeperStub(env).wake().catch((e) => console.error(`github hook: wake failed: ${e}`)));
  return json({ ok: true, matched: hit.map((s) => s.id) }, 202);
}
