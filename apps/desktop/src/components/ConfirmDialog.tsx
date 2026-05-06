interface Props {
  heading: string;
  body: string;
  /** "default" = yellow confirm button (non-destructive action).
   *  "danger"  = red confirm button (destructive action). */
  tone?: "default" | "danger";
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Generic modal dialog that replaces browser-native `confirm()` and `alert()`
 *  calls. Matches the chrome of ChannelsModal / MathChannelsModal:
 *  - Backdrop: bg-black/60
 *  - Panel:    bg-[#0E0E10] border border-[#2A2C32] rounded-sm shadow-xl
 *  - Heading:  text-sm text-[#D8DCE2] font-semibold
 *  - Body:     text-xs text-[#D8DCE2]
 *  - Cancel:   bg-[#16171B] border-[#2A2C32]
 *  - Confirm (default): bg-[#FFC627] text-[#0E0E10]
 *  - Confirm (danger):  bg-[#EF5350] text-white */
export function ConfirmDialog({
  heading,
  body,
  tone = "default",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: Props) {
  const confirmClass =
    tone === "danger"
      ? "px-3 py-1 text-xs rounded-sm border font-semibold cursor-pointer transition-colors bg-[#EF5350] text-white border-[#EF5350] hover:bg-[#D32F2F] hover:border-[#D32F2F]"
      : "px-3 py-1 text-xs rounded-sm border font-semibold cursor-pointer transition-colors bg-[#FFC627] text-[#0E0E10] border-[#FFC627] hover:bg-[#FFB300] hover:border-[#FFB300]";

  return (
    <div
      data-testid="confirm-backdrop"
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="bg-[#0E0E10] border border-[#2A2C32] rounded-sm shadow-xl w-[360px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="h-9 flex items-center px-4 border-b border-[#2A2C32]">
          <span className="text-sm text-[#D8DCE2] font-semibold">{heading}</span>
        </div>

        {/* Body */}
        <div className="px-4 py-4">
          <p className="text-xs text-[#D8DCE2]">{body}</p>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[#2A2C32] flex justify-end gap-2">
          <button
            aria-label={cancelLabel}
            onClick={onCancel}
            className="px-3 py-1 text-xs rounded-sm border cursor-pointer transition-colors bg-[#16171B] text-[#D8DCE2] border-[#2A2C32] hover:border-[#FFC627]"
          >
            {cancelLabel}
          </button>
          <button
            aria-label={confirmLabel}
            onClick={onConfirm}
            className={confirmClass}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
