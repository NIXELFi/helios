"use client";

import { useEffect, useRef } from "react";

export interface MenuAction {
  label: string;
  onClick: () => void;
  /** Optional rendering hint — danger actions are tinted red. */
  danger?: boolean;
  /** Disable but still render (greyed out with title-tooltip). */
  disabledReason?: string;
}

interface Props {
  x: number;
  y: number;
  actions: MenuAction[];
  onClose: () => void;
}

/**
 * Generic floating context menu anchored at (x, y) — the PM module's copy of
 * Vault's TreeContextMenu contract. Closes on outside click, Escape, or any
 * selection.
 *
 * Position is clamped to the viewport so menus opened near the bottom-right
 * edge don't clip off-screen.
 */
export function ContextMenu({ x, y, actions, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    // Clamp to viewport on the next frame so we know the menu's measured size.
    const el = ref.current;
    if (!el) return;
    const { innerWidth, innerHeight } = window;
    const { width, height } = el.getBoundingClientRect();
    const nx = Math.min(x, innerWidth - width - 4);
    const ny = Math.min(y, innerHeight - height - 4);
    el.style.left = `${Math.max(0, nx)}px`;
    el.style.top = `${Math.max(0, ny)}px`;
  }, [x, y]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[70] min-w-[12rem] rounded border border-helios-line bg-helios-panel py-1 text-sm shadow-xl"
      style={{ left: x, top: y }}
    >
      {actions.map((a, i) => {
        const disabled = !!a.disabledReason;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => {
              if (!disabled) {
                a.onClick();
                onClose();
              }
            }}
            title={a.disabledReason ?? undefined}
            className={
              "block w-full px-3 py-1.5 text-left text-xs " +
              (disabled
                ? "cursor-not-allowed text-helios-dim opacity-50"
                : a.danger
                  ? "text-[#EF5350] hover:bg-[#EF5350]/10"
                  : "text-helios-text hover:bg-helios-line")
            }
          >
            {a.label}
          </button>
        );
      })}
    </div>
  );
}
