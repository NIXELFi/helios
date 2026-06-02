"use client";

import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  // Round color dot shown before the label (status, subteam).
  swatch?: string;
  // Solid pill fill applied to the trigger + option (priority criticality).
  fill?: { background: string; color: string };
  // Fully custom node rendered in place of swatch + label (e.g. <TypeBadge/>).
  node?: React.ReactNode;
}

export interface SelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  disabled?: boolean;
  placeholder?: string;
  size?: "sm" | "md";
  ariaLabel?: string;
  className?: string;
}

const TRIGGER_BASE =
  "inline-flex w-full items-center justify-between gap-1.5 rounded border border-helios-line " +
  "bg-helios-base text-helios-text focus:border-asu-gold focus:outline-none disabled:opacity-60 " +
  "disabled:cursor-not-allowed transition-colors";

const SIZE_CLASS: Record<"sm" | "md", string> = {
  sm: "px-2 py-1 text-xs",
  md: "px-2.5 py-1.5 text-sm",
};

function OptionVisual<T extends string>({ option }: { option: SelectOption<T> }) {
  if (option.node) return <>{option.node}</>;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {option.swatch ? (
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: option.swatch }}
        />
      ) : null}
      <span className="truncate">{option.label}</span>
    </span>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  disabled = false,
  placeholder = "Select…",
  size = "md",
  ariaLabel,
  className = "",
}: SelectProps<T>) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; bottom: number; width: number } | null>(
    null,
  );
  const [activeIndex, setActiveIndex] = useState(0);

  const selected = options.find((o) => o.value === value) ?? null;

  const measure = useCallback(() => {
    const node = triggerRef.current;
    if (!node) return;
    const r = node.getBoundingClientRect();
    setRect({ left: r.left, top: r.top, bottom: r.bottom, width: r.width });
  }, []);

  // Open / close lifecycle: measure on open, wire close-on-outside/scroll/resize.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      const t = e.target as Node;
      if (
        triggerRef.current?.contains(t) ||
        menuRef.current?.contains(t)
      ) {
        return;
      }
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onScrollOrResize() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    // Capture scroll on any ancestor (tables, the detail sheet body, etc.).
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setActiveIndex(idx < 0 ? 0 : idx);
    }
  }, [open, options, value]);

  function commit(v: T) {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onTriggerKey(e: React.KeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = options[activeIndex];
      if (opt) commit(opt.value);
    }
  }

  // Flip the menu above the trigger when it would overflow the viewport bottom.
  const MENU_MAX = 256;
  const openUp =
    rect != null && rect.bottom + MENU_MAX > window.innerHeight && rect.top > MENU_MAX;

  const triggerStyle = selected?.fill
    ? { backgroundColor: selected.fill.background, color: selected.fill.color }
    : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onTriggerKey}
        className={`${TRIGGER_BASE} ${SIZE_CLASS[size]} ${className}`}
        style={triggerStyle}
      >
        {selected ? (
          <OptionVisual option={selected} />
        ) : (
          <span className="truncate text-helios-dim">{placeholder}</span>
        )}
        <IconChevronDown
          size={size === "sm" ? 13 : 15}
          strokeWidth={1.5}
          className="shrink-0 opacity-70"
        />
      </button>

      {open && rect && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              role="listbox"
              className="fixed z-[60] overflow-hidden rounded-md border border-helios-line bg-helios-panel shadow-lg"
              style={{
                left: rect.left,
                width: rect.width,
                ...(openUp
                  ? { bottom: window.innerHeight - rect.top + 4 }
                  : { top: rect.bottom + 4 }),
              }}
            >
              <ul className="max-h-64 overflow-y-auto py-1">
                {options.map((opt, i) => {
                  const isSelected = opt.value === value;
                  const isActive = i === activeIndex;
                  return (
                    <li key={opt.value}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onMouseEnter={() => setActiveIndex(i)}
                        onClick={() => commit(opt.value)}
                        className={
                          "flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm transition-colors " +
                          (isActive ? "bg-helios-base" : "hover:bg-helios-base")
                        }
                      >
                        {opt.fill ? (
                          <span
                            className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium"
                            style={{ backgroundColor: opt.fill.background, color: opt.fill.color }}
                          >
                            {opt.label}
                          </span>
                        ) : (
                          <span className="min-w-0 flex-1 text-helios-text">
                            <OptionVisual option={opt} />
                          </span>
                        )}
                        {isSelected ? (
                          <IconCheck size={14} strokeWidth={1.5} className="shrink-0 text-asu-gold" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
