// Modal listing the available config templates. Picking one loads it
// into the editor (snapshot stays empty, so the editor is dirty from
// the start — the user must Save-As to commit it to disk).

import { useEditor } from "../state/editor-context";
import { TEMPLATES, materializeTemplate, type Template } from "./templates";

interface Props {
  onClose: () => void;
}

export function TemplatePickerModal({ onClose }: Props) {
  const editor = useEditor();

  function pick(t: Template) {
    editor.dispatch({ type: "loadTemplate", raw: materializeTemplate(t) });
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cfd-template-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[min(90vw,520px)] rounded-sm border border-[#2A2C32] bg-[#0E0E10] text-[#D8DCE2] shadow-xl">
        <div className="flex items-center justify-between border-b border-[#2A2C32] px-3 py-1.5">
          <div id="cfd-template-title" className="text-[11px] uppercase tracking-wider text-[#FFC627]">
            New from template
          </div>
          <button
            type="button"
            className="text-[10px] uppercase tracking-wider text-[#5A5F66] hover:text-[#D8DCE2]"
            onClick={onClose}
          >
            Esc
          </button>
        </div>
        <div className="p-3">
          <p className="text-[11px] text-[#9097A0]">
            Pick a template to copy into the editor. The new config is unsaved — use Save As… to commit it to disk.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => pick(t)}
                className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] p-3 text-left transition hover:border-[#FFC627]"
              >
                <div className="text-[11px] uppercase tracking-wider text-[#D8DCE2]">{t.name}</div>
                <div className="mt-0.5 text-[10px] text-[#5A5F66]">{t.description}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
