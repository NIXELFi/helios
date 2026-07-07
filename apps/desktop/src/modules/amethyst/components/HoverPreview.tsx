import { useCallback, useRef, useState } from "react";
import type { KbNote } from "../types";

interface PreviewState {
  note: KbNote;
  top: number;
  left: number;
}

/** Delayed hover preview: call show(note, element) on mouse-enter and hide() on
 *  leave. Positions a card just to the right of the hovered row. */
export function useNotePreview() {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((note: KbNote, el: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const left = Math.min(r.right + 10, window.innerWidth - 340);
      const top = Math.max(10, Math.min(r.top - 4, window.innerHeight - 240));
      setPreview({ note, top, left });
    }, 280);
  }, []);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setPreview(null);
  }, []);

  return { preview, show, hide };
}

export function NotePreviewCard({ preview }: { preview: PreviewState | null }) {
  if (!preview) return null;
  const { note, top, left } = preview;
  const chips = [note.frontmatter.car, note.frontmatter.subteam, note.frontmatter.type].filter(
    (v): v is string => typeof v === "string",
  );
  const figCount = note.body.match(/!\[\[/g)?.length ?? 0;
  return (
    <div
      className="helios-modal-in helios-elevate pointer-events-none fixed z-50 w-80 rounded-xl border border-helios-line bg-helios-panel/95 p-3.5 backdrop-blur"
      style={{ top, left }}
    >
      <div className="mb-1.5 text-sm font-semibold leading-snug text-helios-text">{note.title}</div>
      {chips.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {chips.map((c) => (
            <span key={c} className="rounded-full bg-helios-line/50 px-2 py-0.5 text-[10px] text-helios-dim">
              {c}
            </span>
          ))}
        </div>
      )}
      {note.summary ? (
        <p className="text-xs leading-relaxed text-helios-dim">{note.summary}</p>
      ) : (
        <p className="text-xs italic text-helios-dim/60">No summary.</p>
      )}
      <div className="mt-2 flex items-center gap-3 border-t border-helios-line/60 pt-2 text-[10px] text-helios-dim/80">
        <span className="truncate">{note.dir || "/"}</span>
        {figCount > 0 && <span>· {figCount} fig{figCount === 1 ? "" : "s"}</span>}
        {note.links.length > 0 && <span>· {note.links.length} link{note.links.length === 1 ? "" : "s"}</span>}
      </div>
    </div>
  );
}
