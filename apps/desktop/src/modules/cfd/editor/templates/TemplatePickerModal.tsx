// Placeholder — implemented in Wave E (Task 17).

interface Props {
  onClose: () => void;
}

export function TemplatePickerModal({ onClose }: Props) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="rounded-sm border border-[#2A2C32] bg-[#0E0E10] p-4 text-[#D8DCE2]">
        <p className="text-[11px] text-[#9097A0]">Template picker — coming in Wave E.</p>
        <button
          type="button"
          className="mt-3 rounded-sm border border-[#2A2C32] bg-[#16171B] px-2 py-1 text-[10px] uppercase tracking-wider"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
