import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconInfoCircle } from "@tabler/icons-react";
import { GEN_KEEP_BEST, GEN_KEEP_RECENT, KEEP_BEST, KEEP_RECENT } from "../lib/share";

/**
 * An (i) that opens a short explanation beside it.
 *
 * For text people ask about once and then know: printed in full on every
 * visit it pushes the controls people use every time further down the page.
 * A click toggles it (so it works without a mouse), Escape or a click outside
 * closes it, and the panel is a labelled region the button points at.
 */
export function InfoPopover({
  label, children, align = "left", className = "",
}: {
  /** What the button is called: "What gets shared". */
  label: string;
  children: ReactNode;
  /** Which edge of the button the panel lines up with. */
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <span ref={box} className={"relative inline-flex " + className}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        title={label}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
        className={
          "inline-flex items-center gap-1 rounded px-1 text-[11px] transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold " +
          (open ? "text-helios-text" : "text-helios-muted hover:text-helios-text")
        }
      >
        <IconInfoCircle size={14} className="shrink-0" />
        <span>{label}</span>
      </button>
      {open && (
        <span
          id={id}
          role="region"
          aria-label={label}
          className={
            "absolute top-full z-40 mt-1 block w-80 max-w-[80vw] rounded-lg border border-helios-line bg-helios-panel p-3 text-left text-xs font-normal leading-relaxed text-helios-dim shadow-2xl " +
            (align === "right" ? "right-0" : "left-0")
          }
        >
          {children}
        </span>
      )}
    </span>
  );
}

/**
 * What the team gets of a run and what it does not. The one wording of it:
 * it used to be printed in full on the Launch tab AND under the Runs table,
 * two paragraphs saying the same thing in slightly different words.
 */
export function SharingPolicy() {
  return (
    <>
      Every run&rsquo;s time is shared with the team as soon as it is driven. The lap itself
      (the telemetry) is uploaded only for your best {KEEP_BEST} and latest {KEEP_RECENT} on each
      fixed course, and your best {GEN_KEEP_BEST} and latest {GEN_KEEP_RECENT} on a generated
      one. Older laps leave the team&rsquo;s copy as new ones take their place, and never leave
      this machine.
    </>
  );
}
