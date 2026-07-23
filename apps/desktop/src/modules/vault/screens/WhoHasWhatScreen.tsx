import { useEffect, useMemo, useRef, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import { useUser } from "@helios/auth";
import { useLocks } from "../data/useLocks";
import { useForceUnlock } from "../data/useForceUnlock";
import { useCheckIn } from "../data/useCheckIn";
import { useIsAdmin } from "../data/useIsAdmin";
import { useIsVaultAdmin } from "../data/useVaultRole";
import { useActiveVault } from "../data/useActiveVault";
import { useVaultFolder } from "../data/useVaultFolder";
import { useFilesByIds, type LockFileRow } from "../data/useFilesByIds";
import { useActiveCheckouts } from "../data/useActiveCheckouts";
import { useCrossVaultFolders } from "../data/useCrossVaultFolders";
import { useVaultUsers } from "../data/useVaultUsers";
import { usePeople } from "../../org/data/useOrgData";
import { folderPath, localDestPathStrict, vaultRelPathFor } from "../data/folder-paths";
import { ledgerRecord } from "../data/sync-ledger";
import { setReadonly, flipSwReadonly } from "../data/fs-readonly";
import type { Lock, VaultUser } from "../data/types";

/** Canonical lock-holder label: prefer the human display name, then the email,
 *  else null (caller falls back to a short id). Shared so every screen that
 *  names a lock holder (WhoHasWhat, HistoryScreen) reads the same — closes the
 *  BrowseScreen email-first vs WhoHasWhat name-first inconsistency (HOLDER-LABEL).
 *  Standardized on display_name-first. */
export function holderLabel(u: Pick<VaultUser, "display_name" | "email">): string | null {
  return u.display_name ?? u.email ?? null;
}

/** Resolve a lock-holder's display name from an ordered list of id→name maps.
 *  Sources are checked left-to-right; the first hit wins (active-vault list
 *  should come first so any per-vault override takes precedence over the global
 *  people list). Returns a friendly "Unknown member" placeholder — NEVER a raw
 *  hex id — when the user is absent from every source. This closes the
 *  cross-vault holder bug (M19): the old code only looked in the active vault's
 *  user list, so holders from other vaults resolved to a raw hex fragment. */
export function resolveHolderName(
  userId: string,
  sources: ReadonlyArray<ReadonlyMap<string, string>>,
): string {
  if (!userId) return "Unknown member";
  for (const map of sources) {
    const name = map.get(userId);
    if (name) return name;
  }
  return "Unknown member";
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
  /** The file is another user's unpublished draft — the name is private
   *  (files_read draft RLS); only the lock's existence/holder is visible. */
  nameHidden?: boolean;
  /** Checked out before its first check-in (published_at null). */
  isDraft?: boolean;
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
  // Preferred source: the pdm_list_active_checkouts definer RPC, which joins
  // locks→files→vaults server-side so other users' DRAFT checkouts resolve
  // (files_read draft privacy hides those rows from direct reads — the
  // client-side join below can't see them and used to dump every draft into
  // an "Other vaults" bucket). Falls back to the legacy join when the RPC
  // isn't deployed yet.
  const checkouts = useActiveCheckouts();
  const rpcMode = checkouts.supported === true;
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
  // Holder resolution. Resolve via the VAULT-SCOPED list for the active vault
  // (pdm_list_vault_roles) rather than the global pdm_admin_list_users RPC,
  // which is gated to GLOBAL admins only — a per-vault admin got no names. Both
  // raise for non-members; we ignore the error and fall back gracefully so a
  // viewer still sees the screen.
  const { data: users } = useVaultUsers(activeVaultId);
  // Cross-vault fallback: pm.list_people returns every org member with a
  // display_name/email. Also admin-gated; error is silently ignored — if both
  // sources miss a holder we show "Unknown member" rather than a raw hex id
  // (cross-vault holder name bug M19).
  const { data: people } = usePeople();
  const forceUnlock = useForceUnlock();
  // Force unlock authorization is per-vault: a global admin can unlock anywhere,
  // and an admin of the ACTIVE vault can unlock its rows. The server RPC
  // enforces the real rule regardless of what the button shows.
  const isAdmin = useIsAdmin();
  const isActiveVaultAdmin = useIsVaultAdmin(activeVaultId ?? null);
  // Which lock id has an in-flight force-unlock. A single shared
  // forceUnlock.loading would disable EVERY row's button; tracking the
  // targeted id keeps the other rows clickable.
  const [unlockingId, setUnlockingId] = useState<string | null>(null);
  // Lock id awaiting a force-unlock REASON in the in-app modal. window.prompt
  // is a no-op in the Tauri webview, so the reason is collected via an in-app
  // dialog instead (C1-MISS). null = modal closed.
  const [reasonFor, setReasonFor] = useState<string | null>(null);

  // --- Check-in (Cole's request) --------------------------------------------
  // Let the current user check in their OWN checkouts straight from this screen
  // — per row and in bulk — instead of hunting each file down in the Browse
  // tree. Check-in needs the local working copy (to hash + upload its bytes),
  // and the local vault folder is only resolvable for the ACTIVE vault, so these
  // actions are offered for active-vault rows only. pdm_check_in's skip-unchanged
  // path means a freshly-uploaded draft whose bytes still match version 1 is just
  // published + released (no duplicate version), while a locally-edited file
  // lands a new version — one code path covers both.
  const checkIn = useCheckIn();
  const activeVaultName = useMemo(
    () => vaults.find((v) => v.id === activeVaultId)?.name ?? null,
    [vaults, activeVaultId],
  );
  const { path: vaultRoot } = useVaultFolder(
    activeVaultName ? { vaultName: activeVaultName } : null,
  );
  // We can only check in when we know BOTH the active vault's local root and its
  // folder tree (to resolve each file's on-disk path).
  const canCheckInActive = vaultRoot != null && folders != null && activeVaultId != null;
  // file_id currently being checked in (per-row spinner); null = none.
  const [checkingInId, setCheckingInId] = useState<string | null>(null);
  const [checkingInAll, setCheckingInAll] = useState(false);
  const [checkinStatus, setCheckinStatus] = useState<string | null>(null);
  // Aborts the in-flight bulk check-in loop on unmount so it stops reading files
  // and calling check-in RPCs (and never setState's) after the user navigates
  // away — same guard convention as BulkActionBar's long-running loops.
  const checkinAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => checkinAbortRef.current?.abort(), []);

  const fileById = useMemo(() => {
    const m = new Map<string, LockFileRow>();
    for (const f of lockFiles ?? []) m.set(f.id, f);
    return m;
  }, [lockFiles]);

  // user-id → display name / email for holder resolution (display_name-first
  // via the shared holderLabel helper). Active-vault list is the primary source.
  const userById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users ?? []) {
      const label = holderLabel(u);
      if (label) m.set(u.user_id, label);
    }
    return m;
  }, [users]);

  // Cross-vault fallback: pm.list_people spans all vaults. Error is silently
  // ignored (admin-gated); empty map when unavailable causes graceful fallback
  // via resolveHolderName (M19 fix).
  const peopleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of people ?? []) {
      const label = p.display_name ?? p.email ?? null;
      if (label) m.set(p.user_id, label);
    }
    return m;
  }, [people]);

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
      // Without the RPC we can't distinguish a draft (name private) from a
      // vault we're not a member of — label the bucket honestly.
      out.push({ vaultId: null, vaultName: "Private drafts or other vaults", rows: unresolved });
    }
    return out;
  }, [locks, fileById, folders, vaultNameById, activeVaultId]);

  // RPC-mode groups: every row arrives pre-resolved with its vault name; a
  // null file_name means "another user's draft" (render a private-draft
  // placeholder, never an opaque hex id).
  const rpcGroups = useMemo<VaultGroup[]>(() => {
    if (!rpcMode || !checkouts.data) return [];
    const byVault = new Map<string, VaultGroup>();
    for (const r of checkouts.data) {
      const lock: Lock = {
        id: r.lock_id,
        file_id: r.file_id,
        user_id: r.user_id,
        acquired_at: r.acquired_at,
        released_at: null,
        force_released_by: null,
      } as Lock;
      const dir = r.file_name && folders ? folderPath(r.folder_id, folders) : "";
      const path = r.file_name ? (dir ? `${dir}/${r.file_name}` : r.file_name) : null;
      const row: LockRow = {
        lock,
        file: {
          id: r.file_id,
          vault_id: r.vault_id,
          folder_id: r.folder_id,
          name: r.file_name ?? "",
          deleted_at: r.deleted_at,
        },
        path,
        nameHidden: r.file_name === null,
        isDraft: r.is_draft,
      };
      const g = byVault.get(r.vault_id) ?? { vaultId: r.vault_id, vaultName: r.vault_name, rows: [] };
      g.rows.push(row);
      byVault.set(r.vault_id, g);
    }
    const out = [...byVault.values()];
    out.sort((a, b) => {
      if (a.vaultId === activeVaultId) return -1;
      if (b.vaultId === activeVaultId) return 1;
      return a.vaultName.localeCompare(b.vaultName);
    });
    return out;
  }, [rpcMode, checkouts.data, folders, activeVaultId]);

  function requestForceUnlock(lockId: string) {
    setReasonFor(lockId);
  }

  async function submitForceUnlock(reason: string) {
    const lockId = reasonFor;
    setReasonFor(null);
    if (!lockId || reason.trim() === "") return;
    setUnlockingId(lockId);
    // Pass the lock's file_id so the optimistic overlay can clear its pill.
    const fileId = rpcMode
      ? checkouts.data?.find((r) => r.lock_id === lockId)?.file_id ?? ""
      : locks?.find((l) => l.id === lockId)?.file_id ?? "";
    const ok = await forceUnlock.run(lockId, fileId, reason.trim());
    setUnlockingId(null);
    if (ok) {
      refetch();
      checkouts.refetch();
    }
  }

  // Surface a degraded path-resolution context (files/folders failed to load)
  // so paths don't silently fall back to short ids with no explanation. In
  // RPC mode only the folders fetch feeds path display.
  const contextError = rpcMode ? foldersError : (filesError ?? foldersError);
  // The list source: RPC groups when the server supports it, else the legacy
  // client-side join.
  const sourceGroups = rpcMode ? rpcGroups : groups;
  const listError = rpcMode ? checkouts.error : error;
  // Hold the loading state until the rows are fully resolved — rendering
  // locks before resolution is what produced the open-flash. While the RPC
  // support probe is in flight (supported === null) we also hold, so the
  // screen never flashes the legacy grouping before switching to RPC rows.
  // In legacy mode, `lockFiles === null` covers the one-commit gap between
  // the locks landing and useFilesByIds' effect flipping its loading flag.
  const resolving =
    checkouts.supported === null ||
    (rpcMode
      ? checkouts.data === null && !checkouts.error
      : loading ||
        (lockFileIds.length > 0 && !filesError && (filesLoading || lockFiles === null)));
  // Apply the "just mine" chip AFTER grouping so the group structure (and
  // vault ordering) stays stable while toggling.
  const visibleGroups = useMemo(() => {
    if (!mineOnly) return sourceGroups;
    const me = user?.id ?? "";
    return sourceGroups
      .map((g) => ({ ...g, rows: g.rows.filter((r) => r.lock.user_id === me) }))
      .filter((g) => g.rows.length > 0);
  }, [sourceGroups, mineOnly, user]);
  const totalLocks = rpcMode ? (checkouts.data?.length ?? 0) : (locks?.length ?? 0);
  const visibleCount = visibleGroups.reduce((n, g) => n + g.rows.length, 0);

  // The current user's own checkouts in the ACTIVE vault that we can resolve to a
  // named file — the set the "Check in all mine" button acts on. Computed off the
  // unfiltered source groups so the count is stable regardless of the "Just mine"
  // chip.
  const myCheckinableRows = useMemo<LockRow[]>(() => {
    if (!canCheckInActive) return [];
    const me = user?.id ?? "";
    const grp = sourceGroups.find((g) => g.vaultId === activeVaultId);
    if (!grp) return [];
    return grp.rows.filter(
      (r) =>
        r.lock.user_id === me &&
        r.file != null &&
        !r.nameHidden &&
        r.file.name !== "" &&
        !r.file.deleted_at, // a soft-deleted (recycle-bin) file can't be checked in
    );
  }, [canCheckInActive, sourceGroups, activeVaultId, user]);

  /** Check in ONE of the current user's checkouts from its local working copy.
   *  Re-reads the bytes from disk each call (so a locally-edited draft publishes
   *  the EDITED content; an unchanged one hits the RPC's skip-unchanged path).
   *  Returns the outcome + the real error so callers can surface/total it. */
  async function checkInOne(
    row: LockRow,
  ): Promise<{ status: "ok" | "no-local" | "fail"; error?: Error | null }> {
    const file = row.file;
    if (!file || !vaultRoot || folders == null) return { status: "fail" };
    // STRICT path resolution: if the folder snapshot can't resolve this file's
    // folder, the non-strict helper collapses the path to the VAULT ROOT — and
    // this function then reads an unrelated same-named root file's bytes and
    // publishes them as a new version. "no-local" is the honest degradation.
    const dest = localDestPathStrict(vaultRoot, file.folder_id, file.name, folders);
    if (!dest) return { status: "no-local" };
    let bytes: ArrayBuffer;
    try {
      const local = await readFile(dest);
      bytes = local.buffer.slice(
        local.byteOffset,
        local.byteOffset + local.byteLength,
      ) as ArrayBuffer;
    } catch {
      // No local copy at the expected path — nothing we can hash/upload.
      return { status: "no-local" };
    }
    const ver = await checkIn.run(file.id, bytes, "Checked in from Checkouts");
    // checkIn.error is stale within this closure (state lands next render), so read
    // the synchronously-updated ref the hook exposes for the actual reason.
    if (!ver) return { status: "fail", error: checkIn.errorRef.current };
    // Published + released now — re-protect the local copy read-only, matching
    // single-file / bulk check-in elsewhere so auto-sync doesn't read the
    // writable-but-unlocked copy as an unsaved edit and hold it back.
    await setReadonly(dest, true);
    flipSwReadonly(dest, true);
    if (activeVaultId) {
      void ledgerRecord(activeVaultId, vaultRelPathFor(file.folder_id, file.name, folders), ver.sha256);
    }
    return { status: "ok" };
  }

  async function checkInRow(row: LockRow) {
    // Single-flight: never run a per-row check-in while another (per-row or bulk)
    // is in progress — they share one useCheckIn instance and the spinner state.
    if (checkingInId !== null || checkingInAll) return;
    setCheckingInId(row.lock.file_id);
    setCheckinStatus(null);
    const r = await checkInOne(row);
    setCheckingInId(null);
    if (r.status === "ok") {
      refetch();
      checkouts.refetch();
    } else if (r.status === "no-local") {
      setCheckinStatus(`Couldn't find a local copy of "${row.file?.name ?? "file"}" to check in.`);
    } else {
      setCheckinStatus(r.error?.message ?? "Check-in failed.");
    }
  }

  async function checkInAllMine() {
    const rows = myCheckinableRows;
    if (rows.length === 0 || checkingInId !== null || checkingInAll) return;
    // Fresh abort scope; bail between iterations once the screen unmounts.
    checkinAbortRef.current?.abort();
    const ctrl = new AbortController();
    checkinAbortRef.current = ctrl;
    const signal = ctrl.signal;
    setCheckingInAll(true);
    setCheckinStatus(null);
    let ok = 0, noLocal = 0, fail = 0;
    let lastError: Error | null = null;
    for (const row of rows) {
      if (signal.aborted) return;
      const r = await checkInOne(row);
      if (signal.aborted) return;
      if (r.status === "ok") ok++;
      else if (r.status === "no-local") noLocal++;
      else { fail++; lastError = r.error ?? lastError; }
    }
    const parts = [`Checked in ${ok}/${rows.length}`];
    const detail: string[] = [];
    if (fail) detail.push(`${fail} failed`);
    if (noLocal) detail.push(`${noLocal} with no local copy`);
    if (detail.length) parts.push(`(${detail.join(", ")})`);
    if (fail && lastError) parts.push(`— ${lastError.message}`);
    setCheckinStatus(parts.join(" "));
    setCheckingInAll(false);
    refetch();
    checkouts.refetch();
  }

  return (
    <div className="h-full overflow-auto bg-helios-panel">
      <header className="flex items-center gap-3 border-b border-helios-line px-4 py-3 text-helios-dim">
        <span>
          Active checkouts — all vaults
          {!resolving && !listError && (
            <span className="ml-2 font-mono-num text-xs">({mineOnly ? `${visibleCount} of ${totalLocks}` : totalLocks})</span>
          )}
        </span>
        {myCheckinableRows.length > 0 && (
          <button
            type="button"
            onClick={() => { void checkInAllMine(); }}
            disabled={checkingInAll || checkingInId !== null}
            title={`Check in your ${myCheckinableRows.length} checked-out file${myCheckinableRows.length === 1 ? "" : "s"} in ${activeVaultName ?? "this vault"}`}
            className="rounded-full border border-[#66BB6A]/50 bg-[#66BB6A]/15 px-2.5 py-0.5 text-xs text-[#9CCC65] transition-colors hover:bg-[#66BB6A]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
          >
            {checkingInAll ? "Checking in…" : `Check in all mine (${myCheckinableRows.length})`}
          </button>
        )}
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
      {/* Check-in result / error — dismissible so it doesn't linger. */}
      {checkinStatus && (
        <div className="flex items-center gap-2 border-b border-helios-line bg-helios-base/60 px-4 py-1.5 text-xs text-helios-dim" role="status" aria-live="polite">
          <span className="truncate" title={checkinStatus}>{checkinStatus}</span>
          <button
            type="button"
            onClick={() => setCheckinStatus(null)}
            className="ml-auto shrink-0 text-helios-dim hover:text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="p-2">
        {resolving ? (
          <div className="p-4 text-sm text-helios-dim">Loading…</div>
        ) : listError ? (
          <div className="p-4 text-sm text-[#EF5350]">{listError.message}</div>
        ) : visibleCount === 0 ? (
          <div className="p-4 text-sm text-helios-dim">
            {mineOnly && totalLocks > 0
              ? "You have nothing checked out right now."
              : "Nothing checked out right now."}
          </div>
        ) : (
          visibleGroups.map((g) => {
            // Who may force-unlock THIS group's rows: a global admin anywhere,
            // or the active vault's admin for the active vault's group. Other
            // vaults' groups show no action unless the user is a global admin.
            const canForceUnlock = isAdmin || (g.vaultId !== null && g.vaultId === activeVaultId && isActiveVaultAdmin);
            // This group is the active vault and we have the local context needed
            // to check in — so the current user's own rows get a "Check in" action.
            const canCheckInGroup = canCheckInActive && g.vaultId === activeVaultId;
            const showActions = canForceUnlock || canCheckInGroup;
            const me = user?.id ?? "";
            return (
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
                    {showActions && <th className="px-3 py-2 font-normal">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map(({ lock, file, path, nameHidden, isDraft }) => {
                    const holderName = resolveHolderName(lock.user_id, [userById, peopleById]);
                    return (
                      <tr key={lock.id} className="border-t border-helios-line">
                        <td className="px-3 py-2 text-helios-text">
                          {path ? (
                            <span className="block max-w-[18rem] truncate xl:max-w-[30rem]" title={path}>
                              {path}
                              {isDraft && (
                                <span
                                  className="ml-1.5 rounded bg-asu-gold/15 px-1 text-[10px] uppercase tracking-wide text-asu-gold"
                                  title="Checked out before its first check-in — not yet visible to the team"
                                >
                                  draft
                                </span>
                              )}
                              {file?.deleted_at && (
                                <span className="ml-1.5 text-xs text-helios-dim">(in recycle bin)</span>
                              )}
                            </span>
                          ) : nameHidden ? (
                            <span
                              className="text-xs italic text-helios-dim"
                              title="An unpublished draft — the file name is visible only to its creator and vault admins"
                            >
                              Private draft
                            </span>
                          ) : (
                            <span className="font-mono-num text-xs text-helios-dim" title={lock.file_id}>
                              {shortId(lock.file_id)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-helios-text" title={lock.user_id}>
                          {holderName}
                        </td>
                        <td className="px-3 py-2 text-helios-dim" title={lock.acquired_at}>
                          {relativeTime(lock.acquired_at)}
                        </td>
                        {showActions && (
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              {canCheckInGroup && lock.user_id === me && file && !nameHidden && file.name !== "" && !file.deleted_at && (
                                <button
                                  type="button"
                                  onClick={() => { void checkInRow({ lock, file, path, nameHidden, isDraft }); }}
                                  // Disable EVERY row's button while any check-in is in
                                  // flight (single useCheckIn instance + shared spinner).
                                  disabled={checkingInId !== null || checkingInAll}
                                  title="Check this file in — publishes it and releases your lock"
                                  className="rounded bg-[#66BB6A] px-2 py-0.5 text-xs text-white hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
                                >
                                  {checkingInId === lock.file_id ? "Checking in…" : "Check in"}
                                </button>
                              )}
                              {canForceUnlock && (
                                <button
                                  type="button"
                                  onClick={() => requestForceUnlock(lock.id)}
                                  disabled={unlockingId === lock.id}
                                  className="rounded bg-red-800 px-2 py-0.5 text-xs text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
                                >
                                  {unlockingId === lock.id ? "Unlocking…" : "Force unlock"}
                                </button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
            );
          })
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
