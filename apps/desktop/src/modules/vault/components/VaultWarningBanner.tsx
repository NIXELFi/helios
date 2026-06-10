// Dismissible amber strip for non-fatal vault warnings (unresolved assembly
// references, unreadable data cards, …) fired through vault-warning-events.
// Keeps the last few so a multi-file check-in doesn't overwrite itself.

import { useEffect, useState } from "react";

import { onVaultWarning, type VaultWarning } from "../data/vault-warning-events";

const MAX_SHOWN = 3;

export function VaultWarningBanner() {
  const [warnings, setWarnings] = useState<VaultWarning[]>([]);

  useEffect(
    () => onVaultWarning((w) => setWarnings((prev) => [...prev.slice(-(MAX_SHOWN - 1)), w])),
    [],
  );

  if (warnings.length === 0) return null;
  return (
    <div role="alert" className="border-b border-[#FFB300]/40 bg-[#FFB300]/10 px-3 py-1.5 text-xs">
      {warnings.map((w, i) => (
        <div key={i} className="flex items-baseline gap-2">
          <span className="text-[#FFB300]">⚠ {w.title}</span>
          <span className="min-w-0 flex-1 truncate text-helios-dim" title={w.detail}>{w.detail}</span>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setWarnings([])}
        className="mt-0.5 text-[10px] uppercase tracking-wider text-helios-dim hover:text-white"
      >
        Dismiss
      </button>
    </div>
  );
}
