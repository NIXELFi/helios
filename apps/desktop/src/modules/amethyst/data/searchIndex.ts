import type { KbNote } from "../types";

// A small in-memory inverted index. Built once per vault load (rebuilt on the
// watcher's debounced reload) so search stays O(matches) rather than O(notes ×
// length) per keystroke — this is what keeps the wiki fast as it grows to
// thousands of notes. Extensible: add fields/weights here and search() picks
// them up.

export interface SearchIndex {
  /** term -> (noteId -> weighted term frequency) */
  postings: Map<string, Map<string, number>>;
  /** number of indexed notes (for idf) */
  n: number;
}

export interface SearchHit {
  note: KbNote;
  score: number;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "with", "as", "at", "by", "be", "this", "that", "it", "from", "was", "were",
]);

export function tokenize(s: string): string[] {
  const out: string[] = [];
  const m = s.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g);
  if (!m) return out;
  for (const t of m) if (!STOP.has(t)) out.push(t);
  return out;
}

// Field weights: title & tags are stronger signals than body prose.
const W_TITLE = 6;
const W_TAG = 5;
const W_FM = 3;
const W_BODY = 1;

export function buildIndex(notes: KbNote[]): SearchIndex {
  const postings: SearchIndex["postings"] = new Map();
  const add = (term: string, id: string, w: number) => {
    let m = postings.get(term);
    if (!m) postings.set(term, (m = new Map()));
    m.set(id, (m.get(id) ?? 0) + w);
  };
  for (const note of notes) {
    for (const t of tokenize(note.title)) add(t, note.id, W_TITLE);
    for (const tag of note.tags) for (const t of tokenize(tag)) add(t, note.id, W_TAG);
    for (const v of Object.values(note.frontmatter)) {
      const s = Array.isArray(v) ? v.join(" ") : v;
      for (const t of tokenize(s)) add(t, note.id, W_FM);
    }
    for (const t of tokenize(note.body)) add(t, note.id, W_BODY);
  }
  return { postings, n: notes.length };
}

/**
 * Rank notes for a query. Terms are AND-combined (every term must appear) with
 * a tf·idf-style score; a final prefix pass lets partial last-words match while
 * typing. Returns note ids scored high→low.
 */
export function searchIndex(
  index: SearchIndex,
  byId: Map<string, KbNote>,
  query: string,
  limit = 100,
): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  // Resolve each term's postings; support a trailing prefix on the last term so
  // "restrict" matches "restrictor" mid-type.
  const perTerm: Map<string, number>[] = [];
  terms.forEach((term, i) => {
    const exact = index.postings.get(term);
    const isLast = i === terms.length - 1;
    if (exact && !isLast) {
      perTerm.push(exact);
      return;
    }
    // last term (or unknown): merge prefix matches
    const merged = new Map<string, number>();
    if (exact) for (const [id, w] of exact) merged.set(id, w);
    if (isLast) {
      for (const [t, m] of index.postings) {
        if (t.length > term.length && t.startsWith(term)) {
          for (const [id, w] of m) merged.set(id, Math.max(merged.get(id) ?? 0, w * 0.6));
        }
      }
    }
    perTerm.push(merged);
  });

  if (perTerm.some((m) => m.size === 0)) return [];

  // Intersect on the smallest posting list, score with idf.
  const smallest = perTerm.reduce((a, b) => (a.size <= b.size ? a : b));
  const hits: SearchHit[] = [];
  for (const id of smallest.keys()) {
    let score = 0;
    let all = true;
    for (const m of perTerm) {
      const tf = m.get(id);
      if (tf === undefined) {
        all = false;
        break;
      }
      const df = m.size || 1;
      const idf = Math.log(1 + index.n / df);
      score += tf * idf;
    }
    if (!all) continue;
    const note = byId.get(id.toLowerCase());
    if (note) hits.push({ note, score });
  }
  hits.sort((a, b) => b.score - a.score || a.note.title.localeCompare(b.note.title));
  return hits.slice(0, limit);
}

// ---- snippet with highlighted terms -----------------------------------------
export interface Segment {
  text: string;
  hit: boolean;
}

export function makeSnippet(body: string, query: string, radius = 120): Segment[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [{ text: body.slice(0, radius * 2), hit: false }];
  const lower = body.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return [{ text: body.slice(0, radius * 2).trim(), hit: false }];
  const start = Math.max(0, at - radius);
  const end = Math.min(body.length, at + radius);
  let text = body.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) text = "… " + text;
  if (end < body.length) text = text + " …";

  // Split into highlighted / plain segments (case-insensitive, term boundaries).
  const re = new RegExp(`(${terms.map(escapeReg).join("|")})`, "ig");
  const segs: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index), hit: false });
    segs.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last), hit: false });
  return segs;
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
