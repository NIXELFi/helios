import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconChevronUp, IconX } from "@tabler/icons-react";
import type { KbNote, KbVault } from "../types";
import type { Attachments } from "../data/useAttachments";
import { renderMarkdown } from "../render/markdown";
import { resolveTarget } from "../data/parse";
import { tokenize } from "../data/searchIndex";

const EMBED_RE = /!\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g;

// Highlight terms: for a multi-word query, the contiguous phrase goes first so
// the renderer matches it as one unit (and the view scrolls to it), followed by
// the individual words as a fallback for scattered matches.
function hlTerms(q: string): string[] {
  const words = tokenize(q);
  const phrase = q.toLowerCase().replace(/\s+/g, " ").trim();
  return phrase.includes(" ") ? [phrase, ...words] : words;
}

const CHIP_KEYS: { key: string; label?: string }[] = [
  { key: "car" },
  { key: "subteam" },
  { key: "type" },
  { key: "status" },
  { key: "pages", label: "p." },
];

export function NoteView({
  note,
  vault,
  attachments,
  highlight,
  onNavigate,
  onClearHighlight,
}: {
  note: KbNote;
  vault: KbVault;
  attachments: Attachments;
  highlight?: string | null;
  onNavigate: (id: string) => void;
  onClearHighlight?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [matchCount, setMatchCount] = useState(0);
  const [matchIdx, setMatchIdx] = useState(0);
  const matchIdxRef = useRef(0);
  const autoFollow = useRef(true);

  // Load blob URLs for this note's embeds.
  useEffect(() => {
    const names: string[] = [];
    let m: RegExpExecArray | null;
    EMBED_RE.lastIndex = 0;
    while ((m = EMBED_RE.exec(note.body))) {
      if (m[1]) names.push(m[1].trim());
    }
    if (names.length) attachments.ensure(names);
  }, [note.id, note.body, attachments]);

  // Reset scroll + match navigation when switching notes.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setMatchIdx(0);
    matchIdxRef.current = 0;
    autoFollow.current = true;
  }, [note.id]);

  const html = useMemo(
    () =>
      renderMarkdown(note.body, {
        resolveWiki: (target) => {
          const n = resolveTarget(target, vault.resolve);
          return { id: n?.id ?? null, exists: !!n };
        },
        resolveEmbed: (name) => attachments.resolve(name),
        highlight: highlight ? hlTerms(highlight) : undefined,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note.id, note.body, vault.resolve, attachments.version, highlight],
  );

  // ---- search-match navigation --------------------------------------------
  // Prefer contiguous phrase marks; fall back to individual word hits.
  const getMarks = useCallback((): HTMLElement[] => {
    const root = contentRef.current;
    if (!root) return [];
    const phrase = Array.from(root.querySelectorAll<HTMLElement>("mark.kb-phrase"));
    return phrase.length ? phrase : Array.from(root.querySelectorAll<HTMLElement>("mark.kb-search-hit"));
  }, []);

  const jump = useCallback(
    (delta: number) => {
      autoFollow.current = false;
      const marks = getMarks();
      if (marks.length === 0) return;
      const i = ((matchIdxRef.current + delta) % marks.length + marks.length) % marks.length;
      marks.forEach((mk, j) => mk.classList.toggle("kb-search-current", j === i));
      matchIdxRef.current = i;
      setMatchIdx(i);
      marks[i]?.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    [getMarks],
  );

  // Recompute match count + emphasize the current match whenever the html
  // changes (including as embeds load and reflow). While the user hasn't taken
  // over, keep the current match centered so it doesn't drift off-screen — this
  // is what makes the jump land on the phrase even after images push it down.
  useEffect(() => {
    if (!highlight) {
      setMatchCount(0);
      return;
    }
    const marks = getMarks();
    setMatchCount(marks.length);
    if (marks.length === 0) return;
    const i = Math.min(matchIdxRef.current, marks.length - 1);
    marks.forEach((mk, j) => mk.classList.toggle("kb-search-current", j === i));
    // instant (not smooth) so the match holds steady as embeds reflow above it
    if (autoFollow.current) marks[i]?.scrollIntoView({ block: "center" });
  }, [html, highlight, getMarks]);

  // Once the user scrolls the note themselves, stop auto-centering.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const off = () => {
      autoFollow.current = false;
    };
    el.addEventListener("wheel", off, { passive: true });
    return () => el.removeEventListener("wheel", off);
  }, []);

  // Enter / Shift+Enter cycle matches (when not typing in a field).
  useEffect(() => {
    if (!highlight || matchCount === 0) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter") return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      jump(e.shiftKey ? -1 : 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [highlight, matchCount, jump]);

  function onClick(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest("a[data-wiki]") as HTMLElement | null;
    if (!a) return;
    e.preventDefault();
    const id = a.getAttribute("data-wiki-id");
    if (id) {
      onNavigate(id);
    } else {
      const target = a.getAttribute("data-wiki") ?? "";
      const n = resolveTarget(target, vault.resolve);
      if (n) onNavigate(n.id);
    }
  }

  const crumbs = note.dir ? note.dir.split("/") : [];
  const tags = note.tags.slice(0, 12);

  return (
    <div className="relative h-full">
      {highlight && matchCount > 0 && (
        <div className="helios-modal-in absolute right-4 top-3 z-20 flex items-center gap-0.5 rounded-lg border border-helios-line bg-helios-panel/95 py-0.5 pl-2 pr-1 text-xs shadow-lg backdrop-blur">
          <span className="mr-1 tabular-nums text-helios-dim">
            {matchIdx + 1} / {matchCount}
          </span>
          <button onClick={() => jump(-1)} title="Previous match (Shift+Enter)" className="rounded p-1 text-helios-dim hover:bg-helios-panel hover:text-asu-gold">
            <IconChevronUp size={15} />
          </button>
          <button onClick={() => jump(1)} title="Next match (Enter)" className="rounded p-1 text-helios-dim hover:bg-helios-panel hover:text-asu-gold">
            <IconChevronDown size={15} />
          </button>
          {onClearHighlight && (
            <button onClick={onClearHighlight} title="Clear highlight" className="rounded p-1 text-helios-dim hover:bg-helios-panel hover:text-helios-danger">
              <IconX size={15} />
            </button>
          )}
        </div>
      )}
      <div ref={scrollRef} className="kb-scroll h-full overflow-y-auto">
        <article key={note.id} className="kb-view-in mx-auto max-w-[820px] px-8 py-8">
        {crumbs.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-helios-dim">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-helios-line">/</span>}
                <span>{c}</span>
              </span>
            ))}
          </div>
        )}
        <h1 className="mb-3 text-[2rem] font-bold leading-tight text-helios-text">{note.title}</h1>

        {(CHIP_KEYS.some((c) => note.frontmatter[c.key]) || tags.length > 0) && (
          <div className="mb-6 flex flex-wrap items-center gap-1.5 border-b border-helios-line pb-5">
            {CHIP_KEYS.map(({ key, label }) => {
              const v = note.frontmatter[key];
              if (!v || Array.isArray(v)) return null;
              return (
                <span
                  key={key}
                  className="rounded-full border border-helios-line bg-helios-panel px-2.5 py-0.5 text-xs text-helios-text"
                >
                  <span className="text-helios-dim">{label ?? key}</span>
                  {label ? "" : ": "}
                  <span className="text-asu-gold/90">{v}</span>
                </span>
              );
            })}
            {tags.map((t) => (
              <span key={t} className="rounded-full bg-asu-gold/10 px-2 py-0.5 text-xs text-asu-gold/80">
                #{t}
              </span>
            ))}
          </div>
        )}

        <div
          ref={contentRef}
          className="kb-prose"
          onClick={onClick}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        </article>
      </div>
    </div>
  );
}
