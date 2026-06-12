import { useEffect, useMemo, useRef, useState } from "react";
import { folderPath } from "../data/folder-paths";
import type { FileId, Folder, FolderId, VaultFile } from "../data/types";

interface Hit {
  file: VaultFile;
  path: string;
}

/** Case-insensitive subsequence match ("frm" hits "frame.sldprt"); contiguous
 *  substring matches rank first, then shorter names. Cheap enough to run on
 *  every keystroke over the in-memory vault list. */
function score(name: string, q: string): number | null {
  const n = name.toLowerCase();
  const idx = n.indexOf(q);
  if (idx >= 0) return idx * 1000 + n.length; // substring: earlier + shorter wins
  // Subsequence fallback.
  let i = 0;
  for (const ch of n) {
    if (ch === q[i]) i++;
    if (i === q.length) return 1_000_000 + n.length;
  }
  return null;
}

const MAX_HITS = 30;

/**
 * Vault-wide file search over the already-loaded `allFiles` list. Typing
 * filters live; picking a hit navigates Browse to the file's folder and
 * selects it. Ctrl/Cmd+F focuses the box (Browse only), Escape closes.
 */
export function VaultSearch({
  allFiles,
  folders,
  onPick,
}: {
  allFiles: VaultFile[];
  folders: Folder[];
  onPick: (fileId: FileId, folderId: FolderId | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const hits = useMemo<Hit[]>(() => {
    if (q.length === 0) return [];
    const scored: Array<{ hit: Hit; s: number }> = [];
    for (const f of allFiles) {
      const s = score(f.name, q);
      if (s === null) continue;
      const dir = folderPath(f.folder_id, folders);
      scored.push({ hit: { file: f, path: dir ? `${dir}/${f.name}` : f.name }, s });
    }
    scored.sort((a, b) => a.s - b.s);
    return scored.slice(0, MAX_HITS).map((x) => x.hit);
  }, [allFiles, folders, q]);

  // Keep the keyboard cursor in range as the hit list changes.
  useEffect(() => {
    setActiveIdx(0);
  }, [q]);

  // Ctrl/Cmd+F focuses the search box. Registered on window so it works from
  // anywhere on the Browse screen; unbinds with the component.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click-away closes the dropdown.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function pick(hit: Hit) {
    setOpen(false);
    setQuery("");
    onPick(hit.file.id, hit.file.folder_id);
  }

  return (
    <div ref={rootRef} className="relative w-40 shrink-0 transition-[width] md:w-52 xl:w-64">
      <div className="flex items-center gap-1.5 rounded border border-helios-line bg-helios-base px-2 focus-within:border-asu-gold/70 focus-within:ring-1 focus-within:ring-asu-gold/40">
        <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0 text-helios-dim">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open && hits.length > 0}
          aria-label="Search files in vault"
          value={query}
          placeholder="Search files…  (Ctrl+F)"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => { if (q) setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              setQuery("");
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIdx((i) => Math.min(i + 1, hits.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              const hit = hits[activeIdx];
              if (hit) pick(hit);
            }
          }}
          className="w-full bg-transparent py-1 text-xs text-helios-text placeholder-helios-dim focus:outline-none"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => { setQuery(""); inputRef.current?.focus(); }}
            className="shrink-0 rounded px-0.5 text-helios-dim hover:text-helios-text"
          >
            ✕
          </button>
        )}
      </div>
      {open && q.length > 0 && (
        <div
          role="listbox"
          aria-label="Search results"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-80 overflow-auto rounded-md border border-helios-line bg-helios-panel py-1 shadow-xl"
        >
          {hits.length === 0 ? (
            <div className="px-3 py-2 text-xs italic text-helios-dim">No files match “{query.trim()}”.</div>
          ) : (
            hits.map((h, i) => (
              <button
                key={h.file.id}
                type="button"
                role="option"
                aria-selected={i === activeIdx}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => pick(h)}
                className={
                  "block w-full px-3 py-1.5 text-left " +
                  (i === activeIdx ? "bg-helios-line/80" : "hover:bg-helios-line/50")
                }
              >
                <div className="truncate font-mono-num text-xs text-helios-text">{h.file.name}</div>
                <div className="truncate text-[10px] text-helios-dim">{h.path}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
