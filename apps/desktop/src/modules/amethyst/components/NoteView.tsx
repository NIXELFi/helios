import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconChevronUp, IconSearch, IconX } from "@tabler/icons-react";
import type { KbNote, KbVault } from "../types";
import type { Attachments } from "../data/useAttachments";
import { renderMarkdown } from "../render/markdown";
import { resolveTarget } from "../data/parse";
import { tokenize } from "../data/searchIndex";

const EMBED_RE = /!\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g;

function hlTerms(q: string): string[] {
  const words = tokenize(q);
  const phrase = q.toLowerCase().replace(/\s+/g, " ").trim();
  return phrase.includes(" ") ? [phrase, ...words] : words;
}

type FacetKey = "car" | "subteam" | "type";
const CHIP_KEYS: { key: string; label?: string; facet?: FacetKey }[] = [
  { key: "car", facet: "car" },
  { key: "subteam", facet: "subteam" },
  { key: "type", facet: "type" },
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
  onFacet,
  onTag,
  onActiveHeading,
}: {
  note: KbNote;
  vault: KbVault;
  attachments: Attachments;
  highlight?: string | null;
  onNavigate: (id: string) => void;
  onClearHighlight?: () => void;
  onFacet?: (key: FacetKey, value: string) => void;
  onTag?: (tag: string) => void;
  onActiveHeading?: (slug: string | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [matchCount, setMatchCount] = useState(0);
  const [matchIdx, setMatchIdx] = useState(0);
  const matchIdxRef = useRef(0);
  const autoFollow = useRef(true);
  const [findOpen, setFindOpen] = useState(false);
  const [findTerm, setFindTerm] = useState("");
  const findRef = useRef<HTMLInputElement | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; caption: string } | null>(null);

  // In find mode the find term drives highlighting; otherwise the search phrase.
  const effHighlight = findOpen ? findTerm : highlight ?? "";

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

  // Reset scroll + find on note switch.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setFindOpen(false);
    setFindTerm("");
  }, [note.id]);

  // Jump to the first match when the highlight/find term changes.
  useEffect(() => {
    setMatchIdx(0);
    matchIdxRef.current = 0;
    autoFollow.current = true;
  }, [effHighlight, note.id]);

  const html = useMemo(
    () =>
      renderMarkdown(note.body, {
        resolveWiki: (target) => {
          const n = resolveTarget(target, vault.resolve);
          return { id: n?.id ?? null, exists: !!n };
        },
        resolveEmbed: (name) => attachments.resolve(name),
        highlight: effHighlight ? hlTerms(effHighlight) : undefined,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note.id, note.body, vault.resolve, attachments.version, effHighlight],
  );

  // ---- match navigation ----
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
      const i = (((matchIdxRef.current + delta) % marks.length) + marks.length) % marks.length;
      marks.forEach((mk, j) => mk.classList.toggle("kb-search-current", j === i));
      matchIdxRef.current = i;
      setMatchIdx(i);
      marks[i]?.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    [getMarks],
  );

  // Recompute + keep the current match centered as embeds reflow the page.
  useEffect(() => {
    if (!effHighlight) {
      setMatchCount(0);
      return;
    }
    const marks = getMarks();
    setMatchCount(marks.length);
    if (marks.length === 0) return;
    const i = Math.min(matchIdxRef.current, marks.length - 1);
    marks.forEach((mk, j) => mk.classList.toggle("kb-search-current", j === i));
    if (autoFollow.current) marks[i]?.scrollIntoView({ block: "center" });
  }, [html, effHighlight, getMarks]);

  // Stop auto-centering once the user scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const off = () => {
      autoFollow.current = false;
    };
    el.addEventListener("wheel", off, { passive: true });
    return () => el.removeEventListener("wheel", off);
  }, []);

  // Ctrl+F opens in-note find; Enter/Shift+Enter cycle matches; Escape closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => findRef.current?.focus(), 0);
        return;
      }
      if (e.key === "Escape") {
        if (lightbox) {
          setLightbox(null);
          return;
        }
        if (findOpen) {
          setFindOpen(false);
          setFindTerm("");
        }
        return;
      }
      if (e.key === "Enter" && effHighlight && matchCount > 0) {
        const t = e.target as HTMLElement;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault();
        jump(e.shiftKey ? -1 : 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [findOpen, lightbox, effHighlight, matchCount, jump]);

  // ---- scroll-spy: report the heading currently at the top of the reader ----
  useEffect(() => {
    const root = scrollRef.current;
    const content = contentRef.current;
    if (!root || !content || !onActiveHeading) return;
    const heads = Array.from(content.querySelectorAll<HTMLElement>(".kb-h[id]"));
    if (heads.length === 0) {
      onActiveHeading(null);
      return;
    }
    const compute = () => {
      let best: string | null = heads[0]?.id ?? null;
      for (const h of heads) {
        if (h.getBoundingClientRect().top - root.getBoundingClientRect().top <= 90) best = h.id;
        else break;
      }
      onActiveHeading(best);
    };
    compute();
    root.addEventListener("scroll", compute, { passive: true });
    return () => root.removeEventListener("scroll", compute);
  }, [html, onActiveHeading]);

  function onClick(e: React.MouseEvent) {
    const el = e.target as HTMLElement;
    const img = el.closest("img.kb-embed") as HTMLImageElement | null;
    if (img) {
      let caption = img.getAttribute("alt") ?? "";
      const next = img.closest("p")?.nextElementSibling;
      if (next && next.tagName === "P" && next.querySelector("em")) caption = next.textContent?.trim() ?? caption;
      setLightbox({ src: img.src, caption });
      return;
    }
    const a = el.closest("a[data-wiki]") as HTMLElement | null;
    if (!a) return;
    e.preventDefault();
    const id = a.getAttribute("data-wiki-id");
    if (id) onNavigate(id);
    else {
      const n = resolveTarget(a.getAttribute("data-wiki") ?? "", vault.resolve);
      if (n) onNavigate(n.id);
    }
  }

  const crumbs = note.dir ? note.dir.split("/") : [];
  const tags = note.tags.slice(0, 12);
  const car = typeof note.frontmatter.car === "string" ? note.frontmatter.car : null;
  const subteam = typeof note.frontmatter.subteam === "string" ? note.frontmatter.subteam : null;

  const showBar = findOpen || (!!effHighlight && matchCount > 0);

  return (
    <div className="relative h-full">
      {showBar && (
        <div className="helios-modal-in absolute right-4 top-3 z-20 flex items-center gap-1 rounded-lg border border-helios-line bg-helios-panel/95 py-1 pl-2 pr-1 text-xs shadow-lg backdrop-blur">
          {findOpen && (
            <div className="relative">
              <IconSearch size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-helios-dim" />
              <input
                ref={findRef}
                value={findTerm}
                onChange={(e) => setFindTerm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    jump(e.shiftKey ? -1 : 1);
                  }
                }}
                placeholder="Find in note…"
                className="w-40 rounded border border-helios-line bg-helios-base py-1 pl-7 pr-2 text-xs text-helios-text placeholder:text-helios-dim focus:border-asu-gold/60 focus:outline-none"
              />
            </div>
          )}
          <span className="mx-1 tabular-nums text-helios-dim">
            {matchCount > 0 ? `${matchIdx + 1} / ${matchCount}` : "0"}
          </span>
          <button onClick={() => jump(-1)} title="Previous (Shift+Enter)" className="rounded p-1 text-helios-dim hover:bg-helios-panel hover:text-asu-gold">
            <IconChevronUp size={15} />
          </button>
          <button onClick={() => jump(1)} title="Next (Enter)" className="rounded p-1 text-helios-dim hover:bg-helios-panel hover:text-asu-gold">
            <IconChevronDown size={15} />
          </button>
          <button
            onClick={() => {
              if (findOpen) {
                setFindOpen(false);
                setFindTerm("");
              } else onClearHighlight?.();
            }}
            title={findOpen ? "Close find (Esc)" : "Clear highlight"}
            className="rounded p-1 text-helios-dim hover:bg-helios-panel hover:text-helios-danger"
          >
            <IconX size={15} />
          </button>
        </div>
      )}

      <div ref={scrollRef} className="kb-scroll h-full overflow-y-auto">
        <article key={note.id} className="kb-view-in mx-auto max-w-[820px] px-8 py-8">
          {crumbs.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-helios-dim">
              {crumbs.map((c, i) => {
                const facet: FacetKey | null = c === car ? "car" : c === subteam ? "subteam" : null;
                return (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-helios-line">/</span>}
                    {facet && onFacet ? (
                      <button onClick={() => onFacet(facet, c)} className="rounded hover:text-asu-gold hover:underline">
                        {c}
                      </button>
                    ) : (
                      <span>{c}</span>
                    )}
                  </span>
                );
              })}
            </div>
          )}
          <h1 className="mb-3 text-[2rem] font-bold leading-tight text-helios-text">{note.title}</h1>

          {(CHIP_KEYS.some((c) => note.frontmatter[c.key]) || tags.length > 0) && (
            <div className="mb-6 flex flex-wrap items-center gap-1.5 border-b border-helios-line pb-5">
              {CHIP_KEYS.map(({ key, label, facet }) => {
                const v = note.frontmatter[key];
                if (!v || Array.isArray(v)) return null;
                const clickable = facet && onFacet;
                const inner = (
                  <>
                    <span className="text-helios-dim">{label ?? key}</span>
                    {label ? "" : ": "}
                    <span className="text-asu-gold/90">{v}</span>
                  </>
                );
                return clickable ? (
                  <button
                    key={key}
                    onClick={() => onFacet(facet, v)}
                    title={`Find all ${facet} = ${v}`}
                    className="rounded-full border border-helios-line bg-helios-panel px-2.5 py-0.5 text-xs text-helios-text transition-colors hover:border-asu-gold/60 hover:bg-asu-gold/10"
                  >
                    {inner}
                  </button>
                ) : (
                  <span key={key} className="rounded-full border border-helios-line bg-helios-panel px-2.5 py-0.5 text-xs text-helios-text">
                    {inner}
                  </span>
                );
              })}
              {tags.map((t) =>
                onTag ? (
                  <button
                    key={t}
                    onClick={() => onTag(t)}
                    title={`Search #${t}`}
                    className="rounded-full bg-asu-gold/10 px-2 py-0.5 text-xs text-asu-gold/80 transition-colors hover:bg-asu-gold/20 hover:text-asu-gold"
                  >
                    #{t}
                  </button>
                ) : (
                  <span key={t} className="rounded-full bg-asu-gold/10 px-2 py-0.5 text-xs text-asu-gold/80">
                    #{t}
                  </span>
                ),
              )}
            </div>
          )}

          <div ref={contentRef} className="kb-prose" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
        </article>
      </div>

      {lightbox && (
        <div
          className="helios-overlay-in fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-8"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox.src}
            alt={lightbox.caption}
            className="max-h-[86vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          {lightbox.caption && <div className="mt-3 max-w-[70vw] text-center text-sm text-helios-text/80">{lightbox.caption}</div>}
          <button
            onClick={() => setLightbox(null)}
            className="absolute right-5 top-5 rounded-full bg-helios-panel/80 p-2 text-helios-dim hover:text-helios-text"
            aria-label="Close"
          >
            <IconX size={20} />
          </button>
        </div>
      )}
    </div>
  );
}
