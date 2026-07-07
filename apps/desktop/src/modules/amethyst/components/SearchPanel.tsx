import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconSearch, IconX } from "@tabler/icons-react";
import type { KbNote, KbVault } from "../types";
import { makeSnippet, searchIndex, type SearchIndex } from "../data/searchIndex";
import { NotePreviewCard, useNotePreview } from "./HoverPreview";

type FacetKey = "car" | "subteam" | "type";
const FACETS: { key: FacetKey; label: string }[] = [
  { key: "car", label: "Car" },
  { key: "subteam", label: "Subteam" },
  { key: "type", label: "Type" },
];

export interface SearchState {
  query: string;
  filters: Record<FacetKey, string>;
  phraseOnly: boolean;
}
export const EMPTY_SEARCH: SearchState = { query: "", filters: { car: "", subteam: "", type: "" }, phraseOnly: false };

function facetValue(n: KbNote, key: FacetKey): string | null {
  const v = n.frontmatter[key];
  return typeof v === "string" ? v : null;
}

const CAT_ORDER = ["Design notes", "Reference", "Meetings", "Overview", "Other"];
function categoryOf(n: KbNote): string {
  const t = typeof n.frontmatter.type === "string" ? n.frontmatter.type : "";
  if (t === "meeting" || n.dir.startsWith("Meetings")) return "Meetings";
  if (t === "register" || t === "reference") return "Reference";
  if (t === "moc" || t === "index" || t === "home") return "Overview";
  if (typeof n.frontmatter.subteam === "string") return "Design notes";
  return "Other";
}

interface Group {
  cat: string;
  count: number;
  subgroups: { name: string | null; notes: KbNote[] }[];
}

