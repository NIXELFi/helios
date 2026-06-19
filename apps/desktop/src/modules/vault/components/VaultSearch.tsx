import { useEffect, useMemo, useRef, useState } from "react";
import { folderPath } from "../data/folder-paths";
import type { FileId, Folder, FolderId, VaultFile } from "../data/types";
import type { VaultPropertiesMap } from "../data/useVaultProperties";
import {
  parseSearchQuery,
  matchesProperties,
  propertyTextMatch,
} from "../lib/propertySearch";

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
 *
 * When `propertiesMap` is provided the search becomes property-aware:
 *   - A bare term like "7075" also matches files whose property values contain it.
 *   - `prop:key=value` tokens filter by SolidWorks custom properties
 *     (AND-combined; case-insensitive substring on both key and value).
 *
 * If `propertiesMap` is null (still loading) the component falls back
 * gracefully to filename-only matching — no errors.
 */
export function VaultSearch({
  allFiles,
  folders,
  propertiesMap = null,
  onPick,
}: {
  allFiles: VaultFile[];
  folders: Folder[];
  /** Optional: file-id → SwProperty[] map from useVaultProperties. When null,
   *  only filename matching is active. */
  propertiesMap?: VaultPropertiesMap | null;
  onPick: (fileId: FileId, folderId: FolderId | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const rawQ = query.trim();
  const parsed = useMemo(() => parseSearchQuery(rawQ), [rawQ]);
  const hasPropFilters = parsed.propFilters.length > 0;

  const hits = useMemo<Hit[]>(() => {
    if (rawQ.length === 0) return [];

    // The "filename text" part — use the free-text portion for scoring if
    // there are prop tokens; use the whole raw query otherwise (preserves
    // existing behaviour when no prop: tokens are present).
    const scoreText = hasPropFilters ? parsed.text : rawQ.toLowerCase();

    const scored: Array<{ hit: Hit; s: number }> = [];
    for (const f of allFiles) {
      const fileProps = propertiesMap?.get(f.id) ?? null;

      // 1. Filename score (existing subsequence logic, or a fixed score when
      //    free text is empty because the whole query was prop: tokens).
      let filenameScore: number | null = scoreText.length > 0
        ? score(f.name, scoreText)
        : null;

      // 2. Property text match — does any property value contain the free text?
      //    Contributes when propertiesMap is available AND there is free text.
      const propValueHit =
        propertiesMap !== null && parsed.text.length > 0
          ? propertyTextMatch(fileProps, parsed.text)
          : false;

      // 3. Prop filter check — ALL prop: tokens must match (AND).
      //    If no prop tokens present, this is vacuously true.
      const propFilterPass = hasPropFilters
        ? matchesProperties(fileProps, parsed.propFilters)
        : true;

      // A file is a hit if:
      //   • prop filters all pass (or there are none), AND
      //   • at least one of: filename matches OR property value matches
      if (!propFilterPass) continue;

      const anyTextMatch = filenameScore !== null || propValueHit;

      // When there are ONLY prop: tokens and no free text, every file that
      // passes the prop filters is a hit.
      if (!anyTextMatch && !hasPropFilters) continue;
      if (!anyTextMatch && hasPropFilters && parsed.text.length > 0) continue;

      const dir = folderPath(f.folder_id, folders);
      // Assign a score: prefer filename hits, then property-value hits.
      const s =
        filenameScore !== null
          ? filenameScore
          : propValueHit
          ? 2_000_000 + f.name.length // property hit, no filename match
          : 3_000_000 + f.name.length; // prop-filter only (no free text)

      scored.push({
        hit: { file: f, path: dir ? `${dir}/${f.name}` : f.name },
        s,
      });
    }
    scored.sort((a, b) => a.s - b.s);
    return scored.slice(0, MAX_HITS).map((x) => x.hit);
  }, [allFiles, folders, propertiesMap, rawQ, parsed, hasPropFilters]);

  // Keep the keyboard cursor in range as the hit list changes.
  useEffect(() => {
    setActiveIdx(0);
  }, [rawQ]);

  // Ctrl/Cmd+F focuses the search box. Registered on window so it works from
  // anywhere on the Browse screen; unbinds with the component. Guarded on
  // VISIBILITY — the Shell keeps modules mounted-but-hidden, so without the
  // offsetParent check this stole Ctrl+F while the user was in another module.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        const el = inputRef.current;
        if (!el || el.offsetParent === null) return; // vault hidden — not ours
        e.preventDefault();
        el.focus();
        el.select();
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

  // Placeholder hint: mention prop: syntax when properties are available.
  const placeholder = propertiesMap
    ? "Search… or prop:Material=7075  (Ctrl+F)"
    : "Search files…  (Ctrl+F)";

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
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => { if (rawQ) setOpen(true); }}
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
      {open && rawQ.length > 0 && (
        <div
          role="listbox"
          aria-label="Search results"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-80 overflow-auto rounded-md border border-helios-line bg-helios-panel py-1 shadow-xl"
        >
          {hits.length === 0 ? (
            <div className="px-3 py-2 text-xs italic text-helios-dim">No files match "{query.trim()}".</div>
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
