import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export interface ConfirmDialogProps {
  title: string;
  body: string | ReactNode;
  confirmLabel: string;
  confirmTone: "default" | "danger";
  cancelLabel?: string;            // omit → alert mode (single button)
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  title, body, confirmLabel, confirmTone, cancelLabel, onConfirm, onClose,
}: ConfirmDialogProps) {
  const isAlert = cancelLabel === undefined;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Destructive (non-alert) dialogs focus Cancel on open so an accidental
  // Enter/Space doesn't fire the destructive action. Everything else focuses
  // the confirm button (the safe / primary action).
  const focusCancelOnOpen = confirmTone === "danger" && !isAlert;

  useEffect(() => {
    if (focusCancelOnOpen) cancelRef.current?.focus();
    else confirmRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // stopPropagation so a stacked context (e.g. an open menu underneath
        // or a future stacked dialog) doesn't ALSO close on the same keypress.
        // Matches the convention used by TabContextMenu's Esc handler.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, focusCancelOnOpen]);

  function handleConfirm() {
    // Always self-close after running the action so callers no longer have to
    // wire close into every onConfirm. try/finally guarantees the dialog
    // dismisses even if onConfirm throws. Callers that ALSO close in onConfirm
    // (e.g. Vault's AdminScreen) stay correct because closing is idempotent.
    try {
      onConfirm();
    } finally {
      onClose();
    }
  }

  const confirmClass =
    "px-3 py-1 text-xs rounded-sm border font-semibold cursor-pointer transition-colors " +
    (confirmTone === "danger"
      ? "bg-[#EF5350] text-white border-[#EF5350] hover:bg-[#D32F2F] hover:border-[#D32F2F]"
      : "bg-[#FFC627] text-[#0E0E10] border-[#FFC627] hover:bg-[#FFB300] hover:border-[#FFB300]");

  return (
    <div
      data-testid="confirm-backdrop"
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div
        className="bg-[#0E0E10] border border-[#2A2C32] rounded-sm shadow-xl w-[360px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-9 flex items-center px-4 border-b border-[#2A2C32]">
          <span id="confirm-title" className="text-sm text-[#D8DCE2] font-semibold">{title}</span>
        </div>
        <div className="px-4 py-4">
          <div className="text-xs text-[#D8DCE2]">{body}</div>
        </div>
        <div className="px-4 py-3 border-t border-[#2A2C32] flex justify-end gap-2">
          {!isAlert && (
            <button
              ref={cancelRef}
              type="button"
              onClick={onClose}
              className="px-3 py-1 text-xs rounded-sm border cursor-pointer transition-colors bg-[#16171B] text-[#D8DCE2] border-[#2A2C32] hover:border-[#FFC627] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
            >
              {cancelLabel}
            </button>
          )}
          <button ref={confirmRef} type="button" onClick={handleConfirm} className={confirmClass}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
