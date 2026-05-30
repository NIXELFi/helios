import { useVersions } from "../data/useVersions";
import { VersionList } from "../components/VersionList";
import type { FileId, VaultFile } from "../data/types";

interface Props {
  fileId: FileId | null;
  /** The files in the current scope, used to resolve the selected file's name
   *  for the header and to detect a stale selection (a file that was deleted
   *  by another user since it was selected). Optional for callers that don't
   *  have the list handy — the header then falls back to a generic title. */
  files?: VaultFile[];
}

export function FileDetailPanel({ fileId, files }: Props) {
  if (!fileId) {
    return (
      <aside className="flex h-full w-80 items-center justify-center border-l border-helios-line bg-helios-base p-4 text-sm text-helios-dim">
        Select a file to see its history.
      </aside>
    );
  }
  // When we have the file list, resolve the selected file. `undefined` means
  // it's no longer present (deleted elsewhere); `null`/missing list means we
  // simply don't know the name.
  const selected = files?.find((f) => f.id === fileId);
  const fileMissing = files !== undefined && selected === undefined;

  if (fileMissing) {
    return (
      <aside className="flex h-full w-80 flex-col border-l border-helios-line bg-helios-base">
        <header className="border-b border-helios-line px-3 py-2 text-xs uppercase tracking-wider text-helios-dim">
          History
        </header>
        <div className="flex-1 overflow-auto p-3 text-sm text-helios-dim">
          This file is no longer available — it may have been deleted. Pick another file.
        </div>
      </aside>
    );
  }

  return <FileDetailLoader fileId={fileId} fileName={selected?.name ?? null} />;
}

function FileDetailLoader({ fileId, fileName }: { fileId: FileId; fileName: string | null }) {
  const { data, loading, error } = useVersions(fileId);
  return (
    <aside className="flex h-full w-80 flex-col border-l border-helios-line bg-helios-base">
      <header className="border-b border-helios-line px-3 py-2 text-xs uppercase tracking-wider text-helios-dim">
        {/* Show the file's name so a stale empty-history selection is
            distinguishable from a real file that simply has no versions. */}
        {fileName ? (
          <span className="block truncate text-helios-text" title={fileName}>{fileName}</span>
        ) : (
          "History"
        )}
        {fileName && <span className="mt-0.5 block text-[10px] normal-case tracking-normal text-helios-dim">History</span>}
      </header>
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-3 text-sm text-helios-dim">Loading…</div>
        ) : error ? (
          <div className="p-3 text-sm text-[#EF5350]">{error.message}</div>
        ) : !data || data.length === 0 ? (
          <div className="p-3 text-sm text-helios-dim">No versions yet.</div>
        ) : (
          <VersionList versions={data} onSelect={() => {}} />
        )}
      </div>
    </aside>
  );
}
