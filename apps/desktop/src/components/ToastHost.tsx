import { useEffect, useState } from "react";
import type { ToastItem, ToastStore } from "../lib/toast";

const TONE_STYLES: Record<ToastItem["tone"], { box: string; dot: string }> = {
  success: { box: "border-[#66BB6A]/50 bg-[#10160F]", dot: "bg-[#66BB6A]" },
  error: { box: "border-[#EF5350]/50 bg-[#1A0F0F]", dot: "bg-[#EF5350]" },
  info: { box: "border-asu-gold/50 bg-[#16130A]", dot: "bg-asu-gold" },
};

/**
 * Renders one toast store's queue, bottom-centre. Each module that uses toasts
 * mounts exactly one of these for its own store (see `lib/toast.ts` for why
 * the stores are per module). aria-live polite so screen readers announce
 * outcomes without stealing focus.
 *
 * A sticky toast (an error the user has to read) wraps rather than truncating:
 * it is there precisely because the whole message matters.
 */
export function ToastHost({ store }: { store: ToastStore }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  useEffect(() => store.subscribe(setToasts), [store]);

  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex w-96 max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-1.5"
    >
      {toasts.map((t) => {
        const s = TONE_STYLES[t.tone];
        return (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={
              "pointer-events-auto flex items-center gap-2 rounded-lg border px-3 py-2 text-xs text-helios-text shadow-xl backdrop-blur " +
              s.box
            }
          >
            <span aria-hidden className={"h-2 w-2 shrink-0 rounded-full " + s.dot} />
            <span
              className={"min-w-0 flex-1 " + (t.sticky ? "break-words" : "truncate")}
              title={t.message}
            >
              {t.message}
            </span>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => store.dismiss(t.id)}
              className="shrink-0 rounded px-1 text-helios-dim hover:bg-helios-line hover:text-helios-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
