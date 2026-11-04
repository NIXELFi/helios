// Amber strip shown when the vault folder holds ANSYS solver output that
// Helios is deliberately not adding (see data/ansys-solver-output.ts). A solve
// in progress keeps this list alive, so it can be dismissed; it comes back
// only when MORE such files show up than were on screen when dismissed.

import { useState } from "react";

import { ANSYS_SOLVER_OUTPUT_NOTE } from "../data/ansys-solver-output";
import type { LocalFile } from "../data/useLocalFolderScan";

export function SolverOutputNotice({ blocked }: { blocked: LocalFile[] }) {
  const [dismissedAt, setDismissedAt] = useState(0);
  if (blocked.length === 0 || blocked.length <= dismissedAt) return null;
  const sample = blocked.slice(0, 3).map((f) => f.basename).join(", ");
  return (
    <div role="status" className="border-b border-[#FFB300]/40 bg-[#FFB300]/10 px-3 py-1.5 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="text-[#FFB300]">{ANSYS_SOLVER_OUTPUT_NOTE}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-helios-dim" title={blocked.map((f) => f.relativePath).join("\n")}>
          Not added: {blocked.length} file{blocked.length === 1 ? "" : "s"} ({sample}{blocked.length > 3 ? ", ..." : ""})
        </span>
        <button
          type="button"
          onClick={() => setDismissedAt(blocked.length)}
          className="text-[10px] uppercase tracking-wider text-helios-dim hover:text-white"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
