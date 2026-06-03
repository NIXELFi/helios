"use client";

import { IconCheck, IconMinus } from "@tabler/icons-react";

export interface SelectCheckboxProps {
  checked: boolean;
  // Tri-state: when true (and not fully checked) renders a dash. Header use only.
  indeterminate?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}

// A small controlled checkbox used for row/header multi-select. Kept as a
// styled button (not a native <input>) so its appearance matches the rest of
// the PM UI and so the indeterminate state is trivially renderable.
export function SelectCheckbox({
  checked,
  indeterminate = false,
  disabled = false,
  ariaLabel,
  onChange,
}: SelectCheckboxProps) {
  const active = checked || indeterminate;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={
        "inline-flex size-4 shrink-0 items-center justify-center rounded border transition-colors " +
        (disabled
          ? "cursor-not-allowed border-helios-line/60 opacity-40 "
          : "cursor-pointer ") +
        (active && !disabled
          ? "border-asu-gold bg-asu-gold text-helios-base "
          : "border-helios-line bg-transparent text-transparent hover:border-helios-text/50")
      }
    >
      {indeterminate && !checked ? (
        <IconMinus size={12} strokeWidth={2.5} />
      ) : checked ? (
        <IconCheck size={12} strokeWidth={2.5} />
      ) : null}
    </button>
  );
}
