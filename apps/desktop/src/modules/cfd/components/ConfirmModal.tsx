// In-app confirm modal. Respects the no-browser-dialogs rule: never
// use window.confirm. Tests render this directly and assert on its
// button callbacks.

import type { ReactNode } from "react";

interface ConfirmModalProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "default" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "default",
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cfd-confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-[min(90vw,420px)] rounded-md border border-helios-line bg-helios-panel p-5 text-helios-text shadow-xl">
        <h2 id="cfd-confirm-title" className="text-base font-semibold">{title}</h2>
        <div className="mt-3 text-sm text-helios-dim">{body}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-helios-line bg-helios-base px-3 py-1.5 text-sm hover:bg-helios-line"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={
              "rounded px-3 py-1.5 text-sm font-medium " +
              (confirmVariant === "danger"
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-asu-gold text-helios-base hover:bg-yellow-300")
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
