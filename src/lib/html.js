// HTML page -> markdown-like text, streaming through HTMLRewriter (low CPU;
// docs/SDD.md, "Ingest"). <main>/<article> preferred; nav, header, footer,
// script, style and the like dropped. Headings become "#" lines so the
// chunker can split at them.

const SKIP = "script, style, noscript, template, svg, nav, header, footer, form, iframe, aside, button, select";
const BLOCK = "p, li, br, div, section, tr, pre, blockquote, dt, dd, table, ul, ol";
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 && !(n >= 0xd800 && n < 0xe000) ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * @param {string | Response} input
 * @returns {Promise<{ title: string, text: string }>}
 */
export async function htmlToText(input) {
  let skip = 0;
  let main = 0;
  let pre = 0;
  let inTitle = false;
  let title = "";
  const all = [];
  const inMain = [];
  const push = (s) => {
    if (skip) return;
    all.push(s);
    if (main) inMain.push(s);
  };
  const depth = (inc, dec) => ({
    element(e) {
      inc();
      e.onEndTag(dec);
    },
  });
  const rw = new HTMLRewriter()
    .on(SKIP, depth(() => skip++, () => skip--))
    .on("main, article", depth(() => main++, () => main--))
    .on("title", {
      element(e) {
        inTitle = true;
        e.onEndTag(() => {
          inTitle = false;
        });
      },
    })
    .on("h1, h2, h3, h4", {
      element(e) {
        const level = Math.min(3, Number(e.tagName.slice(1)));
        push(`\n\n${"#".repeat(level)} `);
        e.onEndTag(() => push("\n\n"));
      },
    })
    .on(BLOCK, {
      element(e) {
        push("\n");
        if (e.tagName === "pre") {
          pre++;
          push("```\n");
          e.onEndTag(() => {
            pre--;
            push("\n```\n");
          });
        } else if (e.tagName === "li") push("- ");
      },
    })
    .on("code", {
      element(e) {
        if (pre) return;
        push("`");
        e.onEndTag(() => push("`"));
      },
    })
    .onDocument({
      text(t) {
        if (inTitle) {
          title += t.text;
          return;
        }
        push(t.text);
      },
    });
  const res = typeof input === "string" ? new Response(input, { headers: { "Content-Type": "text/html" } }) : input;
  // Consuming the transformed body drives the handlers.
  await rw.transform(res).arrayBuffer();
  const pick = inMain.join("").replace(/\s/g, "").length > 200 ? inMain : all;
  const text = decodeEntities(pick.join(""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: decodeEntities(title).replace(/\s+/g, " ").trim().slice(0, 200), text };
}