export function SearchPanel({
  vault,
  index,
  activeId,
  search,
  onSearchChange,
  onSelect,
}: {
  vault: KbVault;
  index: SearchIndex;
  activeId: string | null;
  search: SearchState;
  onSearchChange: (s: SearchState) => void;
  onSelect: (id: string, highlight?: string) => void;
}) {
  const { query, filters, phraseOnly } = search;
  const setQuery = (v: string) => onSearchChange({ ...search, query: v });
  const setFilter = (key: FacetKey, v: string) => onSearchChange({ ...search, filters: { ...search.filters, [key]: v } });
  const clearFilters = () => onSearchChange({ ...search, filters: { car: "", subteam: "", type: "" } });
  const togglePhrase = () => onSearchChange({ ...search, phraseOnly: !search.phraseOnly });

  const { preview, show, hide } = useNotePreview();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [sel, setSel] = useState(0);

  const facetOptions = useMemo(() => {
    const opt: Record<FacetKey, string[]> = { car: [], subteam: [], type: [] };
    for (const { key } of FACETS) {
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
    if (query.trim()) base = searchIndex(index, vault.resolve, query, 300, { phraseOnly }).map((h) => h.note);
    else base = vault.notes;
    const active = FACETS.map((f) => f.key).filter((k) => filters[k]);
    if (active.length) base = base.filter((n) => active.every((k) => facetValue(n, k) === filters[k]));
    return base.slice(0, 300);
  }, [query, filters, phraseOnly, index, vault]);

  const grouped = useMemo<Group[]>(() => {
    const cats = new Map<string, KbNote[]>();
    for (const n of results) {
      const c = categoryOf(n);
      (cats.get(c) ?? cats.set(c, []).get(c)!).push(n);
    }
    return CAT_ORDER.filter((c) => cats.has(c)).map((c) => {
      const notes = cats.get(c)!;
      if (c === "Design notes") {
        const sub = new Map<string, KbNote[]>();
        for (const n of notes) {
          const st = typeof n.frontmatter.subteam === "string" ? n.frontmatter.subteam : "—";
          (sub.get(st) ?? sub.set(st, []).get(st)!).push(n);
        }
        const subgroups = [...sub.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([name, ns]) => ({ name, notes: ns }));
        return { cat: c, count: notes.length, subgroups };
      }
      return { cat: c, count: notes.length, subgroups: [{ name: null, notes }] };
    });
  }, [results]);

  // Flat ordered list (across groups) for keyboard navigation.
  const flat = useMemo(() => grouped.flatMap((g) => g.subgroups.flatMap((sg) => sg.notes)), [grouped]);
  const flatIdx = useMemo(() => new Map(flat.map((n, i) => [n.id, i])), [flat]);

  useEffect(() => setSel(0), [query, phraseOnly, filters.car, filters.subteam, filters.type]);
  useEffect(() => {
    listRef.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const n = flat[sel];
      if (n) onSelect(n.id, query.trim() || undefined);
    }
  }

  const anyFilter = FACETS.some((f) => filters[f.key]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2.5 border-b border-helios-line/70 p-2.5">
        <div className="relative">
          <IconSearch size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-helios-dim" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search everything…"
            className="w-full rounded-lg border border-helios-line bg-helios-base py-2 pl-8 pr-8 text-sm text-helios-text placeholder:text-helios-dim/80 focus:border-asu-gold/60 focus:outline-none focus:ring-1 focus:ring-asu-gold/30"
          />
          {query && (
            <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-helios-dim hover:text-helios-text" aria-label="Clear">
              <IconX size={14} />
            </button>
          )}
        </div>

        <button
          onClick={togglePhrase}
          title="Only match notes that contain the exact phrase you typed"
          className={
            "flex items-center gap-2 rounded-md px-1.5 py-1 text-[11px] transition-colors " +
            (phraseOnly ? "text-asu-gold" : "text-helios-dim hover:text-helios-text")
          }
        >
          <span className={"flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border transition-colors " + (phraseOnly ? "border-asu-gold bg-asu-gold" : "border-helios-line")}>
            {phraseOnly && (
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 text-helios-base" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M2.5 6.5l2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
          Exact phrase
        </button>

        <div className="grid grid-cols-3 gap-1.5">
          {FACETS.map(({ key, label }) =>
            facetOptions[key].length > 1 ? (
              <FilterSelect key={key} label={label} value={filters[key]} options={facetOptions[key]} onChange={(v) => setFilter(key, v)} />
            ) : (
              <div key={key} />
            ),
          )}
        </div>
        {anyFilter && (
          <button onClick={clearFilters} className="text-[10px] text-helios-dim underline decoration-dotted hover:text-helios-text">
            clear filters
          </button>
        )}
      </div>

      <div ref={listRef} className="kb-scroll min-h-0 flex-1 overflow-y-auto py-1">
        {results.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-helios-dim">
            Nothing matches.
            {anyFilter && (
              <button onClick={clearFilters} className="mt-2 block w-full text-asu-gold underline">
                clear filters
              </button>
            )}
          </div>
        ) : (
          grouped.map((g) => (
            <div key={g.cat} className="mb-1">
              <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-helios-line/50 bg-helios-panel/95 px-2.5 py-1.5 backdrop-blur">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-asu-gold/80">{g.cat}</span>
                <span className="rounded-full bg-helios-line/50 px-1.5 text-[10px] text-helios-dim">{g.count}</span>
              </div>
              {g.subgroups.map((sg) => (
                <div key={sg.name ?? "_"}>
                  {sg.name && (
                    <div className="sticky top-[30px] z-10 bg-helios-base/90 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-helios-dim backdrop-blur">
                      {sg.name}
                    </div>
                  )}
                  <div className="px-1.5">
                    {sg.notes.map((n) => (
                      <ResultRow
                        key={n.id}
                        note={n}
                        query={query}
                        active={n.id === activeId}
                        selected={flatIdx.get(n.id) === sel}
                        showDir={!sg.name}
                        onClick={() => onSelect(n.id, query.trim() || undefined)}
                        onHover={(el) => show(n, el)}
                        onHoverOut={hide}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
      <NotePreviewCard preview={preview} />
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const on = value !== "";
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={
          "w-full appearance-none truncate rounded-md border bg-helios-base py-1.5 pl-2 pr-5 text-[11px] focus:outline-none focus:ring-1 focus:ring-asu-gold/40 " +
          (on ? "border-asu-gold/50 text-asu-gold" : "border-helios-line text-helios-dim hover:text-helios-text")
        }
      >
        <option value="">{label}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <IconChevronDown size={12} className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-helios-dim" />
    </div>
  );
}

function ResultRow({
  note,
  query,
  active,
  selected,
  showDir,
  onClick,
  onHover,
  onHoverOut,
}: {
  note: KbNote;
  query: string;
  active: boolean;
  selected: boolean;
  showDir: boolean;
  onClick: () => void;
  onHover: (el: HTMLElement) => void;
  onHoverOut: () => void;
}) {
  return (
    <button
      data-sel={selected ? "1" : undefined}
      onClick={onClick}
      onMouseEnter={(e) => onHover(e.currentTarget)}
      onMouseLeave={onHoverOut}
      className={
        "kb-row mb-0.5 block w-full rounded-md px-2 py-1.5 text-left " +
        (active ? "bg-asu-gold/15 " : selected ? "bg-helios-panel ring-1 ring-asu-gold/40 " : "hover:bg-helios-panel")
      }
    >
      <div className={"truncate text-[13px] leading-tight " + (active ? "text-asu-gold" : "text-helios-text")}>{note.title}</div>
      {showDir && note.dir && <div className="truncate text-[10px] text-helios-dim">{note.dir}</div>}
      {query.trim() && (
        <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-helios-dim">
          {makeSnippet(note.body, query).map((seg, i) =>
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
  );
}
