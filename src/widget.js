// The widget script served at GET /widget.js (docs/SDD.md, "Widget"): a
// shadow-DOM panel, no framework, Turnstile on the first question of a
// session, honours the page's colour scheme. Model text is only ever put in
// text nodes (a tiny markdown subset: paragraphs, lists, inline code, code
// blocks, bold); the only links are the cited sources' URLs from the API.
//
// <script src="https://ask.example.com/widget.js?v=0.1.0" data-site-key="0x4AAA..." data-title="Ask the docs" async></script>

export const WIDGET_VERSION = "0.1.0";

export const WIDGET_JS = String.raw`(() => {
  "use strict";
  const me = document.currentScript;
  if (!me || window.__perchlightAsk) return;
  window.__perchlightAsk = true;
  const base = (me.getAttribute("data-endpoint") || new URL(me.src).origin).replace(/\/+$/, "");
  const siteKey = me.getAttribute("data-site-key") || "";
  const title = me.getAttribute("data-title") || "Ask the docs";
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  let session = null, sessionExp = 0, last = null, busy = false;

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = '<style>' +
    ':host{all:initial}*{box-sizing:border-box}' +
    '.b{font:600 14px/1 system-ui,sans-serif;border:0;border-radius:999px;padding:12px 16px;cursor:pointer;background:var(--a);color:var(--af);box-shadow:0 4px 14px rgba(0,0,0,.2)}' +
    '.p{display:none;flex-direction:column;width:min(380px,calc(100vw - 32px));height:min(520px,calc(100vh - 90px));margin-bottom:10px;border-radius:12px;overflow:hidden;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.25);border:1px solid var(--bd)}' +
    '.o .p{display:flex}.h{padding:10px 14px;font-weight:600;border-bottom:1px solid var(--bd);display:flex;justify-content:space-between}' +
    '.h button{background:none;border:0;color:inherit;font-size:18px;cursor:pointer}' +
    '.l{flex:1;overflow:auto;padding:12px 14px}.q{font-weight:600;margin:12px 0 4px}.a p{margin:6px 0}.a pre{background:var(--cb);padding:8px;border-radius:6px;overflow:auto;font:12px/1.4 ui-monospace,monospace}' +
    '.a code{background:var(--cb);padding:0 3px;border-radius:3px;font:12px ui-monospace,monospace}.n{font-size:12px;opacity:.75;margin:4px 0}' +
    '.s{font-size:13px;margin:6px 0 0;padding-left:18px}.s a{color:var(--lk)}.s .sn{display:block;opacity:.75;font-size:12px}' +
    '.f{font-size:12px;margin-top:4px}.f button{background:none;border:1px solid var(--bd);border-radius:6px;color:inherit;cursor:pointer;margin-right:4px}' +
    'form{display:flex;gap:6px;padding:10px;border-top:1px solid var(--bd)}input[type=text]{flex:1;padding:8px;border-radius:6px;border:1px solid var(--bd);background:var(--bg);color:var(--fg);font:inherit}' +
    'form button{padding:8px 12px;border:0;border-radius:6px;background:var(--a);color:var(--af);cursor:pointer;font:inherit}' +
    '.t{font-size:11px;padding:0 10px 8px;opacity:.8}.e{color:var(--er)}' +
    '.w{--bg:#fff;--fg:#1b1b1f;--bd:#ddd;--cb:#f2f2f4;--a:#2f5bd3;--af:#fff;--lk:#2048b8;--er:#b42318}' +
    '@media (prefers-color-scheme:dark){.w{--bg:#1d1f24;--fg:#ececf0;--bd:#3a3d45;--cb:#2a2d34;--a:#6d8df0;--af:#0d1020;--lk:#9db4ff;--er:#ff8a7a}}' +
    '</style><div class="w"><div class="p" role="dialog" aria-label=""><div class="h"><span class="ti"></span><button type="button" class="x" aria-label="Close">×</button></div>' +
    '<div class="l" aria-live="polite"></div><form><input type="text" maxlength="500" placeholder="Ask a question" aria-label="Your question"><button>Ask</button></form>' +
    '<label class="t"><input type="checkbox" class="nl"> Don' + "'" + 't save my question</label></div><button type="button" class="b"></button></div>';
  const $ = (s) => root.querySelector(s);
  const wrap = $(".w"), log = $(".l"), input = $("input[type=text]"), nolog = $(".nl");
  $(".ti").textContent = title; $(".b").textContent = title; $(".p").setAttribute("aria-label", title);
  nolog.checked = store.get("perchlight-ask-nolog") === "1";
  nolog.addEventListener("change", () => store.set("perchlight-ask-nolog", nolog.checked ? "1" : "0"));
  $(".b").addEventListener("click", () => { wrap.classList.toggle("o"); if (wrap.classList.contains("o")) input.focus(); });
  $(".x").addEventListener("click", () => wrap.classList.remove("o"));

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function inline(parent, text) {
    const re = /(\x60[^\x60\n]+\x60|\*\*[^*\n]+\*\*)/g; let at = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > at) parent.appendChild(document.createTextNode(text.slice(at, m.index)));
      const t = m[0]; parent.appendChild(t[0] === "\x60" ? el("code", "", t.slice(1, -1)) : el("strong", "", t.slice(2, -2)));
      at = m.index + t.length;
    }
    if (at < text.length) parent.appendChild(document.createTextNode(text.slice(at)));
  }
  function render(text) {
    const box = el("div", "a"); const parts = String(text).split(/\x60\x60\x60[^\n]*\n?/);
    parts.forEach((part, i) => {
      if (i % 2) { const pre = el("pre"); pre.appendChild(el("code", "", part.replace(/\n$/, ""))); box.appendChild(pre); return; }
      for (const para of part.split(/\n{2,}/)) {
        const lines = para.split("\n").filter((l) => l.trim());
        if (!lines.length) continue;
        if (lines.every((l) => /^\s*([-*]|\d+[.)])\s+/.test(l))) {
          const list = el(/^\s*\d/.test(lines[0]) ? "ol" : "ul");
          for (const l of lines) { const li = el("li"); inline(li, l.replace(/^\s*([-*]|\d+[.)])\s+/, "")); list.appendChild(li); }
          box.appendChild(list);
        } else { const p = el("p"); inline(p, lines.join(" ")); box.appendChild(p); }
      }
    });
    return box;
  }
  function sources(list) {
    if (!list || !list.length) return null;
    const ol = el("ol", "s");
    for (const s of list) {
      const li = el("li"); li.value = s.n;
      const label = s.title + (s.heading && s.heading !== s.title ? " › " + s.heading : "");
      if (typeof s.url === "string" && /^https?:\/\//i.test(s.url)) { const a = el("a", "", label); a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer nofollow"; li.appendChild(a); }
      else li.appendChild(document.createTextNode(label));
      if (s.snippet) li.appendChild(el("span", "sn", s.snippet));
      ol.appendChild(li);
    }
    return ol;
  }
  function feedback(id) {
    const f = el("div", "f", "Was this helpful? ");
    for (const [label, v] of [["Yes", true], ["No", false]]) {
      const b = el("button", "", label); b.type = "button";
      b.addEventListener("click", () => { f.textContent = "Thanks!"; post("/v1/feedback", { id, helpful: v }).catch(() => {}); });
      f.appendChild(b);
    }
    return f;
  }
  async function post(path, body) {
    const h = { "Content-Type": "application/json" }; if (session) h["X-Session"] = session;
    const r = await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body), credentials: "omit" });
    let data = null; try { data = await r.json(); } catch {}
    return { status: r.status, data };
  }
  let tsLoaded = null;
  function turnstile() {
    if (!siteKey) return Promise.reject(new Error("unavailable"));
    if (!tsLoaded) tsLoaded = new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true; s.onload = ok; s.onerror = () => no(new Error("unavailable")); document.head.appendChild(s); });
    return tsLoaded.then(() => new Promise((ok, no) => {
      const box = document.createElement("div"); box.style.cssText = "position:fixed;right:16px;bottom:80px;z-index:2147483001"; document.body.appendChild(box);
      window.turnstile.render(box, { sitekey: siteKey, callback: (t) => { box.remove(); ok(t); }, "error-callback": () => { box.remove(); no(new Error("unavailable")); } });
    }));
  }
  async function ensureSession() {
    if (session && Date.now() < sessionExp - 30000) return;
    session = null;
    const token = await turnstile();
    const r = await post("/v1/session", { turnstile: token });
    if (r.status !== 200 || !r.data || !r.data.session) throw new Error(r.status === 403 ? "refused" : "unavailable");
    session = r.data.session; sessionExp = r.data.exp;
  }
  async function ask(q, retried) {
    await ensureSession();
    const body = { question: q, log: !nolog.checked };
    if (last) body.history = last;
    const r = await post("/v1/ask", body);
    if (r.status === 401 && !retried) { session = null; return ask(q, true); }
    return r;
  }
  $("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const q = input.value.trim(); if (q.length < 3 || busy) return;
    busy = true; input.value = "";
    log.appendChild(el("div", "q", q));
    const wait = el("div", "n", "Looking in the docs…"); log.appendChild(wait); log.scrollTop = log.scrollHeight;
    try {
      const r = await ask(q, false);
      wait.remove();
      if (r.status === 429) log.appendChild(el("div", "n e", "Too many questions; try again later."));
      else if (r.status !== 200 || !r.data) log.appendChild(el("div", "n e", (r.data && r.data.message) || "Something went wrong."));
      else {
        const d = r.data; log.appendChild(render(d.answer));
        if (d.note) log.appendChild(el("div", "n", d.note));
        const s = sources(d.sources); if (s) log.appendChild(s);
        if (d.id) log.appendChild(feedback(d.id));
        last = { question: q, answer: String(d.answer).slice(0, 400) };
      }
    } catch (e) {
      wait.remove();
      log.appendChild(el("div", "n e", e && e.message === "refused" ? "The bot check didn't pass." : "Search is temporarily unavailable."));
    }
    busy = false; log.scrollTop = log.scrollHeight;
  });
  (document.body ? Promise.resolve() : new Promise((r) => addEventListener("DOMContentLoaded", r))).then(() => document.body.appendChild(host));
})();
`;
