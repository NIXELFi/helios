import { useEffect, useMemo, useRef, useState } from "react";
import { useLocks } from "../data/useLocks";
import { useForceUnlock } from "../data/useForceUnlock";
import { useIsAdmin } from "../data/useIsAdmin";
import { useActiveVault } from "../data/useActiveVault";
import { useAllFiles } from "../data/useAllFiles";
import { useFolders } from "../data/useFolders";
import { useVaultUsers } from "../data/useVaultUsers";
import { folderPath } from "../data/folder-paths";
import type { VaultUser } from "../data/types";

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

export function WhoHasWhatScreen() {
  const { activeVaultId, activeVault } = useActiveVault();
  const { data: locks, loading, error, refetch } = useLocks();
  const { data: files, loading: filesLoading, error: filesError } = useAllFiles(activeVaultId ?? undefined);
  const { data: folders, error: foldersError } = useFolders(activeVaultId ?? undefined);
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

  // H12: useLocks is cross-vault, but this screen claims "{vault} checkouts".
  // Once the active vault's files have finished LOADING, drop locks whose
  // file_id isn't among them — those belong to another vault. We key off
  // useAllFiles' `loading`, NOT (files===empty): while still loading we keep
  // every lock so the screen doesn't blank mid-load (preserves the 2026-05-25
  // fix); once loaded — even to a genuinely empty vault — we filter, so an
  // empty vault no longer shows every cross-vault lock under its header.
  const visibleLocks = useMemo(() => {
    if (!locks) return locks;
    if (filesLoading || files === null) return locks;
    return locks.filter((l) => fileById.has(l.file_id));
  }, [locks, files, filesLoading, fileById]);

  function requestForceUnlock(lockId: string) {
    setReasonFor(lockId);
  }

  async function submitForceUnlock(reason: string) {
    const lockId = reasonFor;
    setReasonFor(null);
    if (!lockId || reason.trim() === "") return;
    setUnlockingId(lockId);
    const ok = await forceUnlock.run(lockId, reason.trim());
    setUnlockingId(null);
    if (ok) refetch();
  }

  // Surface a degraded path-resolution context (files/folders failed to load)
  // so paths don't silently fall back to short ids with no explanation.
  const contextError = filesError ?? foldersError;

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
      {/* Surface a files/folders load failure — paths silently degraded to
          short ids before, with no hint that resolution was broken. */}
      {contextError && (
        <div className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-200" role="alert">
          Couldn't load file paths: {contextError.message}
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
                          onClick={() => requestForceUnlock(l.id)}
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
