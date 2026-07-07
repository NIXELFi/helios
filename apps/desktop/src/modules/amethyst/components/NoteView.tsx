import { useEffect, useMemo, useRef } from "react";
import type { KbNote, KbVault } from "../types";
import type { Attachments } from "../data/useAttachments";
import { renderMarkdown } from "../render/markdown";
import { resolveTarget } from "../data/parse";
import { tokenize } from "../data/searchIndex";

const EMBED_RE = /!\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g;

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
}: {
  note: KbNote;
  vault: KbVault;
  attachments: Attachments;
  highlight?: string | null;
  onNavigate: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrolledKey = useRef<string>("");

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

  // Reset scroll to top when switching notes.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [note.id]);

  const html = useMemo(
    () =>
      renderMarkdown(note.body, {
        resolveWiki: (target) => {
          const n = resolveTarget(target, vault.resolve);
          return { id: n?.id ?? null, exists: !!n };
        },
        resolveEmbed: (name) => attachments.resolve(name),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note.id, note.body, vault.resolve, attachments.version],
  );

  // Highlight search terms in the rendered note and jump to the first match
  // when the note was opened from the search pane.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    root.querySelectorAll("mark.kb-search-hit").forEach((mk) => {
      mk.replaceWith(document.createTextNode(mk.textContent ?? ""));
    });
    root.normalize();
    const terms = highlight ? tokenize(highlight) : [];
    if (terms.length === 0) return;
    const alt = terms.map(escapeReg).join("|");
    const has = new RegExp(alt, "i");
    const split = new RegExp(`(${alt})`, "ig");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const tn = node as Text;
      if (!tn.nodeValue || !has.test(tn.nodeValue)) continue;
      if (tn.parentElement?.closest("a.kb-link")) continue;
      targets.push(tn);
    }
    let first: HTMLElement | null = null;
    for (const tn of targets) {
      const text = tn.nodeValue ?? "";
      const frag = document.createDocumentFragment();
      let last = 0;
      split.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = split.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const mk = document.createElement("mark");
        mk.className = "kb-search-hit";
        mk.textContent = m[0];
        if (!first) {
          first = mk;
          mk.classList.add("kb-search-first");
        }
        frag.appendChild(mk);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      tn.replaceWith(frag);
    }
    const key = `${note.id}|${highlight ?? ""}`;
    if (first && scrolledKey.current !== key) {
      scrolledKey.current = key;
      first.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [html, highlight, note.id]);

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
  );
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
