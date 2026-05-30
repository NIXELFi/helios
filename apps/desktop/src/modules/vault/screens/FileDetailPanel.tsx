import { useVersions } from "../data/useVersions";
import { VersionList } from "../components/VersionList";
import { GetVersionButton } from "../components/RowActions";
import { ReferencesPanel } from "../components/ReferencesPanel";
import { useSetRevision } from "../data/useSetRevision";
import type { FileId, FolderId, Folder, VaultFile, Version } from "../data/types";

interface Props {
  fileId: FileId | null;
  /** The files in the current scope, used to resolve the selected file's name
   *  for the header and to detect a stale selection (a file that was deleted
   *  by another user since it was selected). Optional for callers that don't
   *  have the list handy — the header then falls back to a generic title. */
  files?: VaultFile[];
  /** Per-vault local working folder + the vault's folder tree. When provided,
   *  each version row gets a "Get this version" action (SW-PDM Get Version).
   *  Omitted by callers without a vault folder context — the panel is then
   *  view-only history (no Get action). */
  vaultRoot?: string | null;
  folders?: Folder[];
  /** Whether the current user may edit (editor/admin/owner). Gates the
   *  "Set Revision" action — viewers don't see it. */
  canEdit?: boolean;
}

export function FileDetailPanel({ fileId, files, vaultRoot, folders, canEdit }: Props) {
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

  return (
    <FileDetailLoader
      fileId={fileId}
      fileName={selected?.name ?? null}
      folderId={selected?.folder_id ?? null}
      vaultRoot={vaultRoot ?? null}
      folders={folders ?? []}
      canEdit={canEdit ?? false}
    />
  );
}

function FileDetailLoader({
  fileId, fileName, folderId, vaultRoot, folders, canEdit,
}: {
  fileId: FileId;
  fileName: string | null;
  folderId: FolderId | null;
  vaultRoot: string | null;
  folders: Folder[];
  canEdit: boolean;
}) {
  const { data, loading, error, refetch } = useVersions(fileId);
  const setRevision = useSetRevision();
  async function handleSetRevision() {
    const ok = await setRevision.run(fileId);
    if (ok) refetch();
  }
  // Only offer "Get this version" when we know the file's name (needed to
  // compute the local destination / save-dialog default).
  const renderActions = fileName
    ? (v: Version) => (
        <GetVersionButton
          version={v}
          fileName={fileName}
          folderId={folderId}
          vaultRoot={vaultRoot}
          folders={folders}
        />
      )
    : undefined;
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
      {/* Set Revision (SW-PDM): stamp the next numeric revision onto the latest
          version. Editor+ only; the RPC enforces perms regardless. */}
      {canEdit && data && data.length > 0 && (
        <div className="flex items-center justify-end border-b border-helios-line px-3 py-1.5">
          <button
            type="button"
            onClick={() => { void handleSetRevision(); }}
            disabled={setRevision.loading}
            title={setRevision.error ? `Set revision failed: ${setRevision.error.message}` : "Stamp the next revision number on the latest version"}
            className={
              "rounded border px-2 py-0.5 text-xs disabled:opacity-50 " +
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
              (setRevision.error
                ? "border-[#EF5350] bg-[#EF5350]/10 text-[#EF5350] hover:bg-[#EF5350]/20"
                : "border-helios-line text-helios-text hover:bg-helios-line")
            }
          >
            {setRevision.loading ? "…" : setRevision.error ? "Retry Set Revision" : "Set Revision"}
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-3 text-sm text-helios-dim">Loading…</div>
        ) : error ? (
          <div className="p-3 text-sm text-[#EF5350]">{error.message}</div>
        ) : !data || data.length === 0 ? (
          <div className="p-3 text-sm text-helios-dim">No versions yet.</div>
        ) : (
          <VersionList versions={data} onSelect={() => {}} renderActions={renderActions} />
        )}
      </div>
      {/* Assembly references for the latest version of the selected file. */}
      <ReferencesPanel versionId={data?.[0]?.id ?? null} fileId={fileId} />
    </aside>
  );
}
