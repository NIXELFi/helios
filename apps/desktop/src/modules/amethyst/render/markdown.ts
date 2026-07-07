import MarkdownIt from "markdown-it";
import { slugify } from "../data/parse";

// Resolvers are threaded per-render via markdown-it's `env` so the singleton
// instance stays stateless. resolveWiki -> {id, exists} for a wikilink target;
// resolveEmbed -> an <img>-ready URL (blob:) for an attachment filename.
export interface RenderEnv {
  resolveWiki?: (target: string) => { id: string | null; exists: boolean };
  resolveEmbed?: (name: string) => string | null;
  headingSlugs?: Map<string, number>;
  /** Lowercased search terms to wrap in <mark> (jump-to-match from search). */
  highlight?: string[];
}

const md = new MarkdownIt({
  html: false, // vault files are user-trusted, but escape raw HTML anyway
  linkify: true,
  breaks: false,
  typographer: true,
});
md.enable("table");

// Heading anchors (so the outline can scroll to a section).
md.renderer.rules.heading_open = (tokens, idx, options, env: RenderEnv, self) => {
  const token = tokens[idx];
  if (!token) return self.renderToken(tokens, idx, options);
  const inline = tokens[idx + 1];
  const text = inline && inline.type === "inline" ? inline.content.replace(/[*_`~]/g, "") : "";
  const slugs = env.headingSlugs ?? (env.headingSlugs = new Map());
  let slug = slugify(text);
  const n = slugs.get(slug) ?? 0;
  slugs.set(slug, n + 1);
  if (n > 0) slug = `${slug}-${n}`;
  token.attrSet("id", slug);
  token.attrJoin("class", "kb-h");
  return self.renderToken(tokens, idx, options);
};

// Wikilinks: preprocessed into [label](kbwiki:target). Render as an internal
// link carrying data-wiki (the NoteView delegates clicks) + resolved styling.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env: RenderEnv, self) => {
  const token = tokens[idx];
  if (!token) return defaultLinkOpen(tokens, idx, options, env, self);
  const href = token.attrGet("href") ?? "";
  if (href.startsWith("kbwiki:")) {
    const target = decodeURIComponent(href.slice("kbwiki:".length));
    const res = env.resolveWiki?.(target) ?? { id: null, exists: false };
    token.attrSet("href", "#");
    token.attrSet("data-wiki", target);
    if (res.id) token.attrSet("data-wiki-id", res.id);
    token.attrJoin("class", res.exists ? "kb-link" : "kb-link kb-link-missing");
    return self.renderToken(tokens, idx, options);
  }
  if (/^https?:/i.test(href)) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noreferrer");
    token.attrJoin("class", "kb-extlink");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Embeds: preprocessed into ![](kbembed:filename). Resolve to a blob URL.
md.renderer.rules.image = (tokens, idx, options, env: RenderEnv, self) => {
  const token = tokens[idx];
  if (!token) return self.renderToken(tokens, idx, options);
  const src = token.attrGet("src") ?? "";
  if (src.startsWith("kbembed:")) {
    const name = decodeURIComponent(src.slice("kbembed:".length));
    const url = env.resolveEmbed?.(name);
    if (url) {
      return `<img class="kb-embed" src="${md.utils.escapeHtml(url)}" alt="${md.utils.escapeHtml(name)}" loading="lazy" />`;
    }
    return `<span class="kb-embed-missing">▢ ${md.utils.escapeHtml(name)}</span>`;
  }
  return self.renderToken(tokens, idx, options);
};

// Search highlighting at the text-token level, so the <mark>s are part of the
// rendered HTML and survive React re-renders (e.g. as embeds finish loading).
const defaultText =
  md.renderer.rules.text ?? ((tokens, idx) => md.utils.escapeHtml(tokens[idx]?.content ?? ""));
md.renderer.rules.text = (tokens, idx, options, env: RenderEnv, self) => {
  const token = tokens[idx];
  const terms = env.highlight;
  if (!token || !terms || terms.length === 0) return defaultText(tokens, idx, options, env, self);
  const content = token.content;
  // Phrase-first alternation with whitespace-tolerant terms, so a contiguous
  // phrase ("rear wing structure") is matched as one unit and tagged kb-phrase.
  const alt = terms.map((t) => escapeReg(t).replace(/ /g, "\\s+")).join("|");
  const re = new RegExp(`(${alt})`, "ig");
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out += md.utils.escapeHtml(content.slice(last, m.index));
    const cls = /\s/.test(m[0]) ? "kb-search-hit kb-phrase" : "kb-search-hit";
    out += `<mark class="${cls}">${md.utils.escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  if (last < content.length) out += md.utils.escapeHtml(content.slice(last));
  return out;
};

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Obsidian callouts: `> [!type] Title` becomes a titled, colored blockquote.
function transformCallouts(src: string): string {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const m = /^>\s*\[!(\w+)\]([+-]?)\s*(.*)$/.exec(line);
    if (m && m[1] !== undefined) {
      const type = m[1].toLowerCase();
      const title = (m[3] ?? "").trim() || (type[0]!.toUpperCase() + type.slice(1));
      out.push(`> <span class="kb-callout-title kb-callout-${type}">${escapeHtml(title)}</span>`);
      out.push(">");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
}

// Convert Obsidian embeds/wikilinks into standard markdown carrying our custom
// schemes, then let markdown-it + the rules above finish the job.
function preprocess(src: string): string {
  let s = src;
  // ![[file]] or ![[file|size]]  ->  ![](kbembed:file)
  s = s.replace(/!\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g, (_all, f: string) => {
    return `![](kbembed:${encodeURIComponent(f.trim())})`;
  });
  // [[target|alias]] / [[target]] / [[target#heading|alias]]
  s = s.replace(
    /\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
    (_all, target: string, _hash: string | undefined, alias: string | undefined) => {
      const label = (alias ?? target.split("/").pop() ?? target).trim();
      return `[${label}](kbwiki:${encodeURIComponent(target.trim())})`;
    },
  );
  s = transformCallouts(s);
  return s;
}

export function renderMarkdown(body: string, env: RenderEnv): string {
  const e: RenderEnv = { ...env, headingSlugs: new Map() };
  return md.render(preprocess(body), e);
}
