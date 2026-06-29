"use client";

import { IconStar, IconStarFilled } from "@tabler/icons-react";

/**
 * "Primary only" view toggle. When on, the subteam-scoped view hides tasks where
 * the current subteam is merely a secondary contributor, leaving only the tasks
 * it primarily owns. The star icon matches TaskSubteamChips, where a filled star
 * already marks a task's primary subteam — so the metaphor reads consistently.
 *
 * Stateless: the on/off value + persistence live in usePrimaryOnly (localStorage,
 * per user). Shown only inside a single-subteam scope; "All subteams" has no
 * primary-vs-secondary distinction.
 */
export function PrimaryOnlyToggle({
  value,
  onChange,
  className = "",
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={value}
      onClick={() => onChange(!value)}
      title={
        value
          ? "Showing only tasks this subteam primarily owns. Click to also show tasks where it's a secondary contributor."
          : "Show only tasks this subteam primarily owns — hides tasks where it's just a secondary contributor."
      }
      className={
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-normal transition-colors " +
        (value
          ? "border-asu-gold/60 bg-asu-gold/10 text-asu-gold"
          : "border-helios-line bg-transparent text-helios-dim hover:text-helios-text") +
        (className ? " " + className : "")
      }
    >
      {value ? (
        <IconStarFilled size={11} />
      ) : (
        <IconStar size={11} strokeWidth={1.5} />
      )}
      Primary only
    </button>
  );
}
