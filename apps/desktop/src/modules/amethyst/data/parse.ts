import type { KbNote, OutlineItem } from "../types";

// ---- frontmatter -----------------------------------------------------------
// A deliberately small YAML subset that matches how our vault writes notes:
// `key: scalar`, `key: [a, b, c]` inline arrays, and block lists of `- item`.
// Good enough for car/subteam/type/tags/pages/related without pulling in a YAML
// dependency.
export function splitFrontmatter(raw: string): {
  fm: Record<string, string | string[]>;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { fm: {}, body: raw };
  const fm: Record<string, string | string[]> = {};
  const lines = (m[1] ?? "").split(/\r?\n/);
  let curKey: string | null = null;
  let curList: string[] | null = null;
  const flush = () => {
    if (curKey && curList) fm[curKey] = curList;
    curList = null;
  };
  for (const line of lines) {
    if (/^\s*-\s+/.test(line) && curKey) {
      curList = curList ?? [];
      curList.push(stripQuotes(line.replace(/^\s*-\s+/, "").trim()));
      continue;
    }
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (kv && kv[1] !== undefined) {
      flush();
      const key = kv[1];
      curKey = key;
      const val = (kv[2] ?? "").trim();
      if (val === "") {
        curList = []; // a block list likely follows
        fm[key] = [];
      } else if (val.startsWith("[") && val.endsWith("]")) {
        fm[key] = val
          .slice(1, -1)
          .split(",")
          .map((s) => stripQuotes(s.trim()))
          .filter(Boolean);
      } else {
        fm[key] = stripQuotes(val);
      }
    }
  }
  flush();
  return { fm, body: raw.slice(m[0].length) };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---- links / tags / title --------------------------------------------------
const WIKILINK_RE = /(!?)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

/** Raw wikilink targets in a body (non-embed), original form (may be a full
 *  path or a bare basename). */
export function extractWikiTargets(body: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(body))) {
    if (m[1] === "!") continue; // embed, not a link
    const t = m[2];
    if (t) out.push(t.trim());
  }
  return out;
}

export function firstH1(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body);
  return m && m[1] ? m[1].trim() : null;
}

export function extractTags(fm: Record<string, string | string[]>, body: string): string[] {
  const set = new Set<string>();
  const t = fm.tags;
  if (Array.isArray(t)) t.forEach((x) => x && set.add(String(x)));
  else if (typeof t === "string") t.split(/[,\s]+/).forEach((x) => x && set.add(x));
  // inline #tags (skip headings and code by a light heuristic)
  const re = /(?:^|\s)#([A-Za-z][\w-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[1]) set.add(m[1]);
  }
  return [...set];
}

/** Short preview text: the `> **Summary** …` callout if present, else the
 *  first real paragraph. Used for hover previews. */
export function extractSummary(body: string): string {
  const m = /^>\s*\*\*Summary\*\*\s*[—:-]?\s*(.+)$/m.exec(body);
  if (m && m[1]) return m[1].replace(/\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 340);
  for (const raw of body.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    if (/^(#|>|\||!\[\[|-|\*|\d+\.)/.test(t)) continue;
    return t.replace(/[*_`]/g, "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_a, p, al) => al ?? p).slice(0, 340);
  }
  return "";
}

export function makeTitle(
  fm: Record<string, string | string[]>,
  body: string,
  basename: string,
): string {
  const t = fm.title;
  if (typeof t === "string" && t.trim()) return t.trim();
  return firstH1(body) ?? basename;
}

// ---- outline ---------------------------------------------------------------
export function buildOutline(body: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,4})\s+(.+)$/.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const text = m[2].replace(/[*_`~]/g, "").trim();
    let slug = slugify(text);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    out.push({ level: m[1].length, text, slug });
  }
  return out;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

// ---- wikilink resolution ---------------------------------------------------
/** Resolve a wikilink target (full path or bare basename, optional #heading)
 *  to a note id using the vault resolve map. */
export function resolveTarget(
  target: string,
  resolve: Map<string, KbNote>,
): KbNote | null {
  const clean = (target.split("#")[0] ?? "").trim().replace(/\.md$/i, "");
  if (!clean) return null;
  const byPath = resolve.get(clean.toLowerCase());
  if (byPath) return byPath;
  const base = clean.split("/").pop() ?? clean;
  return resolve.get(base.toLowerCase()) ?? null;
}
