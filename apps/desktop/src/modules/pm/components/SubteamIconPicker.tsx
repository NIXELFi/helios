"use client";

import { useEffect } from "react";
import { IconRefresh } from "@tabler/icons-react";
import {
  GLYPH_LABELS,
  PICKABLE_GLYPHS,
  SubteamIcon,
  type SubteamGlyph,
} from "@pm/components/SubteamIcon";

// A small popover, anchored under the subteam icon that opened it, for picking a
// subteam's display glyph. Persisting the choice (server-wide, capability-gated)
// is the caller's job via `onPick`; `onPick(null)` clears the override so the
// subteam reverts to its auto-derived icon. Only mounted for users who may edit.
export function SubteamIconPicker({
  open,
  anchorRect,
  current,
  color,
  onPick,
  onClose,
}: {
  open: boolean;
  anchorRect: DOMRect | null;
  /** The currently-stored glyph (null = auto-derived), to mark as selected. */
  current: SubteamGlyph | null;
  /** Subteam color, so the previews render in the subteam's hue. */
  color: string;
  /** Persist the pick. null = reset to the auto-derived glyph. */
  onPick: (glyph: SubteamGlyph | null) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !anchorRect) return null;

  // Anchor just below the clicked icon, clamped into the viewport.
  const PANEL_W = 232;
  const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - PANEL_W - 8);
  const top = Math.min(anchorRect.bottom + 6, window.innerHeight - 8);

  return (
    <>
      {/* transparent backdrop: a click anywhere outside closes the popover */}
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        role="menu"
        aria-label="Choose subteam icon"
        className="fixed z-50 rounded-lg border border-helios-line bg-helios-panel p-2 shadow-xl"
        style={{ left, top, width: PANEL_W }}
      >
        <p className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-widest text-helios-dim">
          Subteam icon
        </p>
        <div className="grid grid-cols-5 gap-1">
          {PICKABLE_GLYPHS.map((g) => {
            const selected = current === g;
            return (
              <button
                key={g}
                type="button"
                onClick={() => {
                  onPick(g);
                  onClose();
                }}
                title={GLYPH_LABELS[g]}
                aria-label={GLYPH_LABELS[g]}
                aria-pressed={selected}
                className={
                  "grid aspect-square place-items-center rounded-md border transition-colors " +
                  (selected
                    ? "border-asu-gold bg-asu-gold/15"
                    : "border-transparent hover:border-helios-line hover:bg-helios-base")
                }
              >
                <SubteamIcon glyph={g} size={20} style={{ color }} />
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => {
            onPick(null);
            onClose();
          }}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-helios-line px-2 py-1.5 text-xs text-helios-dim transition-colors hover:bg-helios-base hover:text-asu-gold"
        >
          <IconRefresh size={13} strokeWidth={1.5} />
          Reset to automatic
        </button>
      </div>
    </>
  );
}
