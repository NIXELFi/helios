import type { ReactNode } from "react";
import type { TablerIcon } from "@tabler/icons-react";

/** Centered zero-state: an outlined icon in a circle, a title, an optional hint
 *  line, and an optional action — used where a list or panel has no rows yet,
 *  instead of a bare line of text. */
export function EmptyState({
  Icon,
  title,
  hint,
  action,
}: {
  Icon: TablerIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-helios-line bg-helios-base text-helios-dim">
        <Icon size={22} strokeWidth={1.5} />
      </div>
      <div className="text-sm font-medium text-helios-text">{title}</div>
      {hint && <div className="max-w-[18rem] text-xs leading-relaxed text-helios-dim">{hint}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
