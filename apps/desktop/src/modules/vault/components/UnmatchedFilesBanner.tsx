import { useState } from "react";
import { useAddLocalFile } from "../data/useAddLocalFile";
import type { VaultId } from "../data/types";
import type { LocalFile } from "../data/useLocalFolderScan";

interface Props {
  vaultId: VaultId | undefined;
  unmatched: LocalFile[];
  onDone?: () => void;
}

export function UnmatchedFilesBanner({ vaultId, unmatched, onDone }: Props) {
  const addFile = useAddLocalFile();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  if (!vaultId || unmatched.length === 0) return null;

  async function addOne(f: LocalFile) {
    setBusy(true);
    const ok = await addFile.run(vaultId!, f);
    setBusy(false);
    if (ok) onDone?.();
  }

  async function addAll() {
    setBusy(true);
    let ok = 0, fail = 0;
    for (const f of unmatched) {
      const r = await addFile.run(vaultId!, f);
      if (r) ok++;
      else fail++;
      setProgress(`${ok + fail}/${unmatched.length}`);
    }
    setProgress(null);
    setBusy(false);
    if (ok > 0) onDone?.();
  }

  return (
    <div className="border-b border-[#FFB800]/40/50 bg-[#FFB800]/10 px-4 py-2 text-sm">
      <div className="flex items-center gap-3">
        <span className="text-[#FFD24D]">
          {unmatched.length} local file{unmatched.length === 1 ? "" : "s"} not in vault
        </span>
        <button
          onClick={addAll}
          disabled={busy}
          className="rounded bg-[#FFB800] px-3 py-1 text-xs text-white hover:bg-[#FFB800] disabled:opacity-50"
        >
          {busy && progress ? `Adding ${progress}…` : "Add all to vault"}
        </button>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="rounded border border-[#FFB800]/40 px-3 py-1 text-xs text-[#FFD24D] hover:bg-[#FFB800]/20"
        >
          {expanded ? "Hide" : "Show"}
        </button>
        {addFile.error && <span className="text-xs text-red-300">{addFile.error.message}</span>}
      </div>
      {expanded && (
        <ul className="mt-2 max-h-48 space-y-1 overflow-auto rounded border border-[#FFB800]/40/30 bg-helios-base p-2 font-mono-num text-xs">
          {unmatched.map((f) => (
            <li key={f.absolutePath} className="flex items-center justify-between gap-2 px-1">
              <span className="truncate text-helios-text">{f.relativePath}</span>
              <button
                onClick={(e) => { e.stopPropagation(); addOne(f); }}
                disabled={busy}
                className="shrink-0 rounded border border-[#FFB800]/40 px-2 py-0.5 text-xs text-[#FFD24D] hover:bg-[#FFB800]/20 disabled:opacity-50"
              >
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
