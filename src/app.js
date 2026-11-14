// The Worker, built around an ask.json config (tests pass their own). It
// answers questions and takes mail; the Keeper Durable Object does all timed
// work (ingest, drafts, digests, purges). No cron trigger.
import { configFor, effective } from "./lib/config.js";
import { keeperStub, clock } from "./lib/appctx.js";
import { json, text, fail, errText } from "./lib/http.js";
import { handleAsk, handleSession, handleFeedback, handlePreflight } from "./routes/ask.js";
import { handleAdmin } from "./routes/admin.js";
import { handleGithubHook } from "./routes/github.js";
import { handleEmail } from "./routes/email.js";
import { WIDGET_JS, WIDGET_VERSION } from "./widget.js";

// The lazy fallback: at most once a minute per isolate, ask the Keeper to
// re-arm its alarm if it stopped (as perchlight-hooks).
const WATCHDOG_MS = 60_000;
let watchdogAt = 0;
export function resetWatchdog() {
  watchdogAt = 0;
}

function watchdog(env, ctx) {
  const now = clock.now();
  if (!env.KEEPER || now - watchdogAt < WATCHDOG_MS) return;
  watchdogAt = now;
  ctx.waitUntil(keeperStub(env).ensureAlarm().catch((err) => console.error(`watchdog: ${errText(err)}`)));
}

export function makeApp(raw, env) {
  return { env, cfg: effective(configFor(raw), env) };
}

export function makeWorker(raw) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const path = url.pathname;
      const app = makeApp(raw, env);
      try {
        if (path === "/widget.js" && request.method === "GET") {
          return new Response(WIDGET_JS, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*", ETag: `"w${WIDGET_VERSION}"` } });
        }
        let res;
        if (path.startsWith("/v1/") && request.method === "OPTIONS") return handlePreflight(request, app);
        if (path === "/v1/ask" && request.method === "POST") res = await handleAsk(request, app, ctx);
        else if (path === "/v1/session" && request.method === "POST") res = await handleSession(request, app);
        else if (path === "/v1/feedback" && request.method === "POST") res = await handleFeedback(request, app);
        else if (path === "/v1/hooks/github") res = await handleGithubHook(request, app, ctx);
        else if (path.startsWith("/api/")) res = await handleAdmin(request, app, ctx, path.slice(5));
        else if (path === "/") return text("perchlight-ask\n");
        else if (path.startsWith("/v1/")) return fail(404, "not_found", "No such route.");
        else return new Response(null, { status: 404 });
        watchdog(env, ctx);
        return res;
      } catch (err) {
        console.error(`${request.method} ${path}: ${err instanceof Error ? err.stack : String(err)}`);
        return json({ error: "internal", message: "Something went wrong." }, 500);
      }
    },

    async email(message, env, ctx) {
      await handleEmail(message, makeApp(raw, env), ctx);
    },
  };
}
