// Generic export dropdown. A gold-outline "Export ▾" trigger (header
// button density) opens an absolutely-positioned popover of items; each
// item runs an async action that resolves to {ok, message}. While an
// item is running it shows a busy state and is disabled. The result
// message surfaces as a transient toast (fixed bottom-right, PM
// WriteErrorToast idiom — replicated locally, NOT imported from pm) that
// auto-dismisses after 4 s. Esc and outside-click close the popover.

import { useEffect, useRef, useState } from "react";

export interface ExportMenuItem {
  id: string;
  label: string;
  run: () => Promise<{ ok: boolean; message: string }>;
}

interface Props {
  items: ExportMenuItem[];
  align?: "left" | "right";
  /** Trigger button text (the ▾ caret is appended). Defaults to "Export";
   *  compact row triggers pass e.g. "Export" or a shorter label. */
  triggerLabel?: string;
}

interface Toast {
  ok: boolean;
  message: string;
}

export function ExportMenu({ items, align = "right", triggerLabel = "Export" }: Props) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside-click + Escape while the popover is open.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Auto-dismiss the toast after 4 s.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function runItem(item: ExportMenuItem) {
    if (busyId) return; // one at a time
    setBusyId(item.id);
    try {
      const res = await item.run();
      setToast(res);
    } catch (e) {
      setToast({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId(null);
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        className="rounded-sm border border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {triggerLabel} ▾
      </button>

      {open && (
        <div
          role="menu"
          className={
            "absolute z-50 mt-1 min-w-[180px] rounded-sm border border-[#2A2C32] bg-[#0E0E10] py-1 shadow-xl " +
            (align === "left" ? "left-0" : "right-0")
          }
        >
          {items.map((item) => {
            const busy = busyId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={busyId != null}
                className="block w-full px-3 py-1.5 text-left text-[11px] text-[#D8DCE2] hover:bg-[#16171B] hover:text-[#FFC627] disabled:opacity-50"
                onClick={() => void runItem(item)}
              >
                {busy ? `${item.label}…` : item.label}
              </button>
            );
          })}
        </div>
      )}

      {toast && (
        <div
          role="status"
          className={
            "fixed bottom-4 right-4 z-50 max-w-sm rounded-md border px-4 py-3 text-sm shadow-lg " +
            (toast.ok
              ? "border-[#FFC627]/40 bg-[#16171B] text-[#D8DCE2]"
              : "border-red-500/40 bg-red-950/95 text-red-100")
          }
        >
          <div className="break-words">{toast.message}</div>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="mt-1.5 text-xs text-[#9097A0] underline underline-offset-2 hover:text-[#D8DCE2]"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
