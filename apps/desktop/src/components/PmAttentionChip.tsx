import { usePmAttention } from "../lib/pm-attention";

/**
 * Title-bar chip for "what's due for me" in PM. Hidden unless you own an
 * open task due today or overdue; overdue wins the colour. Click jumps to
 * PM. Data comes from lib/pm-attention, not the PM store, so it works
 * before PM has ever been opened this session.
 */
export function PmAttentionChip({
  client,
  userId,
  onClick,
}: {
  client: unknown;
  userId: string | null;
  onClick: () => void;
}) {
  const att = usePmAttention(client, userId);
  if (!att || (att.dueToday === 0 && att.overdue === 0)) return null;

  const parts: string[] = [];
  if (att.overdue > 0) parts.push(`${att.overdue} overdue`);
  if (att.dueToday > 0) parts.push(`${att.dueToday} due today`);
  const label = parts.join(" · ");
  const tone = att.overdue > 0 ? "text-[#EF5350]" : "text-asu-gold";
  const dot = att.overdue > 0 ? "bg-[#EF5350]" : "bg-asu-gold";

  return (
    <button
      type="button"
      onClick={onClick}
      title={`Tasks you own in PM: ${label}. Click to open PM`}
      aria-label={`PM: ${label}`}
      className={
        "mr-2 flex h-[22px] cursor-pointer items-center gap-1.5 rounded px-2 text-[11px] transition-colors hover:bg-white/[0.07] " +
        tone
      }
    >
      <span className={"inline-block h-1.5 w-1.5 rounded-full " + dot} />
      <span className="font-mono-num tabular-nums">PM · {label}</span>
    </button>
  );
}
