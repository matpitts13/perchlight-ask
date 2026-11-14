// Text helpers: token estimates, question normalising, redaction, keyword
// terms and the prompt-injection pattern flag.

/** The budget's worst-case estimate: 4 characters per token, rounded up (docs/SDD.md, "Budget guard"). */
export function tokens(s) {
  return Math.ceil(String(s ?? "").length / 4);
}

/** Lower-case, collapsed spaces, trailing punctuation dropped (the answer cache key). */
export function normalizeQuestion(q) {
  return String(q).toLowerCase().replace(/\s+/g, " ").trim().replace(/[\s?!.,;:]+$/, "");
}

/** Removes control characters (keeps newlines and tabs). */
export function clean(s) {
  return String(s ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** Email addresses, phone numbers and long digit runs out of stored text (Should: "Redaction"). */
export function redact(s) {
  return String(s)
    .replace(/[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[^\s@"'<>(),;:]+/g, "[email]")
    .replace(/\+?\d[\d ().-]{6,}\d/g, (m) => (m.replace(/\D/g, "").length >= 8 ? "[number]" : m));
}

const STOP = new Set(
  "a an and are as at be but by can do does for from how i if in into is it its me my no not of on or our so that the their then there these this to was we what when where which who why will with you your".split(" "),
);

/** Keyword terms of a question: words of 2+ letters, stop words dropped, at most 12. */
export function terms(q) {
  const out = [];
  for (const w of String(q).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (w.length < 2 || STOP.has(w) || out.includes(w)) continue;
    out.push(w.slice(0, 40));
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * An FTS5 MATCH expression: each term quoted (so users can't inject FTS
 * syntax: quotes, operators, column filters, NEAR), joined by OR.
 */
export function ftsQuery(ts) {
  return ts.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

/** Share of the terms that appear in a text (stemming-light: prefix match on 4+ letters). */
export function coverage(ts, text) {
  if (!ts.length) return 0;
  const words = new Set(String(text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  let hit = 0;
  for (const t of ts) {
    if (words.has(t)) hit++;
    else if (t.length >= 4 && [...words].some((w) => w.startsWith(t.slice(0, Math.max(4, t.length - 2))))) hit++;
  }
  return hit / ts.length;
}

const INJECTION = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i,
  /disregard (all |any |the )?(previous|prior|above|your) (instructions|rules)/i,
  /\b(system prompt|developer mode|jailbreak)\b/i,
  /you are now\b/i,
  /reveal (your|the) (prompt|instructions|rules)/i,
  /<\/?(source|question|system|email)\b/i,
];

/** A simple pattern flag shown to the owner (not a defence; docs/SDD.md, "Security"). */
export function looksLikeInjection(s) {
  return INJECTION.some((r) => r.test(String(s)));
}

/** First n characters, cut at a word where possible. */
export function snippet(s, n = 200) {
  const t = String(s).replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return `${sp > n * 0.6 ? cut.slice(0, sp) : cut}…`;
}
