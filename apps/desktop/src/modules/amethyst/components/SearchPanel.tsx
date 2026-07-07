import { useMemo, useState } from "react";
import { IconSearch, IconX } from "@tabler/icons-react";
import type { KbNote, KbVault } from "../types";
import { makeSnippet, searchIndex, type SearchIndex } from "../data/searchIndex";

type FacetKey = "car" | "subteam" | "type";
const FACETS: FacetKey[] = ["car", "subteam", "type"];

function facetValue(n: KbNote, key: FacetKey): string | null {
  const v = n.frontmatter[key];
  return typeof v === "string" ? v : null;
}

// Coarse category for grouping results (keeps meetings, reference, etc. apart).
const CAT_ORDER = ["Design notes", "Reference", "Meetings", "Overview", "Other"];
function categoryOf(n: KbNote): string {
  const t = typeof n.frontmatter.type === "string" ? n.frontmatter.type : "";
  if (t === "meeting" || n.dir.startsWith("Meetings")) return "Meetings";
  if (t === "register" || t === "reference") return "Reference";
  if (t === "moc" || t === "index" || t === "home") return "Overview";
  if (typeof n.frontmatter.subteam === "string") return "Design notes";
  return "Other";
}

export function SearchPanel({
  vault,
  index,
  activeId,
  onSelect,
}: {
  vault: KbVault;
  index: SearchIndex;
  activeId: string | null;
  onSelect: (id: string, highlight?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<FacetKey, string | null>>({
    car: null,
    subteam: null,
    type: null,
  });

  const facetOptions = useMemo(() => {
    const opt: Record<FacetKey, string[]> = { car: [], subteam: [], type: [] };
    for (const key of FACETS) {
      const s = new Set<string>();
      for (const n of vault.notes) {
        const v = facetValue(n, key);
        if (v) s.add(v);
      }
      opt[key] = [...s].sort();
    }
    return opt;
  }, [vault.notes]);

  const results = useMemo(() => {
    let base: KbNote[];
    if (query.trim()) {
      base = searchIndex(index, vault.resolve, query, 200).map((h) => h.note);
    } else {
      base = vault.notes;
    }
    const active = FACETS.filter((k) => filters[k]);
    if (active.length) {
      base = base.filter((n) => active.every((k) => facetValue(n, k) === filters[k]));
    }
    return base.slice(0, 200);
  }, [query, filters, index, vault]);

  const grouped = useMemo(() => {
    const m = new Map<string, KbNote[]>();
    for (const n of results) {
      const c = categoryOf(n);
      (m.get(c) ?? m.set(c, []).get(c)!).push(n);
    }
    return CAT_ORDER.filter((c) => m.has(c)).map((c) => ({ cat: c, notes: m.get(c)! }));
  }, [results]);

  const anyFilter = FACETS.some((k) => filters[k]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 p-2">
        <div className="relative">
          <IconSearch size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-helios-dim" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search everything…"
            className="w-full rounded-md border border-helios-line bg-helios-base py-1.5 pl-8 pr-7 text-sm text-helios-text placeholder:text-helios-dim focus:border-asu-gold/60 focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-helios-dim hover:text-helios-text" aria-label="Clear">
              <IconX size={14} />
            </button>
          )}
        </div>

        {/* facet filters */}
        <div className="space-y-1.5">
          {FACETS.map((key) =>
            facetOptions[key].length > 1 ? (
              <div key={key} className="flex flex-wrap items-center gap-1">
                <span className="mr-0.5 w-14 shrink-0 text-[10px] uppercase tracking-wider text-helios-dim">{key}</span>
                {facetOptions[key].map((val) => {
                  const on = filters[key] === val;
                  return (
                    <button
                      key={val}
                      onClick={() => setFilters((f) => ({ ...f, [key]: on ? null : val }))}
                      className={
                        "rounded-full px-2 py-0.5 text-[11px] transition-colors " +
                        (on ? "bg-asu-gold text-helios-base" : "border border-helios-line text-helios-dim hover:text-helios-text")
                      }
                    >
                      {val}
                    </button>
                  );
                })}
              </div>
            ) : null,
          )}
          {anyFilter && (
            <button onClick={() => setFilters({ car: null, subteam: null, type: null })} className="text-[10px] text-helios-dim underline hover:text-helios-text">
              clear filters
            </button>
          )}
        </div>

        <div className="text-[11px] uppercase tracking-wider text-helios-dim">
          {results.length} {results.length === 1 ? "result" : "results"}
        </div>
      </div>

      <div className="kb-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-3">
        {results.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-helios-dim">Nothing matches.</div>
        ) : (
          grouped.map(({ cat, notes }) => (
            <div key={cat} className="mb-1.5">
              <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-helios-panel/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-asu-gold/70 backdrop-blur">
                {cat}
                <span className="text-helios-dim">{notes.length}</span>
              </div>
              {notes.map((n) => (
                <button
                  key={n.id}
                  onClick={() => onSelect(n.id, query.trim() || undefined)}
                  className={
                    "mb-0.5 block w-full rounded px-2 py-1.5 text-left " +
                    (n.id === activeId ? "bg-asu-gold/15" : "hover:bg-helios-panel")
                  }
                >
                  <div className={"truncate text-sm " + (n.id === activeId ? "text-asu-gold" : "text-helios-text")}>{n.title}</div>
                  <div className="truncate text-[10px] text-helios-dim">{n.dir || "/"}</div>
                  {query.trim() && (
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-helios-dim">
                      {makeSnippet(n.body, query).map((seg, i) =>
                        seg.hit ? (
                          <mark key={i} className="rounded-sm bg-asu-gold/25 px-0.5 text-asu-gold">
                            {seg.text}
                          </mark>
                        ) : (
                          <span key={i}>{seg.text}</span>
                        ),
                      )}
                    </div>
                  )}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
