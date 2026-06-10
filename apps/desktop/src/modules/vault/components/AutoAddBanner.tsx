// Passive status strip for SW-PDM-style automatic vaulting (auto mode). New
// local files are added as private checked-out drafts without a click — this
// just narrates progress and surfaces failures (which retry on a backoff).

import type { AutoAddStatus } from "../data/useAutoAddDrafts";

export function AutoAddBanner({ status }: { status: AutoAddStatus }) {
  if (!status.adding && status.failures.length === 0) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-b border-helios-line bg-helios-panel px-3 py-1.5 text-xs"
    >
      {status.adding && (
        <span className="text-helios-dim">
          Vaulting <span className="font-mono text-white">{status.adding}</span> as a
          checked-out draft… (private until you check it in)
        </span>
      )}
      {status.failures.length > 0 && (
        <span className="text-[#EF5350]">
          {status.failures.length} file{status.failures.length === 1 ? "" : "s"} couldn't be
          vaulted ({status.failures[0]!.name}: {status.failures[0]!.error}) — will retry.
        </span>
      )}
    </div>
  );
}
