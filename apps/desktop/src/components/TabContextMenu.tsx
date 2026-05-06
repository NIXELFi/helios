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
  function onColorEnter() {
    setColorOpen(true);
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setColorFlipLeft(r.right + 160 > window.innerWidth);
  }

  function fire(handler: () => void) {
    handler();
    onClose();
  }

  const itemBase =
    "px-3 py-1 text-xs cursor-pointer text-[#D8DCE2] hover:bg-[#23252b] hover:text-[#FFC627] flex items-center justify-between";
  const itemDisabled =
    "px-3 py-1 text-xs text-[#5A5F66] flex items-center justify-between cursor-not-allowed";

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Workspace actions"
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 60, minWidth: 160 }}
      className="bg-[#0E0E10] border border-[#2A2C32] rounded-sm shadow-xl py-1"
      onClick={(e) => e.stopPropagation()}
    >
      <div role="menuitem" className={itemBase} onClick={() => fire(props.onRename)}>
        Rename
      </div>
      <div
        role="menuitem"
        className={itemBase}
        onMouseEnter={onColorEnter}
        onMouseLeave={() => setColorOpen(false)}
      >
        <span>Color</span>
        <span className="text-[#7B8088]">▸</span>
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
            {palette.map((hex) => (
              <div
                key={hex}
                role="menuitem"
                aria-label={`Color ${hex}`}
                className={itemBase}
                onClick={() => fire(() => props.onRecolor(hex))}
              >
                <span
                  className="inline-block w-3 h-3 rounded-sm mr-2 border border-black/20"
                  style={{ background: hex }}
                />
                <span className="font-mono-num">{hex}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div role="menuitem" className={itemBase} onClick={() => fire(props.onDuplicate)}>
        Duplicate
      </div>
      <div role="menuitem" className={itemBase} onClick={() => fire(props.onExport)}>
        Export…
      </div>
      <div className="my-1 border-t border-[#2A2C32]" />
      {canDelete ? (
        <div
          role="menuitem"
          className={itemBase + " hover:!text-[#EF5350]"}
          onClick={() => fire(props.onDelete)}
        >
          Delete
        </div>
      ) : (
        <div role="menuitem" aria-disabled="true" className={itemDisabled}>
          Delete
        </div>
      )}
    </div>
  );
}
