export type LockState = "latest" | "out-of-date" | "locked-by-me" | "locked-by-other";

export function LockBadge(props: { state: LockState; holderEmail?: string }) {
  const { state, holderEmail } = props;
  const color = {
    "latest": "bg-emerald-500/20 text-emerald-300 border-emerald-700",
    "out-of-date": "bg-yellow-500/20 text-yellow-300 border-yellow-700",
    "locked-by-me": "bg-red-500/30 text-red-200 border-red-700",
    "locked-by-other": "bg-red-500/20 text-red-300 border-red-700",
  }[state];
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
