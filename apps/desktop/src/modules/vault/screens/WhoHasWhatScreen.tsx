import { useLocks } from "../data/useLocks";
import { useForceUnlock } from "../data/useForceUnlock";
import { useIsAdmin } from "../data/useIsAdmin";

export function WhoHasWhatScreen() {
  const { data: locks, loading, error, refetch } = useLocks();
  const forceUnlock = useForceUnlock();
  const isAdmin = useIsAdmin();

  async function handleForceUnlock(lockId: string) {
    const reason = window.prompt("Reason for force unlock:");
    if (!reason || reason.trim() === "") return;
    const ok = await forceUnlock.run(lockId, reason.trim());
    if (ok) refetch();
  }

  return (
    <div className="h-full overflow-auto bg-helios-panel">
      <header className="border-b border-helios-line px-4 py-3 text-helios-dim">
        Active checkouts
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
              {locks.map((l) => (
                <tr key={l.id} className="border-t border-helios-line">
                  <td className="px-3 py-2 font-mono-num text-xs text-helios-dim">{l.file_id}</td>
                  <td className="px-3 py-2 text-helios-text">{l.user_id}</td>
                  <td className="px-3 py-2 text-helios-dim">{l.acquired_at}</td>
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
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
