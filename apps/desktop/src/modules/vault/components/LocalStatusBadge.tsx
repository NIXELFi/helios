export type LocalStatus = "synced" | "modified" | "vault-only" | "no-folder";

export function LocalStatusBadge({ status }: { status: LocalStatus }) {
  if (status === "no-folder") return null;
  const cfg = {
    "synced": { label: "Synced", color: "bg-emerald-500/15 text-emerald-300 border-emerald-700" },
    "modified": { label: "Modified", color: "bg-amber-500/20 text-amber-300 border-amber-700" },
    "vault-only": { label: "Not local", color: "bg-zinc-500/20 text-zinc-400 border-zinc-700" },
  }[status];
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}
