export type LocalStatus = "synced" | "modified" | "vault-only" | "no-folder";

export function LocalStatusBadge({ status }: { status: LocalStatus }) {
  if (status === "no-folder") return null;
  const cfg = {
    "synced": { label: "Synced", color: "bg-[#66BB6A]/15 text-[#9CCC65] border-[#66BB6A]/40" },
    "modified": { label: "Modified", color: "bg-[#FFB800]/20 text-[#FFD24D] border-[#FFB800]/40" },
    "vault-only": { label: "Not local", color: "bg-helios-line/40 text-helios-dim border-helios-line" },
  }[status];
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}
