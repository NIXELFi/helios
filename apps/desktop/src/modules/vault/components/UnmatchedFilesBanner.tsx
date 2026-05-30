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
  const [summary, setSummary] = useState<string | null>(null);

  if (!vaultId || unmatched.length === 0) return null;

  async function addOne(f: LocalFile) {
    setBusy(true);
    setSummary(null);
    const r = await addFile.run(vaultId!, f);
    setBusy(false);
    if (r.ok) {
      onDone?.();
      if (!r.lockAcquired) {
        setSummary(`Added "${f.basename}" to vault, but another user holds the lock.`);
      }
    } else {
      // Previously a failed single-row add was silent (only addAll aggregated
      // failures). Surface it so the user knows which file failed and why.
      setSummary(`Failed to add "${f.basename}": ${r.error}`);
    }
  }

  async function addAll() {
    setBusy(true);
    setSummary(null);
    let added = 0;
    let lockHeldByOther = 0;
    let fail = 0;
    for (const f of unmatched) {
      const r = await addFile.run(vaultId!, f);
      if (r.ok && r.lockAcquired) added++;
      else if (r.ok) lockHeldByOther++;
      else fail++;
      setProgress(`${added + lockHeldByOther + fail}/${unmatched.length}`);
    }
    setProgress(null);
    setBusy(false);
    if (added + lockHeldByOther > 0) onDone?.();
    if (lockHeldByOther > 0 || fail > 0) {
      const parts: string[] = [];
      if (added > 0) parts.push(`${added} added`);
      if (lockHeldByOther > 0) parts.push(`${lockHeldByOther} already in vault (locked by another user)`);
      if (fail > 0) parts.push(`${fail} failed`);
      setSummary(parts.join(", "));
    }
  }

  return (
    <div className="border-b border-[#FFB800]/50 bg-[#FFB800]/10 px-4 py-2 text-sm">
      <div className="flex items-center gap-3">
        <span className="text-[#FFD24D]">
          {unmatched.length} local file{unmatched.length === 1 ? "" : "s"} not in vault
        </span>
        <button
          onClick={addAll}
          disabled={busy}
          className="rounded bg-[#FFB800] px-3 py-1 text-xs text-white hover:brightness-110 disabled:opacity-50"
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
        {summary && <span className="text-xs text-[#FFD24D]">{summary}</span>}
      </div>
      {expanded && (
        <ul className="mt-2 max-h-48 space-y-1 overflow-auto rounded border border-[#FFB800]/30 bg-helios-base p-2 font-mono-num text-xs">
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
