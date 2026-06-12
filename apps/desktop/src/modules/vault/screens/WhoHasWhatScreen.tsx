import { useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "@helios/auth";
import { useLocks } from "../data/useLocks";
import { useForceUnlock } from "../data/useForceUnlock";
import { useIsAdmin } from "../data/useIsAdmin";
import { useActiveVault } from "../data/useActiveVault";
import { useFilesByIds, type LockFileRow } from "../data/useFilesByIds";
import { useCrossVaultFolders } from "../data/useCrossVaultFolders";
import { useVaultUsers } from "../data/useVaultUsers";
import { folderPath } from "../data/folder-paths";
import type { Lock, VaultUser } from "../data/types";

/** Canonical lock-holder label: prefer the human display name, then the email,
 *  else null (caller falls back to a short id). Shared so every screen that
 *  names a lock holder (WhoHasWhat, HistoryScreen) reads the same — closes the
 *  BrowseScreen email-first vs WhoHasWhat name-first inconsistency (HOLDER-LABEL).
 *  Standardized on display_name-first. */
export function holderLabel(u: Pick<VaultUser, "display_name" | "email">): string | null {
  return u.display_name ?? u.email ?? null;
}

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

interface LockRow {
  lock: Lock;
  file: LockFileRow | null;
  path: string | null;
}

interface VaultGroup {
  /** null = locks whose file couldn't be resolved (RLS-hidden vault or a
   *  hard-deleted file) — rendered last as "Other vaults". */
  vaultId: string | null;
  vaultName: string;
  rows: LockRow[];
}

export function WhoHasWhatScreen() {
  const user = useUser();
  // "Just mine" chip — one click to audit your own checkouts.
  const [mineOnly, setMineOnly] = useState(false);
  const { activeVaultId, vaults } = useActiveVault();
  const { data: locks, loading, error, refetch } = useLocks();
  // Resolve every lock's file by id — across ALL vaults, deleted included —
  // instead of paging the active vault's whole file list. This is what lets
  // the screen show every checkout grouped by vault rather than filtering to
  // the active vault (and is why the old show-then-filter flash is gone).
  const lockFileIds = useMemo(
    () => (locks ?? []).map((l) => l.file_id),
    [locks],
  );
  const { data: lockFiles, loading: filesLoading, error: filesError } = useFilesByIds(lockFileIds);
  const { data: folders, error: foldersError } = useCrossVaultFolders();
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
  // Lock id awaiting a force-unlock REASON in the in-app modal. window.prompt
  // is a no-op in the Tauri webview, so the reason is collected via an in-app
  // dialog instead (C1-MISS). null = modal closed.
  const [reasonFor, setReasonFor] = useState<string | null>(null);

  const fileById = useMemo(() => {
    const m = new Map<string, LockFileRow>();
    for (const f of lockFiles ?? []) m.set(f.id, f);
    return m;
  }, [lockFiles]);

  // user-id → display name / email for holder resolution (display_name-first
  // via the shared holderLabel helper).
  const userById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users ?? []) {
      const label = holderLabel(u);
      if (label) m.set(u.user_id, label);
    }
    return m;
  }, [users]);

  const vaultNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of vaults) m.set(v.id, v.name);
    return m;
  }, [vaults]);

  // Group every lock under its file's vault. Path resolution (folders) only
  // affects the path TEXT, never whether a row appears — the old screen
  // filtered rows on the file/folder lookup, which is what caused both the
  // open-flash and the false "Nothing checked out" while folders loaded.
  const groups = useMemo<VaultGroup[]>(() => {
    if (!locks) return [];
    const byVault = new Map<string, LockRow[]>();
    const unresolved: LockRow[] = [];
    for (const lock of locks) {
      const file = fileById.get(lock.file_id) ?? null;
      if (!file) {
        unresolved.push({ lock, file: null, path: null });
        continue;
      }
      const dir = folders ? folderPath(file.folder_id, folders) : "";
      const path = dir ? `${dir}/${file.name}` : file.name;
      const rows = byVault.get(file.vault_id) ?? [];
      rows.push({ lock, file, path });
      byVault.set(file.vault_id, rows);
    }
    const out: VaultGroup[] = [...byVault.entries()].map(([vaultId, rows]) => ({
      vaultId,
      vaultName: vaultNameById.get(vaultId) ?? shortId(vaultId),
      rows,
    }));
    // Active vault first, then alphabetical; unresolved last.
    out.sort((a, b) => {
      if (a.vaultId === activeVaultId) return -1;
      if (b.vaultId === activeVaultId) return 1;
      return a.vaultName.localeCompare(b.vaultName);
    });
    if (unresolved.length > 0) {
      out.push({ vaultId: null, vaultName: "Other vaults", rows: unresolved });
    }
    return out;
  }, [locks, fileById, folders, vaultNameById, activeVaultId]);

  function requestForceUnlock(lockId: string) {
    setReasonFor(lockId);
  }

  async function submitForceUnlock(reason: string) {
    const lockId = reasonFor;
    setReasonFor(null);
    if (!lockId || reason.trim() === "") return;
    setUnlockingId(lockId);
    // Pass the lock's file_id so the optimistic overlay can clear its pill.
    const fileId = locks?.find((l) => l.id === lockId)?.file_id ?? "";
    const ok = await forceUnlock.run(lockId, fileId, reason.trim());
    setUnlockingId(null);
    if (ok) refetch();
  }

  // Surface a degraded path-resolution context (files/folders failed to load)
  // so paths don't silently fall back to short ids with no explanation.
  const contextError = filesError ?? foldersError;
  // Hold the loading state until the locks' files are resolved too — rendering
  // locks before resolution is what produced the open-flash. `lockFiles ===
  // null` covers the one-commit gap between the locks landing and
  // useFilesByIds' effect flipping its own loading flag — without it the rows
  // flash under "Other vaults" for a frame, then remount under their real
  // vault (which also detaches any element a test or user just targeted).
  // A files error ends the wait so the screen can degrade to short ids.
  const resolving =
    loading ||
    (lockFileIds.length > 0 && !filesError && (filesLoading || lockFiles === null));
  // Apply the "just mine" chip AFTER grouping so the group structure (and
  // vault ordering) stays stable while toggling.
  const visibleGroups = useMemo(() => {
    if (!mineOnly) return groups;
    const me = user?.id ?? "";
    return groups
      .map((g) => ({ ...g, rows: g.rows.filter((r) => r.lock.user_id === me) }))
      .filter((g) => g.rows.length > 0);
  }, [groups, mineOnly, user]);
  const totalLocks = locks?.length ?? 0;
  const visibleCount = visibleGroups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="h-full overflow-auto bg-helios-panel">
      <header className="flex items-center gap-3 border-b border-helios-line px-4 py-3 text-helios-dim">
        <span>
          Active checkouts — all vaults
          {!resolving && !error && (
            <span className="ml-2 font-mono-num text-xs">({mineOnly ? `${visibleCount} of ${totalLocks}` : totalLocks})</span>
          )}
        </span>
        <button
          type="button"
          aria-pressed={mineOnly}
          onClick={() => setMineOnly((v) => !v)}
          className={
            "ml-auto rounded-full border px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
            (mineOnly
              ? "border-asu-gold bg-asu-gold/20 text-asu-gold"
              : "border-helios-line text-helios-dim hover:border-asu-gold/60 hover:text-helios-text")
          }
        >
          Just mine
        </button>
      </header>
      {/* Surface a failed force-unlock — previously swallowed entirely. */}
      {forceUnlock.error && (
        <div className="border-b border-red-500/40 bg-red-500/10 px-4 py-1.5 text-xs text-red-200" role="alert">
          {forceUnlock.error.message}
        </div>
      )}
      {/* Surface a files/folders load failure — paths silently degraded to
          short ids before, with no hint that resolution was broken. */}
      {contextError && (
        <div className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-200" role="alert">
          Couldn't load file paths: {contextError.message}
        </div>
      )}
      <div className="p-2">
        {resolving ? (
          <div className="p-4 text-sm text-helios-dim">Loading…</div>
        ) : error ? (
          <div className="p-4 text-sm text-[#EF5350]">{error.message}</div>
        ) : visibleCount === 0 ? (
          <div className="p-4 text-sm text-helios-dim">
            {mineOnly && totalLocks > 0
              ? "You have nothing checked out right now."
              : "Nothing checked out right now."}
          </div>
        ) : (
          visibleGroups.map((g) => (
            <section key={g.vaultId ?? "__other__"} className="mb-4">
              <h3 className="flex items-baseline gap-2 px-3 py-1.5 text-xs uppercase tracking-wider text-asu-gold">
                {g.vaultName}
                <span className="font-mono-num normal-case text-helios-dim">
                  {g.rows.length} checked out
                </span>
              </h3>
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
                  {g.rows.map(({ lock, file, path }) => {
                    const holderName = userById.get(lock.user_id);
                    return (
                      <tr key={lock.id} className="border-t border-helios-line">
                        <td className="px-3 py-2 text-helios-text">
                          {path ? (
                            <span title={path}>
                              {path}
                              {file?.deleted_at && (
                                <span className="ml-1.5 text-xs text-helios-dim">(in recycle bin)</span>
                              )}
                            </span>
                          ) : (
                            <span className="font-mono-num text-xs text-helios-dim" title={lock.file_id}>
                              {shortId(lock.file_id)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-helios-text" title={lock.user_id}>
                          {holderName ? (
                            holderName
                          ) : (
                            <span className="font-mono-num text-xs">{shortId(lock.user_id)}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-helios-dim" title={lock.acquired_at}>
                          {relativeTime(lock.acquired_at)}
                        </td>
                        {isAdmin && (
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => requestForceUnlock(lock.id)}
                              disabled={unlockingId === lock.id}
                              className="rounded bg-red-800 px-2 py-0.5 text-xs text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
                            >
                              {unlockingId === lock.id ? "Unlocking…" : "Force unlock"}
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))
        )}
      </div>
      {reasonFor && (
        <ForceUnlockReasonModal
          loading={unlockingId !== null}
          onSubmit={(reason) => { void submitForceUnlock(reason); }}
          onCancel={() => setReasonFor(null)}
        />
      )}
    </div>
  );
}

/**
 * In-app prompt for the force-unlock reason. window.prompt is a no-op in the
 * Tauri webview (returns null), so admin force-unlock was DEAD (C1-MISS). This
 * modal collects the reason in-app. Mirrors the modal a11y convention used by
 * RowActions' CheckInCommentModal / ConfirmDialog: role=dialog + aria-modal,
 * Escape-to-cancel via stopImmediatePropagation (so a stacked window Escape
 * handler underneath doesn't ALSO fire), focus-trap, and focus-restore on
 * unmount. The first field is focused on open. Submit is blocked on an empty
 * reason (the RPC requires a reason).
 */
function ForceUnlockReasonModal({
  loading,
  onSubmit,
  onCancel,
}: {
  loading: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const dialogRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    textareaRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        // stopImmediatePropagation (not just stopPropagation) so a sibling
        // window keydown listener (e.g. another modal underneath) doesn't ALSO
        // close on the same keypress.
        e.stopImmediatePropagation();
        onCancel();
        return;
      }
      if (e.key === "Tab") {
        // Focus-trap: cycle Tab/Shift+Tab within the dialog.
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
          'textarea, button, [href], input, select, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreTo?.focus?.();
    };
  }, [onCancel]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = reason.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Force unlock reason"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-80 space-y-3 rounded-lg border border-helios-line bg-helios-panel p-4 shadow-lg"
      >
        <h3 className="text-sm font-semibold text-helios-text">Reason for force unlock</h3>
        <p className="text-xs text-helios-dim">
          This releases another user's lock. The reason is recorded in the audit log.
        </p>
        <textarea
          ref={textareaRef}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Why are you forcing this unlock?"
          className="w-full resize-none rounded border border-helios-line bg-helios-base px-2 py-1 text-sm text-helios-text placeholder-helios-dim focus:outline-none focus:ring-1 focus:ring-asu-gold"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded px-3 py-1 text-xs text-helios-dim hover:bg-helios-line disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || reason.trim().length === 0}
            className="rounded bg-red-800 px-3 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          >
            Force unlock
          </button>
        </div>
      </form>
    </div>
  );
}
