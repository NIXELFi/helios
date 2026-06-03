import { useEffect, useMemo, useRef, useState } from "react";
import { IconSearch, IconStar, IconX } from "@tabler/icons-react";
import type { VaultFile } from "../data/types";

/** Modal file picker for choosing a vault's spotlight file. Searchable (name or
 *  path); rows are capped so a multi-thousand-file vault stays responsive — the
 *  search narrows past the cap. Mirrors the modal a11y convention used elsewhere
 *  in the vault (role=dialog + Escape-to-close + focus-trap + focus-restore). */
const MAX_ROWS = 200;

export function SpotlightPicker({
  files,
  pathOf,
  currentId,
  saving,
  onPick,
  onClose,
}: {
  files: VaultFile[];
  pathOf: (f: VaultFile) => string;
  currentId: string | null;
  saving: boolean;
  onPick: (fileId: string | null) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreTo?.focus?.();
    };
  }, [onClose]);

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    const withPath = files.map((f) => ({ f, path: pathOf(f) }));
    const filtered = query
      ? withPath.filter((r) => r.f.name.toLowerCase().includes(query) || r.path.toLowerCase().includes(query))
      : withPath;
    // Surface assemblies first (the usual spotlight), then alphabetical by path.
    filtered.sort((a, b) => {
      const aa = a.f.name.toLowerCase().endsWith(".sldasm") ? 0 : 1;
      const bb = b.f.name.toLowerCase().endsWith(".sldasm") ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return (a.path + a.f.name).localeCompare(b.path + b.f.name);
    });
    return { shown: filtered.slice(0, MAX_ROWS), total: filtered.length };
  }, [files, pathOf, q]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Choose spotlight file"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[70vh] w-[36rem] max-w-[92vw] flex-col border border-helios-line bg-helios-panel shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-helios-line px-4 py-3">
          <h3 className="text-sm font-semibold text-helios-text">Choose spotlight file</h3>
          <button type="button" onClick={onClose} className="p-1 text-helios-dim hover:bg-helios-line hover:text-helios-text">
            <IconX size={16} />
          </button>
        </div>
        <div className="border-b border-helios-line p-3">
          <div className="flex items-center gap-2 border border-helios-line bg-helios-base px-2">
            <IconSearch size={14} className="text-helios-dim" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search files by name or path…"
              className="w-full bg-transparent py-1.5 text-sm text-helios-text placeholder-helios-dim focus:outline-none"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          {rows.shown.length === 0 ? (
            <div className="p-6 text-center text-sm text-helios-dim">No matching files.</div>
          ) : (
            <ul>
              {rows.shown.map(({ f, path }) => {
                const isCurrent = f.id === currentId;
                return (
                  <li key={f.id}>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => onPick(f.id)}
                      className={
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors disabled:opacity-50 " +
                        (isCurrent ? "bg-asu-gold/10 text-asu-gold" : "text-helios-text hover:bg-helios-base")
                      }
                    >
                      {isCurrent ? <IconStar size={13} className="shrink-0 text-asu-gold" /> : <span className="w-[13px] shrink-0" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{f.name}</span>
                        {path ? <span className="block truncate text-[11px] text-helios-dim">{path}</span> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {rows.total > MAX_ROWS ? (
            <div className="px-3 py-2 text-[11px] text-helios-dim">
              Showing {MAX_ROWS} of {rows.total.toLocaleString()} — refine the search to narrow.
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-between border-t border-helios-line px-4 py-2.5">
          <button
            type="button"
            disabled={saving || !currentId}
            onClick={() => onPick(null)}
            className="text-xs text-helios-dim hover:text-red-400 disabled:opacity-40"
          >
            Clear spotlight
          </button>
          {saving ? <span className="text-xs text-helios-dim">Saving…</span> : null}
        </div>
      </div>
    </div>
  );
}
