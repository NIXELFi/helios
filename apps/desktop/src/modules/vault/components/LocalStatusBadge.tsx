export type LocalStatus = "synced" | "modified" | "vault-only" | "no-folder";

// Shared status palette (kept in sync with LockBadge): green = good/synced,
// gold = modified, neutral = absent. Same hex values across both badges so the
// vault chrome reads consistently. Exhaustive over LocalStatus so adding a new
// status value is a compile error here rather than a runtime `undefined.color`
// crash in the table row.
const CONFIG: Record<LocalStatus, { label: string; color: string } | null> = {
  "synced": { label: "Synced", color: "bg-[#66BB6A]/20 text-[#9CCC65] border-[#66BB6A]/40" },
  "modified": { label: "Modified", color: "bg-[#FFB800]/20 text-[#FFD24D] border-[#FFB800]/40" },
  "vault-only": { label: "Not local", color: "bg-helios-line/40 text-helios-dim border-helios-line" },
  "no-folder": null,
};

export function LocalStatusBadge({ status }: { status: LocalStatus }) {
  // Defensive lookup: a status outside the map (or an explicit `null` entry
  // like "no-folder") renders nothing instead of throwing.
  const cfg = CONFIG[status];
  if (!cfg) return null;
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}
