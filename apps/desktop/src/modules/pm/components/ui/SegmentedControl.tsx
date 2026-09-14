"use client";

import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// SegmentedControl — the house idiom for picking ONE of a few modes: a pill on
// the base surface whose active segment lifts to the panel surface. Extracted
// from the Table filter bar's Dim/Hide toggle so every two-to-five-way choice
// in the PM module (date presets, Team/Person, Dim/Hide) reads the same.
//
// Exposed as a radiogroup: arrow keys move between segments, the active one is
// aria-checked, and each segment stays a real <button> so tests and screen
// readers see a labelled control rather than a styled div.
// ---------------------------------------------------------------------------

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Optional accessible name when the visible label is too terse. */
  ariaLabel?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  ariaLabel: string;
  size?: "xs" | "sm";
  className?: string;
}

const SIZE_CLASS: Record<"xs" | "sm", { group: string; item: string }> = {
  xs: { group: "text-[11px]", item: "px-2 py-0.5" },
  sm: { group: "text-xs", item: "px-2.5 py-1" },
};

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  size = "xs",
  className = "",
}: SegmentedControlProps<T>) {
  function onKey(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = options[(index + delta + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    const group = e.currentTarget.parentElement;
    const target = group?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`);
    target?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`inline-flex rounded-md border border-helios-line bg-helios-base p-0.5 ${SIZE_CLASS[size].group} ${className}`}
    >
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.ariaLabel}
            data-value={opt.value}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={
              `inline-flex items-center gap-1 whitespace-nowrap rounded transition-colors ${SIZE_CLASS[size].item} ` +
              (active ? "bg-helios-panel text-helios-text" : "text-helios-dim hover:text-helios-text")
            }
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
