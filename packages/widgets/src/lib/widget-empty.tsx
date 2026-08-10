/* Shared empty/fallback state for widgets. One voice for every "nothing to
 * show yet" moment: a sentence-case statement of what's missing, then a dim
 * hint that points at the fix. Replaces per-widget centered-text one-offs
 * that had drifted in phrasing, casing, and sizing.
 */

export function WidgetEmpty({ title, hint, transparent }: {
  /** What's missing — sentence case, no trailing period ("No laps detected"). */
  title: string;
  /** How to fix it ("Configure lap detection in the Sessions panel"). */
  hint?: string;
  /** Skip the panel background — for overlay use on top of a chart. */
  transparent?: boolean;
}) {
  return (
    <div
      className={
        "w-full h-full flex flex-col items-center justify-center gap-1 px-4 text-center select-none" +
        (transparent ? "" : " bg-[#16171B]")
      }
    >
      <span className="text-[11px] text-[#9097A0]">{title}</span>
      {hint && <span className="text-[10px] text-[#5A5F66] max-w-[36ch]">{hint}</span>}
    </div>
  );
}
