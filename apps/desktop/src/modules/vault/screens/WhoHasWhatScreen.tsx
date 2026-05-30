import { useMemo, useState } from "react";
import { useLocks } from "../data/useLocks";
import { useForceUnlock } from "../data/useForceUnlock";
import { useIsAdmin } from "../data/useIsAdmin";
import { useActiveVault } from "../data/useActiveVault";
import { useAllFiles } from "../data/useAllFiles";
import { useFolders } from "../data/useFolders";
import { useVaultUsers } from "../data/useVaultUsers";
import { folderPath } from "../data/folder-paths";

/** Format an ISO timestamp as a short relative-time string ("3h ago",
 *  "2d ago", "just now"). Falls back to the full locale date+time on a very
 *  old timestamp (or parse error) — `toLocaleString`, not `toLocaleDateString`,
 *  so the time-of-day isn't dropped. */
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
  return new Date(iso).toLocaleString();
}

/** Short fingerprint for an unresolved user/file id — 8 hex chars is enough for
 *  a small team to recognize each other by, without dumping the full UUID. */
function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}

export function WhoHasWhatScreen() {
  const { activeVaultId, activeVault } = useActiveVault();
  const { data: locks, loading, error, refetch } = useLocks();
  const { data: files } = useAllFiles(activeVaultId ?? undefined);
  const { data: folders } = useFolders(activeVaultId ?? undefined);
  // Holder resolution. useVaultUsers is admin-gated (the RPC raises for
  // non-admins) — we ignore its error and fall back to the short id, so a
  // viewer still sees the screen; an admin gets real names.
  const { data: users } = useVaultUsers();
  const forceUnlock = useForceUnlock();
  const isAdmin = useIsAdmin();
  // Which lock id has an in-flight force-unlock. A single shared
  // forceUnlock.loading would disable EVERY row's button; tracking the
  // targeted id keeps the other rows clickable.
  const [unlockingId, setUnlockingId] = useState<string | null>(null);

  // Build a file-id → "folder/path/name.ext" lookup so the table can show
  // human-readable paths instead of raw UUIDs.
  const fileById = useMemo(() => {
    const m = new Map<string, { name: string; path: string }>();
    if (!files || !folders) return m;
    for (const f of files) {
      const dir = folderPath(f.folder_id, folders);
      m.set(f.id, { name: f.name, path: dir ? `${dir}/${f.name}` : f.name });
    }
    return m;
  }, [files, folders]);

  // user-id → display name / email for holder resolution.
  const userById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users ?? []) {
      const label = u.display_name ?? u.email ?? null;
      if (label) m.set(u.user_id, label);
    }
    return m;
  }, [users]);

  // H12: useLocks is cross-vault, but this screen claims "{vault} checkouts".
  // Once the active vault's files are actually loaded (non-empty set), drop
  // locks whose file_id isn't among them — those belong to another vault.
  // When no files are loaded yet (null / empty — still loading, or the vault
  // genuinely has none), keep every lock so the screen doesn't blank during
  // load and deleted-file locks still surface (preserves the 2026-05-25 fix).
  const visibleLocks = useMemo(() => {
    if (!locks) return locks;
    if (!files || files.length === 0) return locks;
    return locks.filter((l) => fileById.has(l.file_id));
  }, [locks, files, fileById]);

  async function handleForceUnlock(lockId: string) {
    const reason = window.prompt("Reason for force unlock:");
    if (!reason || reason.trim() === "") return;
    setUnlockingId(lockId);
    const ok = await forceUnlock.run(lockId, reason.trim());
    setUnlockingId(null);
    if (ok) refetch();
  }

  return (
    <div className="h-full overflow-auto bg-helios-panel">
      <header className="border-b border-helios-line px-4 py-3 text-helios-dim">
        Active checkouts{activeVault ? ` — ${activeVault.name}` : ""}
      </header>
      {/* Surface a failed force-unlock — previously swallowed entirely. */}
      {forceUnlock.error && (
        <div className="border-b border-red-500/40 bg-red-500/10 px-4 py-1.5 text-xs text-red-200" role="alert">
          {forceUnlock.error.message}
        </div>
      )}
      <div className="p-2">
        {loading ? (
          <div className="p-4 text-sm text-helios-dim">Loading…</div>
        ) : error ? (
          <div className="p-4 text-sm text-[#EF5350]">{error.message}</div>
        ) : !visibleLocks || visibleLocks.length === 0 ? (
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
              {visibleLocks.map((l) => {
                const file = fileById.get(l.file_id);
                const holderName = userById.get(l.user_id);
                return (
                  <tr key={l.id} className="border-t border-helios-line">
                    <td className="px-3 py-2 text-helios-text">
                      {file ? (
                        <span title={file.path}>{file.path}</span>
                      ) : (
                        <span className="font-mono-num text-xs text-helios-dim" title={l.file_id}>{shortId(l.file_id)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-helios-text" title={l.user_id}>
                      {holderName ? (
                        holderName
                      ) : (
                        <span className="font-mono-num text-xs">{shortId(l.user_id)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-helios-dim" title={l.acquired_at}>
                      {relativeTime(l.acquired_at)}
                    </td>
                    {isAdmin && (
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => handleForceUnlock(l.id)}
                          disabled={unlockingId === l.id}
                          className="rounded bg-red-800 px-2 py-0.5 text-xs text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
                        >
                          {unlockingId === l.id ? "Unlocking…" : "Force unlock"}
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
