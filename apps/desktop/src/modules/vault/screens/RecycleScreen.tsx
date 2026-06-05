import { useMemo, useState } from "react";
import { useActiveVault } from "../data/useActiveVault";
import { useDeletedFiles } from "../data/useDeletedFiles";
import { useDeletedFolders } from "../data/useDeletedFolders";
import { useFolders } from "../data/useFolders";
import { useRestoreFile } from "../data/useRestoreFile";
import { useRestoreFolder } from "../data/useRestoreFolder";
import { folderPath } from "../data/folder-paths";
import type { FileId, FolderId } from "../data/types";

/** Short relative-time string ("3h ago", "2d ago"), falling back to the full
 *  locale date for old timestamps. (Local copy of the WhoHasWhat helper.) */
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleString();
}

/**
 * Recycle bin: soft-deleted files in the active vault, most-recently-deleted
 * first. Restore brings a file (and its full version history) back; the RPC
 * enforces deleter-or-admin permissions server-side. Visible to all roles.
 */
export function RecycleScreen() {
  const { activeVaultId, activeVault } = useActiveVault();
  const { data: files, loading: filesLoading, error: filesError, refetch: refetchFiles } = useDeletedFiles(activeVaultId ?? undefined);
  const { data: deletedFolders, loading: foldersLoading, error: foldersError, refetch: refetchDeletedFolders } = useDeletedFolders(activeVaultId ?? undefined);
  const { data: liveFolders, refetch: refetchLiveFolders } = useFolders(activeVaultId ?? undefined);
  const restore = useRestoreFile();
  const restoreFolder = useRestoreFolder();
  // Track the row mid-restore so its button alone disables (others stay live).
  const [restoringId, setRestoringId] = useState<FileId | null>(null);
  const [restoringFolderId, setRestoringFolderId] = useState<FolderId | null>(null);

  // Combined lookup for folderPath: live folders + deleted folders so parent
  // paths resolve even when the parent is itself deleted.
  const allFoldersLookup = useMemo(
    () => [...(liveFolders ?? []), ...(deletedFolders ?? [])],
    [liveFolders, deletedFolders],
  );

  const deletedFiles = files ?? [];

  const folderRows = useMemo(
    () =>
      (deletedFolders ?? []).map((f) => {
        // Parent path: walk through the combined live+deleted lookup so a
        // deleted child whose parent is also deleted resolves correctly.
        const parentPath = folderPath(f.parent_id, allFoldersLookup);
        const displayPath = parentPath ? `${parentPath}/${f.name}` : f.name;
        // Count files that were soft-deleted in the same batch as this folder
        // (non-null batch only; individually-deleted files have null here).
        const batchFileCount =
          f.delete_batch != null
            ? deletedFiles.filter(
                (x) => x.delete_batch != null && x.delete_batch === f.delete_batch,
              ).length
            : 0;
        return {
          id: f.id,
          name: f.name,
          displayPath,
          deletedAt: f.deleted_at ?? null,
          batchFileCount,
        };
      }),
    [deletedFolders, allFoldersLookup, deletedFiles],
  );

  const fileRows = useMemo(
    () =>
      deletedFiles.map((f) => {
        const dir = folderPath(f.folder_id, allFoldersLookup);
        return {
          id: f.id,
          path: dir ? `${dir}/${f.name}` : f.name,
          deletedAt: f.deleted_at ?? null,
        };
      }),
    [deletedFiles, allFoldersLookup],
  );

  async function onRestoreFile(id: FileId) {
    setRestoringId(id);
    const ok = await restore.run(id);
    setRestoringId(null);
    if (ok) {
      refetchFiles();
      refetchDeletedFolders();
      refetchLiveFolders();
    }
  }

  async function onRestoreFolder(id: FolderId) {
    setRestoringFolderId(id);
    const ok = await restoreFolder.run(id);
    setRestoringFolderId(null);
    if (ok) {
      refetchDeletedFolders();
      refetchFiles();
      refetchLiveFolders();
    }
  }

  const loading = filesLoading || foldersLoading;
  const error = filesError ?? foldersError;

  return (
    <div className="h-full overflow-auto bg-helios-panel">
      <header className="border-b border-helios-line px-4 py-3 text-helios-dim">
        Deleted files{activeVault ? ` — ${activeVault.name}` : ""}
      </header>
      {(restore.error ?? restoreFolder.error) && (
        <div className="border-b border-red-500/40 bg-red-500/10 px-4 py-1.5 text-xs text-red-200" role="alert">
          {(restore.error ?? restoreFolder.error)!.message}
        </div>
      )}
      <div className="p-2">
        {loading ? (
          <div className="p-4 text-sm text-helios-dim">Loading…</div>
        ) : error ? (
          <div className="p-4 text-sm text-[#EF5350]">{error.message}</div>
        ) : folderRows.length === 0 && fileRows.length === 0 ? (
          <div className="p-4 text-sm text-helios-dim">
            No deleted files. Files you delete appear here and can be restored.
          </div>
        ) : (
          <>
            {folderRows.length > 0 && (
              <div className="mb-4">
                <div className="px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-helios-dim">
                  Folders
                </div>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-helios-dim">
                    <tr>
                      <th className="px-3 py-2 font-normal">Folder</th>
                      <th className="px-3 py-2 font-normal">Deleted</th>
                      <th className="px-3 py-2 font-normal">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {folderRows.map((r) => (
                      <tr key={r.id} className="border-t border-helios-line">
                        <td className="px-3 py-2 text-helios-text">
                          <span title={r.displayPath} className="font-medium">{r.displayPath}</span>
                          {r.batchFileCount > 0 && (
                            <span className="ml-2 text-xs text-helios-dim">
                              restores {r.batchFileCount} file{r.batchFileCount !== 1 ? "s" : ""} deleted with it
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-helios-dim" title={r.deletedAt ?? undefined}>
                          {relativeTime(r.deletedAt)}
                        </td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={() => onRestoreFolder(r.id)}
                            disabled={restoringFolderId === r.id}
                            className="rounded border border-helios-line bg-helios-base px-2 py-0.5 text-xs text-helios-text hover:border-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
                          >
                            {restoringFolderId === r.id ? "Restoring…" : "Restore"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {fileRows.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-helios-dim">
                  Files
                </div>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-helios-dim">
                    <tr>
                      <th className="px-3 py-2 font-normal">File</th>
                      <th className="px-3 py-2 font-normal">Deleted</th>
                      <th className="px-3 py-2 font-normal">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fileRows.map((r) => (
                      <tr key={r.id} className="border-t border-helios-line">
                        <td className="px-3 py-2 text-helios-text">
                          <span title={r.path}>{r.path}</span>
                        </td>
                        <td className="px-3 py-2 text-helios-dim" title={r.deletedAt ?? undefined}>
                          {relativeTime(r.deletedAt)}
                        </td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={() => onRestoreFile(r.id)}
                            disabled={restoringId === r.id}
                            className="rounded border border-helios-line bg-helios-base px-2 py-0.5 text-xs text-helios-text hover:border-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
                          >
                            {restoringId === r.id ? "Restoring…" : "Restore"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
