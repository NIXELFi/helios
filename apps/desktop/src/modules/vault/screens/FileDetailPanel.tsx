import { useState } from "react";
import { useVersions } from "../data/useVersions";
import { VersionList } from "../components/VersionList";
import { GetVersionButton, RestoreVersionButton } from "../components/RowActions";
import { ReferencesPanel } from "../components/ReferencesPanel";
import { PropertiesPanel } from "../components/PropertiesPanel";
import { BomPanel } from "../components/BomPanel";
import { WatchToggleButton } from "../components/WatchToggleButton";
import { useSetRevision } from "../data/useSetRevision";
import { useVaultBom } from "../data/useVaultBom";
import type { FileId, FolderId, Folder, VaultFile, VaultId, Version } from "../data/types";

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
  /** Active vault id — required to load the BOM graph for assembly files. */
  vaultId?: VaultId | null;
  /** Watch/unwatch callbacks from useWatchedFiles — when provided the panel
   *  header shows a star toggle button. */
  isWatched?: boolean;
  onToggleWatch?: (fileId: FileId) => void;
}

export function FileDetailPanel({ fileId, files, vaultRoot, folders, canEdit, vaultId, isWatched, onToggleWatch }: Props) {
  if (!fileId) {
    // Placeholder panel is hidden on narrow windows — it carries no content,
    // and the space matters more (SQUEEZE). Selecting a file still shows the
    // real panel at every width.
    return (
      <aside className="hidden h-full w-72 shrink-0 items-center justify-center border-l border-helios-line bg-helios-base p-4 text-sm text-helios-dim lg:flex xl:w-80">
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
      <aside className="flex h-full w-72 shrink-0 flex-col border-l border-helios-line bg-helios-base xl:w-80">
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
      vaultId={vaultId ?? null}
      isWatched={isWatched}
      onToggleWatch={onToggleWatch}
    />
  );
}

/** True when the file name looks like a SolidWorks assembly. */
function isAssembly(name: string | null): boolean {
  return !!name && /\.sldasm$/i.test(name);
}

function FileDetailLoader({
  fileId, fileName, folderId, vaultRoot, folders, canEdit, vaultId, isWatched, onToggleWatch,
}: {
  fileId: FileId;
  fileName: string | null;
  folderId: FolderId | null;
  vaultRoot: string | null;
  folders: Folder[];
  canEdit: boolean;
  vaultId: VaultId | null;
  isWatched?: boolean;
  onToggleWatch?: (fileId: FileId) => void;
}) {
  const [showBom, setShowBom] = useState(false);
  const { data, loading, error, refetch } = useVersions(fileId);
  const setRevision = useSetRevision();
  // Load BOM graph only when the file is an assembly and the user opened the panel.
  const bomResult = useVaultBom(showBom && vaultId ? vaultId : undefined);
  async function handleSetRevision() {
    const ok = await setRevision.run(fileId);
    if (ok) refetch();
  }
  // Only offer per-version actions when we know the file's name (needed to
  // compute the local destination / save-dialog default). "Restore" (SW-PDM
  // rollback) appears for editors on every NON-latest row — restoring the
  // latest is a no-op; useVersions orders descending, so data[0] is latest.
  const latestId = data?.[0]?.id ?? null;
  const renderActions = fileName
    ? (v: Version) => (
        <span className="flex items-center gap-1">
          {canEdit && v.id !== latestId && (
            <RestoreVersionButton
              version={v}
              fileId={fileId}
              fileName={fileName}
              folderId={folderId}
              vaultRoot={vaultRoot}
              folders={folders}
              onDone={refetch}
            />
          )}
          <GetVersionButton
            version={v}
            fileName={fileName}
            folderId={folderId}
            vaultRoot={vaultRoot}
            folders={folders}
          />
        </span>
      )
    : undefined;
  // When BOM panel is open and graph is loaded, show BomPanel full-pane.
  if (showBom && bomResult.data && fileName) {
    return (
      <aside className="flex h-full w-72 shrink-0 flex-col border-l border-helios-line bg-helios-base xl:w-80">
        <BomPanel
          fileId={fileId}
          fileName={fileName}
          graph={bomResult.data}
          onClose={() => setShowBom(false)}
        />
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-l border-helios-line bg-helios-base xl:w-80">
      <header className="border-b border-helios-line px-3 py-2 text-xs uppercase tracking-wider text-helios-dim">
        {/* Show the file's name so a stale empty-history selection is
            distinguishable from a real file that simply has no versions. */}
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            {fileName ? (
              <span className="block truncate text-helios-text" title={fileName}>{fileName}</span>
            ) : (
              "History"
            )}
            {fileName && <span className="mt-0.5 block text-[10px] normal-case tracking-normal text-helios-dim">History</span>}
          </div>
          {/* Watch toggle — available whenever we have the file's id. */}
          {onToggleWatch && (
            <WatchToggleButton
              fileId={fileId}
              isWatched={isWatched ?? false}
              onToggle={onToggleWatch}
            />
          )}
        </div>
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
      {/* BOM button — only for .sldasm files with a vaultId available */}
      {isAssembly(fileName) && vaultId && (
        <div className="flex items-center justify-end border-b border-helios-line px-3 py-1.5">
          <button
            type="button"
            onClick={() => setShowBom(true)}
            disabled={showBom && bomResult.loading}
            title="View Bill of Materials for this assembly"
            className={
              "rounded border px-2 py-0.5 text-xs disabled:opacity-50 " +
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
              "border-helios-line text-helios-text hover:bg-helios-line"
            }
          >
            {showBom && bomResult.loading ? "Loading BOM…" : "View BOM"}
          </button>
        </div>
      )}
      {/* One unified scroll for history + data card + references, so a tall
          card (lots of properties) scrolls instead of crushing the version
          list. */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-3 text-sm text-helios-dim">Loading…</div>
        ) : error ? (
          <div className="p-3 text-sm text-[#EF5350]">{error.message}</div>
        ) : !data || data.length === 0 ? (
          <div className="p-3 text-sm text-helios-dim">No versions yet.</div>
        ) : (
          <>
            <VersionList versions={data} onSelect={() => {}} renderActions={renderActions} />
            {/* SolidWorks data card + assembly references for the latest version. */}
            <PropertiesPanel
              version={data[0] ?? null}
              fileName={fileName}
              folderId={folderId}
              vaultRoot={vaultRoot}
              folders={folders}
            />
            <ReferencesPanel versionId={data[0]?.id ?? null} fileId={fileId} />
          </>
        )}
      </div>
    </aside>
  );
}
