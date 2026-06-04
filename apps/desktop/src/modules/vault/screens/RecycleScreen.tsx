import { useMemo, useState } from "react";
import { useActiveVault } from "../data/useActiveVault";
import { useDeletedFiles } from "../data/useDeletedFiles";
import { useFolders } from "../data/useFolders";
import { useRestoreFile } from "../data/useRestoreFile";
import { folderPath } from "../data/folder-paths";
import type { FileId } from "../data/types";

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
  const { data: files, loading, error, refetch } = useDeletedFiles(activeVaultId ?? undefined);
  const { data: folders } = useFolders(activeVaultId ?? undefined);
  const restore = useRestoreFile();
  // Track the row mid-restore so its button alone disables (others stay live).
  const [restoringId, setRestoringId] = useState<FileId | null>(null);

  const rows = useMemo(
    () =>
      (files ?? []).map((f) => {
        const dir = folderPath(f.folder_id, folders ?? []);
        return {
          id: f.id,
          path: dir ? `${dir}/${f.name}` : f.name,
          deletedAt: f.deleted_at ?? null,
        };
      }),
    [files, folders],
  );

  async function onRestore(id: FileId) {
    setRestoringId(id);
    const ok = await restore.run(id);
    setRestoringId(null);
    if (ok) refetch();
  }

  return (
    <div className="h-full overflow-auto bg-helios-panel">
      <header className="border-b border-helios-line px-4 py-3 text-helios-dim">
        Deleted files{activeVault ? ` — ${activeVault.name}` : ""}
      </header>
      {restore.error && (
        <div className="border-b border-red-500/40 bg-red-500/10 px-4 py-1.5 text-xs text-red-200" role="alert">
          {restore.error.message}
        </div>
      )}
      <div className="p-2">
        {loading ? (
          <div className="p-4 text-sm text-helios-dim">Loading…</div>
        ) : error ? (
          <div className="p-4 text-sm text-[#EF5350]">{error.message}</div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-sm text-helios-dim">
            No deleted files. Files you delete appear here and can be restored.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-helios-dim">
              <tr>
                <th className="px-3 py-2 font-normal">File</th>
                <th className="px-3 py-2 font-normal">Deleted</th>
                <th className="px-3 py-2 font-normal">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
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
                      onClick={() => onRestore(r.id)}
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
        )}
      </div>
    </div>
  );
}
