// Chunking (docs/SDD.md, "Chunking"): split at headings (# to ###), then by
// paragraph to about 300-400 tokens with a 15% overlap. Each chunk keeps its
// heading path ("Install › Windows › Troubleshooting"). Code blocks under 400
// tokens are never split. Token counts use the budget's 4-characters estimate.
import { tokens } from "./text.js";
import { sha256Hex } from "./crypto.js";

export const TARGET_TOKENS = 350;
export const MAX_TOKENS = 400;
export const OVERLAP = 0.15;

/** Markdown front matter and HTML comments out; MDX import/export lines dropped. */
function tidy(md) {
  return String(md)
    .replace(/\r\n?/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^(import|export)\s.+$/gm, "");
}

/** Sections: { path: string[], blocks: string[] }. A block is a paragraph or a whole code fence. */
export function sections(md) {
  const lines = tidy(md).split("\n");
  const out = [];
  const path = [];
  let cur = { path: [], blocks: [] };
  let para = [];
  let fence = null;
  const endPara = () => {
    const t = para.join("\n").trim();
    if (t) cur.blocks.push(t);
    para = [];
  };
  for (const line of lines) {
    if (fence) {
      para.push(line);
      if (line.trim().startsWith(fence)) {
        cur.blocks.push(para.join("\n"));
        para = [];
        fence = null;
      }
      continue;
    }
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      endPara();
      fence = f[1];
      para.push(line);
      continue;
    }
    const h = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      endPara();
      if (cur.blocks.length) out.push(cur);
      const level = h[1].length;
      path.length = level - 1;
      path[level - 1] = h[2].replace(/[*_`]/g, "").trim();
      cur = { path: path.filter(Boolean).slice(), blocks: [] };
      continue;
    }
    if (!line.trim()) endPara();
    else para.push(line);
  }
  if (fence) cur.blocks.push(para.join("\n"));
  else endPara();
  if (cur.blocks.length) out.push(cur);
  return out;
}

/** Splits an over-long paragraph (not a small code block) at sentence or line ends. */
function splitBlock(b) {
  if (tokens(b) <= MAX_TOKENS) return [b];
  const isCode = /^\s*(```|~~~)/.test(b);
  const parts = isCode ? b.split("\n") : b.split(/(?<=[.!?])\s+/);
  const out = [];
  let acc = "";
  for (const p of parts) {
    const piece = tokens(p) > MAX_TOKENS ? p.match(new RegExp(`[\\s\\S]{1,${MAX_TOKENS * 4}}`, "g")) : [p];
    for (const q of piece) {
      if (acc && tokens(acc) + tokens(q) > TARGET_TOKENS) {
        out.push(acc);
        acc = "";
      }
      acc = acc ? `${acc}${isCode ? "\n" : " "}${q}` : q;
    }
  }
  if (acc) out.push(acc);
  return out;
}

/** The last ~15% of a chunk's text, for the next chunk's start. */
function tail(text) {
  const want = Math.floor(TARGET_TOKENS * OVERLAP) * 4;
  if (text.length <= want) return text;
  const t = text.slice(-want);
  const sp = t.indexOf(" ");
  return sp >= 0 && sp < want / 2 ? t.slice(sp + 1) : t;
}

/**
 * Chunks of one document.
 * @returns {{ ordinal: number, headingPath: string, text: string, tokens: number }[]}
 */
export function chunkMarkdown(md) {
  const out = [];
  for (const s of sections(md)) {
    const headingPath = s.path.join(" › ");
    const blocks = s.blocks.flatMap(splitBlock);
    let acc = "";
    let fresh = false; // acc holds more than the overlap
    const emit = () => {
      if (acc.trim() && fresh) out.push({ ordinal: out.length, headingPath, text: acc.trim(), tokens: tokens(acc.trim()) });
    };
    for (const b of blocks) {
      if (acc && tokens(acc) + tokens(b) > TARGET_TOKENS) {
        emit();
        acc = tail(acc);
        fresh = false;
        // A code block isn't glued to a partial overlap of other text.
        if (/^\s*(```|~~~)/.test(b)) acc = "";
      }
      acc = acc ? `${acc}\n\n${b}` : b;
      fresh = true;
    }
    emit();
  }
  return out;
}

/** Chunk id and content hash (docs/SDD.md: id = SHA-256(source, doc path, heading path, ordinal)). */
export async function chunkIds(sourceId, docPath, chunks) {
  return Promise.all(
    chunks.map(async (c) => ({
      ...c,
      id: (await sha256Hex(`${sourceId}\n${docPath}\n${c.headingPath}\n${c.ordinal}`)).slice(0, 40),
      contentHash: (await sha256Hex(`${c.headingPath}\n${c.text}`)).slice(0, 40),
    })),
  );
}

/** The doc title: its first # heading, else the file name. */
export function titleOf(md, path) {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(tidy(md));
  if (m) return m[1].replace(/[*_`]/g, "").trim().slice(0, 200);
  const base = String(path).split("/").pop() ?? path;
  return base.replace(/\.(md|mdx|txt|html?)$/i, "").replace(/[-_]+/g, " ").slice(0, 200);
}
