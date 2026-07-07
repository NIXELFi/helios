import { useEffect, useMemo, useRef, useState } from "react";
import { IconCornerDownLeft, IconSearch } from "@tabler/icons-react";
import type { KbNote } from "../types";

// Lightweight subsequence fuzzy score — rewards contiguous + early matches so
// "5int" finds "5 Intake" ahead of longer incidental matches.
function fuzzy(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return 0;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak * 2 - (found - ti) * 0.05;
    ti = found + 1;
  }
  return score;
}

export function CommandPalette({
  notes,
  onPick,
  onClose,
}: {
  notes: KbNote[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo(() => {
    if (!query.trim()) return notes.slice(0, 40);
    return notes
      .map((n) => ({ n, s: Math.max(fuzzy(query, n.title), fuzzy(query, n.id) * 0.9) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((r) => r.n);
  }, [query, notes]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-i="${sel}"]`);
    (el as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = results[sel];
      if (pick) onPick(pick.id);
    }
  }

  return (
    <div
      className="helios-overlay-in absolute inset-0 z-40 flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        className="helios-modal-in helios-elevate w-full max-w-xl overflow-hidden rounded-xl border border-helios-line bg-helios-base"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-helios-line px-3 py-2.5">
          <IconSearch size={16} className="text-helios-dim" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a note…"
            className="flex-1 bg-transparent text-sm text-helios-text placeholder:text-helios-dim focus:outline-none"
          />
          <kbd className="rounded border border-helios-line px-1.5 py-0.5 text-[10px] text-helios-dim">esc</kbd>
        </div>
        <div ref={listRef} className="kb-scroll max-h-[52vh] overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-helios-dim">No notes match “{query}”.</div>
          ) : (
            results.map((n, i) => (
              <button
                key={n.id}
                data-i={i}
                onMouseEnter={() => setSel(i)}
                onClick={() => onPick(n.id)}
                className={
                  "flex w-full items-center justify-between gap-3 px-4 py-2 text-left " +
                  (i === sel ? "bg-asu-gold/15" : "hover:bg-helios-panel")
                }
              >
                <span className="min-w-0">
                  <span className={"block truncate text-sm " + (i === sel ? "text-asu-gold" : "text-helios-text")}>
                    {n.title}
                  </span>
                  {n.dir && <span className="block truncate text-[11px] text-helios-dim">{n.dir}</span>}
                </span>
                {i === sel && <IconCornerDownLeft size={14} className="shrink-0 text-asu-gold/70" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
