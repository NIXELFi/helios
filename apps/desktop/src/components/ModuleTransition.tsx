import type { TablerIcon } from "@tabler/icons-react";

/** Light first-open placeholder for a module pane: the module's glyph and
 *  name, a thin gold line sweeping along the top edge, nothing else. Modules
 *  usually open in well under a second, so this fades in only after ~150 ms
 *  (see .helios-transition-in) — a fast open shows nothing at all instead of
 *  flashing a full splash. The HELIOS wordmark splash is for boot only. */
export function ModuleTransition({ label, Icon }: { label: string; Icon?: TablerIcon }) {
  return (
    <div
      role="status"
      aria-label={`Loading ${label}`}
      className="helios-transition-in absolute inset-0 flex flex-col items-center justify-center bg-helios-base text-helios-dim"
    >
      <div className="absolute inset-x-0 top-0 h-px overflow-hidden bg-helios-line/60" aria-hidden>
        <div className="helios-sweep absolute inset-y-0 w-1/4 bg-asu-gold" />
      </div>
      {Icon && <Icon size={30} strokeWidth={1.25} className="mb-3 text-helios-dim/80" aria-hidden />}
      <div className="text-[11px] font-medium uppercase tracking-[0.3em]">{label}</div>
    </div>
  );
}
