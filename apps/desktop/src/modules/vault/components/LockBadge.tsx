export type LockState = "latest" | "out-of-date" | "locked-by-me" | "locked-by-other";

export function LockBadge(props: { state: LockState; holderEmail?: string }) {
  const { state, holderEmail } = props;
  // Shared status palette (kept in sync with LocalStatusBadge): green = good,
  // gold = needs attention, red = locked. Same hex values across both badges
  // so the vault chrome reads consistently. "locked-by-me" gets a slightly
  // stronger red fill than "locked-by-other" so the user can tell at a glance
  // which lock is theirs.
  const colors: Record<LockState, string> = {
    "latest": "bg-[#66BB6A]/20 text-[#9CCC65] border-[#66BB6A]/40",
    "out-of-date": "bg-[#FFB800]/20 text-[#FFD24D] border-[#FFB800]/40",
    "locked-by-me": "bg-[#EF5350]/30 text-[#EF9A9A] border-[#EF5350]/50",
    "locked-by-other": "bg-[#EF5350]/20 text-[#E57373] border-[#EF5350]/40",
  };
  const color = colors[state];
  const label = {
    "latest": "Up to date",
    "out-of-date": "Out of date",
    "locked-by-me": "Locked by me",
    "locked-by-other": holderEmail ? `Locked by ${holderEmail}` : "Locked by other",
  }[state];
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${color}`}>
      {label}
    </span>
  );
}
