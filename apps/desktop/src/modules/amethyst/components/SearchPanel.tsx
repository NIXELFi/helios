import { useMemo, useState } from "react";
import { IconChevronDown, IconSearch, IconX } from "@tabler/icons-react";
import type { KbNote, KbVault } from "../types";
import { makeSnippet, searchIndex, type SearchIndex } from "../data/searchIndex";

type FacetKey = "car" | "subteam" | "type";
const FACETS: { key: FacetKey; label: string }[] = [
  { key: "car", label: "Car" },
  { key: "subteam", label: "Subteam" },
  { key: "type", label: "Type" },
];

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

interface SubGroup {
  name: string | null;
  notes: KbNote[];
}
interface Group {
  cat: string;
  count: number;
  subgroups: SubGroup[];
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
  const [filters, setFilters] = useState<Record<FacetKey, string>>({ car: "", subteam: "", type: "" });

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
    if (query.trim()) base = searchIndex(index, vault.resolve, query, 300).map((h) => h.note);
    else base = vault.notes;
    const active = FACETS.map((f) => f.key).filter((k) => filters[k]);
    if (active.length) base = base.filter((n) => active.every((k) => facetValue(n, k) === filters[k]));
    return base.slice(0, 300);
  }, [query, filters, index, vault]);

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
            placeholder="Search everything…"
            className="w-full rounded-lg border border-helios-line bg-helios-base py-2 pl-8 pr-8 text-sm text-helios-text placeholder:text-helios-dim/80 focus:border-asu-gold/60 focus:outline-none focus:ring-1 focus:ring-asu-gold/30"
          />
          {query && (
            <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-helios-dim hover:text-helios-text" aria-label="Clear">
              <IconX size={14} />
            </button>
          )}
        </div>

        {/* compact filter dropdowns */}
        <div className="grid grid-cols-3 gap-1.5">
          {FACETS.map(({ key, label }) =>
            facetOptions[key].length > 1 ? (
              <FilterSelect
                key={key}
                label={label}
                value={filters[key]}
                options={facetOptions[key]}
                onChange={(v) => setFilters((f) => ({ ...f, [key]: v }))}
              />
            ) : (
              <div key={key} />
            ),
          )}
        </div>
        {anyFilter && (
          <button
            onClick={() => setFilters({ car: "", subteam: "", type: "" })}
            className="text-[10px] text-helios-dim underline decoration-dotted hover:text-helios-text"
          >
            clear filters
          </button>
        )}
      </div>

      <div className="kb-scroll min-h-0 flex-1 overflow-y-auto py-1">
        {results.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-helios-dim">Nothing matches.</div>
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
                        showDir={!sg.name}
                        onClick={() => onSelect(n.id, query.trim() || undefined)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
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
  showDir,
  onClick,
}: {
  note: KbNote;
  query: string;
  active: boolean;
  showDir: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "kb-row mb-0.5 block w-full rounded-md px-2 py-1.5 text-left " +
        (active ? "bg-asu-gold/15" : "hover:bg-helios-panel")
      }
    >
      <div className={"truncate text-[13px] leading-tight " + (active ? "text-asu-gold" : "text-helios-text")}>
        {note.title}
      </div>
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
