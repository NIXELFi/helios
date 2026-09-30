import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "./markdown";
import {
  WIKI_INDEX, HOME_SLUG, loadPage, loadAllPages, getLoadedPage, type WikiPage,
} from "./pages";

interface HelpModalProps {
  open: boolean;
  initialSlug?: string;
  onClose: () => void;
}

function slugFromWikiHref(href: string): string {
  // Accepts "01-getting-started.md" or "README.md" or "#04-widgets-reference.md".
  let s = href.replace(/^#/, "");
  s = s.replace(/\.md.*$/, "");
  // Strip any leading "./" or path components.
  const last = s.split("/").pop() || "";
  return last;
}

export function HelpModal({ open, initialSlug, onClose }: HelpModalProps) {
  const [slug, setSlug] = useState<string>(initialSlug ?? HOME_SLUG);
  const [history, setHistory] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Wiki pages are fetched on demand (see pages.ts), so the displayed page is
  // state rather than a synchronous lookup. `active` is only ever REPLACED,
  // never cleared, so navigating keeps the previous page on screen until the
  // next one arrives instead of flashing an empty pane.
  const [active, setActive] = useState<WikiPage | null>(
    () => getLoadedPage(initialSlug ?? HOME_SLUG) ?? null,
  );
  // Every page's content, for full-text search and for upgrading the sidebar
  // titles to each page's own `# ` heading. Fetched in the background once the
  // modal is open — a dozen small chunks off local disk, and never at launch.
  const [allPages, setAllPages] = useState<WikiPage[] | null>(null);

  // Sync to initialSlug whenever the modal opens with a different target.
  useEffect(() => {
    if (open) {
      setSlug(initialSlug ?? HOME_SLUG);
      setHistory([]);
    }
  }, [open, initialSlug]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Scroll content to top when a new page is actually shown. Keyed on the
  // rendered page, not the slug: the content element does not exist yet while
  // the first page is still being fetched.
  useEffect(() => {
    // `?.` on scrollTo too: jsdom's Element has no scrollTo, and an
    // uncaught throw in a commit-phase effect unmounts the whole modal.
    contentRef.current?.scrollTo?.({ top: 0 });
  }, [active]);

  // Fetch the page for the current slug. An unknown slug falls back to Home,
  // matching the old synchronous `getPage(slug) ?? getPage(HOME_SLUG)`.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadPage(slug).then((page) => {
      if (cancelled) return;
      if (page) { setActive(page); return; }
      void loadPage(HOME_SLUG).then((home) => {
        if (!cancelled && home) setActive(home);
      });
    });
    return () => { cancelled = true; };
  }, [open, slug]);

  // Background load of the rest of the wiki while the user reads the first page.
  useEffect(() => {
    if (!open || allPages) return;
    let cancelled = false;
    void loadAllPages().then((pages) => { if (!cancelled) setAllPages(pages); });
    return () => { cancelled = true; };
  }, [open, allPages]);

  const activeSlug = active?.slug ?? slug;
  const html = useMemo(
    () => (active ? renderMarkdown(active.content) : ""),
    [active],
  );

  /** Sidebar entries: filenames give the list immediately; each page's real
   *  heading replaces the derived title as soon as its content is in. */
  const sidebarPages = useMemo(() => {
    const loaded = new Map((allPages ?? []).map((p) => [p.slug, p.title]));
    if (active) loaded.set(active.slug, active.title);
    return WIKI_INDEX.map((m) => ({ ...m, title: loaded.get(m.slug) ?? m.title }));
  }, [allPages, active]);

  const filteredPages = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sidebarPages;
    // Until every page's text has arrived, search what we do have: the titles.
    if (!allPages) {
      return sidebarPages.filter((p) => p.title.toLowerCase().includes(q));
    }
    const matched = new Set(
      allPages
        .filter(
          (p) =>
            p.title.toLowerCase().includes(q) ||
            p.content.toLowerCase().includes(q),
        )
        .map((p) => p.slug),
    );
    return sidebarPages.filter((p) => matched.has(p.slug));
  }, [search, sidebarPages, allPages]);

  function navigate(nextSlug: string) {
    if (!WIKI_INDEX.some((p) => p.slug === nextSlug)) return;
    setHistory((h) => [...h, slug]);
    setSlug(nextSlug);
  }

  function goBack() {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1]!;
      setSlug(prev);
      return h.slice(0, -1);
    });
  }

  function onContentClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const anchor = target.closest("a") as HTMLAnchorElement | null;
    if (!anchor) return;
    const wiki = anchor.getAttribute("data-wiki-link");
    if (wiki) {
      e.preventDefault();
      navigate(slugFromWikiHref(wiki));
      return;
    }
    const repo = anchor.getAttribute("data-repo-link");
    if (repo) {
      // Repo-relative path. Open in the user's browser via target=_blank
      // (the GitHub-rendered version of this same wiki page would resolve it).
      e.preventDefault();
      const url = `https://github.com/NIXELFi/helios/blob/main/${repo.replace(/^\.\.\//, "").replace(/^docs\//, "docs/")}`;
      window.open(url, "_blank", "noreferrer,noopener");
    }
    // External http(s) anchors keep their default browser behavior.
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center helios-overlay-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Help & Wiki"
    >
      <div
        className="bg-helios-base border border-helios-line rounded-md helios-elevate helios-modal-in flex flex-col"
        style={{ width: "min(1200px, 92vw)", height: "min(820px, 88vh)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-helios-line px-4 py-2">
          <div className="flex items-center gap-3">
            <span className="font-helios text-asu-gold text-sm">HELIOS</span>
            <span className="text-helios-dim text-xs">Help &amp; Wiki</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goBack}
              disabled={history.length === 0}
              className="text-xs px-2 py-1 rounded border border-helios-line text-helios-dim hover:text-helios-text hover:border-helios-text disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Back"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-2 py-1 rounded border border-helios-line text-helios-dim hover:text-helios-text hover:border-helios-text"
              aria-label="Close"
            >
              Esc
            </button>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <nav
            className="w-64 shrink-0 border-r border-helios-line p-3 overflow-y-auto"
            aria-label="Wiki pages"
          >
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pages…"
              className="w-full mb-3 px-2 py-1 text-xs bg-helios-panel border border-helios-line rounded text-helios-text placeholder:text-helios-dim focus:outline-none focus:border-asu-gold"
            />
            <ul className="space-y-0.5">
              {filteredPages.map((p) => (
                <li key={p.slug}>
                  <button
                    type="button"
                    onClick={() => {
                      setHistory((h) => [...h, slug]);
                      setSlug(p.slug);
                    }}
                    className={
                      "w-full text-left text-xs px-2 py-1.5 rounded transition-colors " +
                      (p.slug === activeSlug
                        ? "bg-helios-panel text-asu-gold border-l-2 border-asu-gold"
                        : "text-helios-text hover:bg-helios-panel hover:text-asu-gold")
                    }
                  >
                    {p.title}
                  </button>
                </li>
              ))}
              {filteredPages.length === 0 && (
                <li className="text-xs text-helios-dim italic px-2 py-1">
                  No matches.
                </li>
              )}
            </ul>
          </nav>

          {/* Content. Only ever empty on the very first frame after opening —
              navigating between pages keeps the previous one on screen. */}
          {active ? (
            <div
              ref={contentRef}
              className="flex-1 min-w-0 overflow-y-auto px-8 py-6 helios-wiki-prose"
              onClick={onContentClick}
              // Rendered markdown is generated locally (no remote input) and
              // escaped by the renderer, so dangerouslySetInnerHTML is safe.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <div className="flex-1 min-w-0 flex items-center justify-center text-helios-dim text-xs">
              Loading…
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-helios-line px-4 py-2 text-[10px] text-helios-dim font-mono-num">
          <span>
            Source: <code>docs/wiki/{activeSlug}.md</code>
          </span>
          <span>
            Edit on{" "}
            <a
              href={`https://github.com/NIXELFi/helios/blob/main/docs/wiki/${activeSlug}.md`}
              target="_blank"
              rel="noreferrer noopener"
              className="text-asu-gold hover:underline"
            >
              GitHub
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}
