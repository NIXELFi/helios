import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface TabContextMenuProps {
  anchor: { x: number; y: number };
  canDelete: boolean;          // false when only one workspace remains
  palette: readonly string[];  // 8 hex strings
  onRename: () => void;
  onRecolor: (hex: string) => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function TabContextMenu(props: TabContextMenuProps) {
  const { anchor, canDelete, palette, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const [colorFlipLeft, setColorFlipLeft] = useState(false);
  // Refs to the top-level menuitems, in visual order. Used for roving focus
  // (Arrow keys) and to focus the first item on open. The Color item gets a
  // ref so we can return focus to it when the submenu closes.
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const colorItemRef = useRef<HTMLButtonElement | null>(null);
  const swatchRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Close on Escape, outside-click, or window resize. Esc gets stopPropagation
  // so it doesn't ALSO close an ancestor (e.g. an inline-rename input on the
  // tab itself when this menu opens above it).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    }
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // Focus the first item on open so keyboard users land inside the menu.
  useEffect(() => {
    itemRefs.current[0]?.focus();
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Position with viewport-overflow handling (flip up/left if too close to
  // edge). useLayoutEffect runs synchronously before paint so the user never
  // sees a one-frame flash at the un-flipped anchor.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = anchor.x;
    let top = anchor.y;
    if (left + r.width > window.innerWidth - 4) left = Math.max(4, anchor.x - r.width);
    if (top + r.height > window.innerHeight - 4) top = Math.max(4, anchor.y - r.height);
    setPos({ left, top });
  }, [anchor]);

  // Detect if the color submenu would overflow right; flip it left if so.
  function measureColorFlip() {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setColorFlipLeft(r.right + 160 > window.innerWidth);
  }
  function onColorEnter() {
    setColorOpen(true);
    measureColorFlip();
  }

  function fire(handler: () => void) {
    handler();
    onClose();
  }

  // Open the color submenu from the keyboard and move focus to the first
  // swatch. The submenu must render before we can focus it, so defer a frame.
  function openColorSubmenu() {
    measureColorFlip();
    setColorOpen(true);
    requestAnimationFrame(() => swatchRefs.current[0]?.focus());
  }

  // Roving focus across the top-level items. Disabled items (Delete when
  // !canDelete) are skipped so focus never lands on a dead control.
  function focusableTopItems(): HTMLButtonElement[] {
    return itemRefs.current.filter(
      (el): el is HTMLButtonElement => !!el && !el.hasAttribute("disabled"),
    );
  }
  function moveTopFocus(delta: 1 | -1) {
    const items = focusableTopItems();
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = items.findIndex((el) => el === active);
    const next = idx === -1
      ? (delta === 1 ? 0 : items.length - 1)
      : (idx + delta + items.length) % items.length;
    items[next]?.focus();
  }
  function onMenuKeyDown(e: React.KeyboardEvent) {
    // Submenu has its own handler; don't double-handle when focus is inside it.
    if (e.key === "ArrowDown") { e.preventDefault(); moveTopFocus(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveTopFocus(-1); }
  }

  // Per-item key handling for Enter/Space activation. Kept here so each item
  // can pass its own action.
  function onItemKeyDown(e: React.KeyboardEvent, action: () => void) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      fire(action);
    }
  }

  function onColorItemKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      openColorSubmenu();
    }
  }

  function onSwatchKeyDown(e: React.KeyboardEvent, i: number) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      fire(() => props.onRecolor(palette[i]!));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      swatchRefs.current[(i + 1) % palette.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      swatchRefs.current[(i - 1 + palette.length) % palette.length]?.focus();
    } else if (e.key === "ArrowLeft") {
      // Back out of the submenu to its parent item.
      e.preventDefault();
      setColorOpen(false);
      colorItemRef.current?.focus();
    }
  }

  const itemBase =
    "w-full text-left px-3 py-1 text-xs cursor-pointer text-[#D8DCE2] hover:bg-[#23252b] hover:text-[#FFC627] focus-visible:outline-none focus-visible:bg-[#23252b] focus-visible:text-[#FFC627] flex items-center justify-between";
  const itemDisabled =
    "w-full text-left px-3 py-1 text-xs text-[#5A5F66] flex items-center justify-between cursor-not-allowed";

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Workspace actions"
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 60, minWidth: 160 }}
      className="bg-[#0E0E10] border border-[#2A2C32] rounded-sm shadow-xl py-1"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onMenuKeyDown}
    >
      <button
        type="button"
        role="menuitem"
        ref={(el) => { itemRefs.current[0] = el; }}
        className={itemBase}
        onClick={() => fire(props.onRename)}
        onKeyDown={(e) => onItemKeyDown(e, props.onRename)}
      >
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={colorOpen}
        ref={(el) => { itemRefs.current[1] = el; colorItemRef.current = el; }}
        className={itemBase + " relative"}
        onMouseEnter={onColorEnter}
        onMouseLeave={() => setColorOpen(false)}
        onKeyDown={onColorItemKeyDown}
      >
        <span>Color</span>
        <span className="text-[#9097A0]" aria-hidden>▸</span>
        {colorOpen && (
          <div
            role="menu"
            aria-label="Color"
            className="absolute bg-[#0E0E10] border border-[#2A2C32] rounded-sm shadow-xl py-1"
            style={{
              top: 0,
              [colorFlipLeft ? "right" : "left"]: "100%" as const,
              minWidth: 140,
            }}
          >
            {palette.map((hex, i) => (
              <button
                type="button"
                key={hex}
                role="menuitem"
                aria-label={`Color ${hex}`}
                ref={(el) => { swatchRefs.current[i] = el; }}
                className={itemBase}
                onClick={() => fire(() => props.onRecolor(hex))}
                onKeyDown={(e) => onSwatchKeyDown(e, i)}
              >
                <span
                  className="inline-block w-3 h-3 rounded-sm mr-2 border border-black/20"
                  style={{ background: hex }}
                />
                <span className="font-mono-num">{hex}</span>
              </button>
            ))}
          </div>
        )}
      </button>
      <button
        type="button"
        role="menuitem"
        ref={(el) => { itemRefs.current[2] = el; }}
        className={itemBase}
        onClick={() => fire(props.onDuplicate)}
        onKeyDown={(e) => onItemKeyDown(e, props.onDuplicate)}
      >
        Duplicate
      </button>
      <button
        type="button"
        role="menuitem"
        ref={(el) => { itemRefs.current[3] = el; }}
        className={itemBase}
        onClick={() => fire(props.onExport)}
        onKeyDown={(e) => onItemKeyDown(e, props.onExport)}
      >
        Export…
      </button>
      <div className="my-1 border-t border-[#2A2C32]" />
      {canDelete ? (
        <button
          type="button"
          role="menuitem"
          ref={(el) => { itemRefs.current[4] = el; }}
          className={itemBase + " hover:!text-[#EF5350] focus-visible:!text-[#EF5350]"}
          onClick={() => fire(props.onDelete)}
          onKeyDown={(e) => onItemKeyDown(e, props.onDelete)}
        >
          Delete
        </button>
      ) : (
        <button
          type="button"
          role="menuitem"
          aria-disabled="true"
          disabled
          ref={(el) => { itemRefs.current[4] = el; }}
          className={itemDisabled}
        >
          Delete
        </button>
      )}
    </div>
  );
}
