import { useMemo } from "react";
import { useLocks } from "../data/useLocks";
import { useForceUnlock } from "../data/useForceUnlock";
import { useIsAdmin } from "../data/useIsAdmin";
import { useActiveVault } from "../data/useActiveVault";
import { useAllFiles } from "../data/useAllFiles";
import { useFolders } from "../data/useFolders";
import { folderPath } from "../data/folder-paths";

/** Format an ISO timestamp as a short relative-time string ("3h ago",
 *  "2d ago", "just now"). Falls back to the raw timestamp on parse error. */
function relativeTime(iso: string): string {
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
  return new Date(iso).toLocaleDateString();
}

/** Short fingerprint for an unresolved user id — 8 hex chars is enough for a
 *  small team to recognize each other by, without dumping the full UUID. */
function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}

export function WhoHasWhatScreen() {
  const { activeVaultId, activeVault } = useActiveVault();
  const { data: locks, loading, error, refetch } = useLocks();
  const { data: files } = useAllFiles(activeVaultId ?? undefined);
  const { data: folders } = useFolders(activeVaultId ?? undefined);
  const forceUnlock = useForceUnlock();
  const isAdmin = useIsAdmin();

  // Build a file-id → "folder/path/name.ext" lookup so the table can show
  // human-readable paths instead of raw UUIDs. Locks whose file_id isn't in
  // this map (cross-vault, deleted, or files not yet loaded) still render —
  // they fall through to a short-id display. Never drop a lock from the
  // table; that masked the screen briefly showing locks during load and
  // then blanking once useAllFiles resolved without a match.
  const fileById = useMemo(() => {
    const m = new Map<string, { name: string; path: string }>();
    if (!files || !folders) return m;
    for (const f of files) {
      const dir = folderPath(f.folder_id, folders);
      m.set(f.id, { name: f.name, path: dir ? `${dir}/${f.name}` : f.name });
    }
    return m;
  }, [files, folders]);

  async function handleForceUnlock(lockId: string) {
    const reason = window.prompt("Reason for force unlock:");
    if (!reason || reason.trim() === "") return;
    const ok = await forceUnlock.run(lockId, reason.trim());
    if (ok) refetch();
  }

  return (
    <div className="h-full overflow-auto bg-helios-panel">
      <header className="border-b border-helios-line px-4 py-3 text-helios-dim">
        Active checkouts{activeVault ? ` — ${activeVault.name}` : ""}
      </header>
      <div className="p-2">
        {loading ? (
          <div className="p-4 text-sm text-helios-dim">Loading…</div>
        ) : error ? (
          <div className="p-4 text-sm text-[#EF5350]">{error.message}</div>
        ) : !locks || locks.length === 0 ? (
          <div className="p-4 text-sm text-helios-dim">Nothing checked out right now.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-helios-dim">
              <tr>
                <th className="px-3 py-2 font-normal">File</th>
                <th className="px-3 py-2 font-normal">Holder</th>
                <th className="px-3 py-2 font-normal">Since</th>
                {isAdmin && <th className="px-3 py-2 font-normal">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {locks.map((l) => {
                const file = fileById.get(l.file_id);
                return (
                  <tr key={l.id} className="border-t border-helios-line">
                    <td className="px-3 py-2 text-helios-text">
                      {file ? (
                        <span title={file.path}>{file.path}</span>
                      ) : (
                        <span className="font-mono-num text-xs text-helios-dim" title={l.file_id}>{shortId(l.file_id)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono-num text-xs text-helios-text" title={l.user_id}>
                      {shortId(l.user_id)}
                    </td>
                    <td className="px-3 py-2 text-helios-dim" title={l.acquired_at}>
                      {relativeTime(l.acquired_at)}
                    </td>
                    {isAdmin && (
                      <td className="px-3 py-2">
                        <button
                          onClick={() => handleForceUnlock(l.id)}
                          disabled={forceUnlock.loading}
                          className="rounded bg-red-800 px-2 py-0.5 text-xs text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          Force unlock
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
