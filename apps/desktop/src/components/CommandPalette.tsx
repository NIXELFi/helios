import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteAction {
  id: string;
  label: string;
  sublabel?: string;
  kind: "workspace" | "session" | "system" | "channel" | "lap";
  /** Extra strings to consider when filtering. Useful for aliases ("logs",
   *  "overview", "main page" → same workspace). */
  keywords?: string[];
  /** Optional keyboard hint shown right-aligned ("⌘1", "⌘E"). Display-only;
   *  the binding itself is wired elsewhere. */
  hint?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}

const KIND_LABELS: Record<PaletteAction["kind"], string> = {
  workspace: "WS",
  session:   "SES",
  system:    "SYS",
  channel:   "CH",
  lap:       "LAP",
};

const KIND_COLORS: Record<PaletteAction["kind"], string> = {
  workspace: "text-asu-gold",
  session:   "text-[#4FC3F7]",
  system:    "text-helios-dim",
  channel:   "text-[#9CCC65]",
  lap:       "text-[#FFB800]",
};

/** Cmd/Ctrl-K command palette. Filters a flat action list, supports keyboard
 *  nav (↑/↓/Enter/Esc), and dispatches the chosen action's `run` callback.
 *  Match scoring prefers exact > prefix > substring > subsequence so typing
 *  "lap" lands on "Lap Analysis" instantly. */
export function CommandPalette({ open, onClose, actions }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Reset state every time the palette opens so a previous query doesn't
  // bleed into the next session.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      // Defer focus until after the input is mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => filterActions(actions, query), [actions, query]);

  // Keep the selected index in range when the filtered list shrinks.
  useEffect(() => {
    if (selected >= filtered.length) setSelected(Math.max(0, filtered.length - 1));
  }, [filtered.length, selected]);

  // Scroll the highlighted row into view when navigating with the keyboard.
  // jsdom doesn't implement scrollIntoView, so guard with a feature-check —
  // tests still mount and exercise the component without crashing.
  useEffect(() => {
    const ul = listRef.current;
    if (!ul) return;
    const el = ul.children[selected] as HTMLElement | undefined;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  if (!open) return null;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const action = filtered[selected];
      if (action) {
        action.run();
        onClose();
      }
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[80vw] bg-helios-panel border border-helios-line rounded-md shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
          onKeyDown={handleKeyDown}
          placeholder="Switch workspace · change primary · open panel…"
          className="w-full bg-transparent text-helios-text text-sm px-4 py-3 border-b border-helios-line focus:outline-none placeholder:text-helios-dim font-mono-num"
          spellCheck={false}
          aria-label="Filter commands"
        />
        <ul
          ref={listRef}
          role="listbox"
          className="max-h-[50vh] overflow-y-auto"
        >
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center text-xs text-helios-dim">
              No matches.
            </li>
          ) : (
            filtered.slice(0, 30).map((a, i) => (
              <li
                key={a.id}
                role="option"
                aria-selected={i === selected}
                onClick={() => { a.run(); onClose(); }}
                onMouseEnter={() => setSelected(i)}
                className={
                  "flex items-center gap-3 px-4 py-2 text-sm cursor-pointer " +
                  (i === selected
                    ? "bg-helios-line text-helios-text"
                    : "text-helios-text hover:bg-helios-line/60")
                }
              >
                <span className={"text-[10px] font-mono-num uppercase tracking-wider w-8 flex-shrink-0 " + KIND_COLORS[a.kind]}>
                  {KIND_LABELS[a.kind]}
                </span>
                <span className="flex-1 min-w-0 truncate">{a.label}</span>
                {a.sublabel && (
                  <span className="text-xs text-helios-dim truncate max-w-[180px]">{a.sublabel}</span>
                )}
                {a.hint && (
                  <span className="text-[10px] font-mono-num text-helios-dim border border-helios-line rounded px-1.5 py-px flex-shrink-0">
                    {a.hint}
                  </span>
                )}
              </li>
            ))
          )}
        </ul>
        <div className="border-t border-helios-line px-4 py-1.5 text-[10px] text-helios-dim font-mono-num flex items-center gap-3">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
          <span className="ml-auto">{filtered.length} match{filtered.length === 1 ? "" : "es"}</span>
        </div>
      </div>
    </div>
  );
}

/** Filter + rank actions by a query string. Empty query returns all actions
 *  in their original order. Scoring: 100 exact, 80 prefix, 50 substring,
 *  25 subsequence; 0 means no match. Multi-field — best field wins. */
export function filterActions(actions: PaletteAction[], q: string): PaletteAction[] {
  if (!q.trim()) return actions;
  const qLow = q.toLowerCase().trim();
  type Scored = { a: PaletteAction; score: number };
  const scored: Scored[] = [];
  for (const a of actions) {
    const fields = [a.label, a.sublabel ?? "", ...(a.keywords ?? [])];
    let best = 0;
    for (const f of fields) {
      const s = scoreMatch(qLow, f.toLowerCase());
      if (s > best) best = s;
      if (best === 100) break;
    }
    if (best > 0) scored.push({ a, score: best });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.map((s) => s.a);
}

function scoreMatch(q: string, f: string): number {
  if (!f) return 0;
  if (f === q) return 100;
  if (f.startsWith(q)) return 80;
  if (f.includes(q)) return 50;
  // Subsequence: every char of q appears in f in order.
  let qi = 0;
  for (let i = 0; i < f.length && qi < q.length; i++) {
    if (f[i] === q[qi]) qi++;
  }
  return qi === q.length ? 25 : 0;
}
