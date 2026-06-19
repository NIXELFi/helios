import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";
import { useUser, useSupabaseClient } from "@helios/auth";
import { FILE_MANAGER } from "../../../lib/platform";
import { useActiveVault } from "../data/useActiveVault";
import { useFolders } from "../data/useFolders";
import { useFiles } from "../data/useFiles";
import { useLocks } from "../data/useLocks";
import { useIsAdmin } from "../data/useIsAdmin";
import { useMyRole } from "../data/useMyRole";
import { useCanEditVault, useIsVaultAdmin } from "../data/useVaultRole";
import { useCreateFolder } from "../data/useCreateFolder";
import { useDeleteFolder } from "../data/useDeleteFolder";
import { useDeleteFile } from "../data/useDeleteFile";
import { useVaultDropImport } from "../data/useVaultDropImport";
import { folderPath, isDescendantOf, nearestLiveAncestor, selectionAfterPartialDelete } from "../data/folder-paths";
import { matchLocal } from "../data/local-match";
import { revealInExplorer } from "../data/reveal";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { useCreateFile } from "../data/useCreateFile";
import { useVaultFolder } from "../data/useVaultFolder";
import { useDownloadMode } from "../data/useDownloadMode";
import { ManualDownloadAll } from "../components/ManualDownloadAll";
import { useBulkDownload } from "../data/useBulkDownload";
import { BulkDownloadModal } from "../components/BulkDownloadModal";
import { TreeContextMenu, type MenuAction } from "../components/TreeContextMenu";
import type { TreeContextTarget, TreeSelection } from "../components/FolderTree";
import { emptyTreeSelection } from "../components/FolderTree";
import { useLocalFolderScan } from "../data/useLocalFolderScan";
import { useAllFiles } from "../data/useAllFiles";
import { useDeletedFiles } from "../data/useDeletedFiles";
import { applyFileEvent, applyVersionEvent, type RowEvent } from "../data/apply-events";
import { useDeletedFolders } from "../data/useDeletedFolders";
import { useDeletedFileReaper } from "../data/useDeletedFileReaper";
import { ensureLocalFolderTree } from "../data/ensureLocalFolderTree";
import { useAutoSync } from "../data/useAutoSync";
import { useVaultRealtime } from "../data/useVaultRealtime";
import { useVaultCursor } from "../data/useVaultCursor";
import { useVaultUsers } from "../data/useVaultUsers";
import { findUnmatchedLocal } from "../data/find-unmatched";
import { friendlyPgError, type PgErrorContext } from "../data/pg-errors";
import { FolderTree } from "../components/FolderTree";
import { FileTable } from "../components/FileTable";
import { BulkActionBar } from "../components/BulkActionBar";
import { UnmatchedFilesBanner } from "../components/UnmatchedFilesBanner";
import { AutoAddBanner } from "../components/AutoAddBanner";
import { VaultWarningBanner } from "../components/VaultWarningBanner";
import { useAutoAddDrafts } from "../data/useAutoAddDrafts";
import { LocalDeleteBanner } from "../components/LocalDeleteBanner";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { VaultSearch } from "../components/VaultSearch";
import { useVaultProperties } from "../data/useVaultProperties";
import { SkeletonRows, SkeletonTree } from "../components/Skeleton";
import { RecentActivity } from "../components/RecentActivity";
import { useMoveFile } from "../data/useMoveFile";
import { toast } from "../data/toast";
import { fetchWhereUsed } from "../data/useReferences";
import { whereUsedWarning } from "../data/whereUsedWarning";
import { FileDetailPanel } from "./FileDetailPanel";
import { useWatchedFiles } from "../data/useWatchedFiles";
import type { FileId, FolderId, UserId, VaultFile, Version } from "../data/types";

// How often to fall back to a full local rescan if the filesystem watcher
// drops events. 30s is short enough to feel live, long enough to be cheap.
const LOCAL_RESCAN_INTERVAL_MS = 30_000;

// How often to probe the vault's cheap change-signature (useVaultCursor) as a
// safety net behind realtime. Each probe is a handful of empty head requests,
// not a full-list refetch, so 15s stays near-live without the egress cost — a
// full reconcile only runs when the signature actually moves.
const VAULT_POLL_MS = 15_000;

// Apply realtime payloads incrementally (patch the changed row into the list)
// instead of re-pulling the whole vault on every event. Makes a teammate's
// check-in/add/delete/rename appear in the next React commit instead of after a
// full refetch (noticeable at the vault root on big vaults). Any unusable
// payload falls back to a refetch (REFETCH sentinel), and the useVaultCursor
// count poll self-heals drift — flip to false for the pure-refetch behavior.
const VAULT_INCREMENTAL_APPLY = true;

export function BrowseScreen() {
  const user = useUser();
  const supabase = useSupabaseClient();
  // Global admin — used only for truly global affordances (e.g. "you can
  // create a vault" messaging). In-vault edit/admin checks are per-vault below.
  const isAdmin = useIsAdmin();

  const { activeVault: vault, activeVaultId: vaultId, vaults, loading: vaultsLoading } = useActiveVault();
  // Per-active-vault permissions, UNIONED with the global role. The per-vault
  // helper (pdm_can_edit_in) is authoritative when present; the global fallback
  // (admin/owner via pdm_is_admin, or a global editor via useMyRole) keeps edit
  // affordances working when that RPC isn't deployed yet (the server RLS
  // enforces the real rule regardless of what the client shows).
  const myRole = useMyRole();
  const canEdit =
    useCanEditVault(vaultId) || isAdmin || myRole === "editor" || myRole === "owner";
  // Per-vault admin, unioned with the global admin role — same shape as
  // `canEdit` above. Gates deleting a folder that still contains live files.
  const isVaultAdmin = useIsVaultAdmin(vaultId) || isAdmin;

  // Watch set — per-vault localStorage, used by the notification feed.
  const { isWatched, toggle: toggleWatch } = useWatchedFiles(vaultId ?? undefined);

  const { data: folders, loading: foldersLoading, error: foldersError, refetch: refetchFolders } = useFolders(vaultId ?? undefined);
  const [selectedFolder, setSelectedFolder] = useState<FolderId | null>(null);

  const { data: filesInFolder, loading: filesLoading, error: filesError, refetch: refetchFiles, patch: patchFiles } = useFiles(selectedFolder ?? undefined);
  const { data: locks, error: locksError, refetch: refetchLocks } = useLocks();
  const [selectedFile, setSelectedFile] = useState<FileId | null>(null);
  const [selected, setSelected] = useState<Set<FileId>>(new Set());

  // Reset folder/file selection on vault switch so we don't show a SDM27 folder
  // tree but a SDM26 file open in the side panel.
  useEffect(() => {
    setSelectedFolder(null);
    setSelectedFile(null);
    setSelected(new Set());
  }, [vaultId]);

  // Clear the checkbox multi-selection whenever the effective folder context
  // changes — selecting a different folder shows a different file list, so a
  // stale selection set (ids from the previous folder) is meaningless. Driving
  // this off the folder id rather than the tree's onSelect callback means it
  // fires only on a real folder change, never on file-leaf navigation within
  // the same folder.
  useEffect(() => {
    setSelected(new Set());
  }, [selectedFolder]);

  // Local vault folder scan — auto-rescan on window focus + 30s interval +
  // native filesystem watcher so the synced/modified state stays live without
  // the user touching a button. The folder is per-vault: SDM26 and SDM27 each
  // remember their own working directory.
  // Shared-root model: user picks ONE root in Settings, each vault syncs
  // into `<root>/<vault.name>/`. The hook computes the effective path for
  // the active vault from its name. We thread BOTH the root and the vault
  // name into useBulkDownload so a prompt-for-destination flow still nests
  // the files under the vault name correctly.
  const { root: heliosRoot, path: vaultFolderPath, setRoot: setHeliosRoot } =
    useVaultFolder({ vaultName: vault?.name ?? null });
  const { mode: downloadMode } = useDownloadMode(vaultId);
  const autoSyncEnabled = downloadMode === "auto";
  // useAutoSync (declared below) → setSyncBusy → useLocalFolderScan paused.
  // While a sync pass is writing files we suppress automatic rescans so the
  // file table doesn't flicker between modified/synced as bytes land; the
  // explicit rescan from onComplete catches the final state.
  const [syncBusy, setSyncBusy] = useState(false);
  const { files: localFiles, openInSw, refetch: rescan } = useLocalFolderScan(vaultFolderPath, {
    intervalMs: LOCAL_RESCAN_INTERVAL_MS,
    rescanOnFocus: true,
    watchFs: true,
    paused: syncBusy,
  });

  // Use vault-wide files for the auto-sync pass (so it covers folders the user
  // hasn't opened yet) and for unmatched-local detection.
  const { data: allFiles, error: allFilesError, refetch: refetchAllFiles, patch: patchAllFiles } = useAllFiles(vaultId ?? undefined);
  // Property map for search (lazy, loads once per vault). When null (loading)
  // VaultSearch falls back to filename-only matching — no errors.
  const vaultPropertiesMap = useVaultProperties(vaultId ?? undefined, allFiles);
  // Soft-deleted files (the recycle bin). Threaded into the realtime/poll
  // refetch below so a delete by another member lands here promptly, and fed to
  // the reaper that removes their local working copies on this machine.
  const { data: deletedFiles, refetch: refetchDeleted, patch: patchDeleted } = useDeletedFiles(vaultId ?? undefined);
  // Soft-deleted folders — fed to the reaper so it can clean up their local
  // directories, and also re-fetched wherever refetchDeleted is called so
  // folder deletions propagate to this machine promptly.
  const { data: deletedFolders, refetch: refetchDeletedFolders } = useDeletedFolders(vaultId ?? undefined);
  // Propagate deletes to disk: remove the local copy of any soft-deleted file
  // and attempt to remove the local directory of any soft-deleted folder
  // (non-recursive — a dir still containing untracked files fails safely).
  // Only in auto-sync mode — in manual mode the user owns their local files and
  // we never delete them out from under them.
  useDeletedFileReaper({
    enabled: autoSyncEnabled,
    deletedFiles,
    localFiles,
    folders: folders ?? [],
    deletedFolders,
    vaultRoot: vaultFolderPath,
    vaultId: vaultId ?? null,
    onReaped: rescan,
  });
  // Materialize the vault folder scaffolding locally in BOTH download modes —
  // empty folders included — so the local tree always mirrors the vault
  // (spec 2a). Auto mode also runs this per sync pass; this effect covers
  // manual mode and the time before the first pass.
  useEffect(() => {
    if (!vaultFolderPath || !folders || folders.length === 0) return;
    // Vault-switch race guard: vaultFolderPath updates the instant the active
    // vault changes (it's derived from the vault name), but `folders` keeps
    // the PREVIOUS vault's rows until its refetch lands — materializing in
    // that window builds vault A's tree inside vault B's local dir. Only
    // proceed once every folder row actually belongs to the active vault.
    if (!vaultId || folders.some((f) => f.vault_id !== vaultId)) return;
    void ensureLocalFolderTree(folders, vaultFolderPath);
  }, [folders, vaultFolderPath, vaultId]);
  // Lock-holder names: map each user id → email (fall back to display name) so
  // the FileTable can render "Locked by <person>" instead of "Locked by other".
  // Resolve via the VAULT-SCOPED list (pdm_list_vault_roles): the global RPC
  // (pdm_admin_list_users) is gated to GLOBAL admins only, so a per-vault admin
  // got an empty map and saw "Locked by other" for their own teammates. Both
  // raise for non-members; we ignore the error and fall back to the generic
  // label, so a viewer still sees the screen.
  const { data: vaultUsers } = useVaultUsers(vaultId);
  const holderEmailById = useMemo(() => {
    const m = new Map<UserId, string>();
    for (const u of vaultUsers ?? []) {
      const label = u.email ?? u.display_name;
      if (label) m.set(u.user_id, label);
    }
    return m;
  }, [vaultUsers]);
  // Memoized: findUnmatchedLocal allocates a fresh array each call, so without
  // this every render handed a new identity to <UnmatchedFilesBanner>.
  const unmatched = useMemo(
    () =>
      allFiles && localFiles && folders
        ? findUnmatchedLocal(allFiles, localFiles, folders)
        : [],
    [allFiles, localFiles, folders],
  );

  // SW-PDM-style auto-vaulting of new local files (auto mode only): each
  // becomes a private draft checked out to this user; others see it only
  // after the first check-in.
  const autoAdd = useAutoAddDrafts({
    vaultId: vaultId ?? undefined,
    enabled: autoSyncEnabled,
    unmatched,
    onAdded: () => {
      refetchAllFiles();
      refetchFolders();
      refetchFiles();
      refetchLocks();
      rescan();
    },
  });

  // When the user has the vault root selected (selectedFolder === null) we
  // derive the file list from the vault-wide query instead of asking the
  // server for "files where folder_id IS NULL" — keeps the wiring simple and
  // avoids a second query. allFiles paginates, so this is correct at scale.
  const rootFiles = useMemo(
    () => (allFiles ?? []).filter((f) => f.folder_id === null),
    [allFiles],
  );
  // Instant folder navigation (NAV-FLASH): while the per-folder query is in
  // flight, derive the folder's files from the vault-wide list already in
  // memory instead of flashing a skeleton on every click. The per-folder
  // result swaps in silently when it lands (same embed, same content). The
  // skeleton now only appears on the FIRST load of a vault, before allFiles
  // exists.
  const folderFilesFallback = useMemo(
    () => (selectedFolder === null ? null : (allFiles ?? []).filter((f) => f.folder_id === selectedFolder)),
    [allFiles, selectedFolder],
  );
  const filesUnsorted =
    selectedFolder === null
      ? rootFiles
      : (filesInFolder ?? (allFiles === null ? null : folderFilesFallback));
  // One canonical sort regardless of source: useFiles orders by name but
  // useAllFiles orders by id, so without this the rows visibly reshuffled the
  // moment the per-folder query replaced the in-memory fallback.
  const files = useMemo(
    () =>
      filesUnsorted === null
        ? null
        : [...filesUnsorted].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    [filesUnsorted],
  );

  // The "Download all" button operates on every file underneath the current
  // view recursively — i.e. picking Brakes downloads every file in Brakes
  // and every subfolder of Brakes, not just the 4 SLDPRTs directly inside.
  // At the vault root this expands to every file in the whole vault.
  const filesToDownloadAll = useMemo(() => {
    const all = allFiles ?? [];
    if (selectedFolder === null) return all;
    const wanted = new Set<string>([selectedFolder]);
    const stack = [selectedFolder];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const f of (folders ?? [])) {
        if (f.parent_id === id && !wanted.has(f.id)) {
          wanted.add(f.id);
          stack.push(f.id);
        }
      }
    }
    return all.filter((f) => f.folder_id && wanted.has(f.folder_id));
  }, [selectedFolder, allFiles, folders]);

  // Latest version per file, read from the `latest` row EMBEDDED by the file
  // queries (useFiles / useAllFiles) — no separate per-vault version fetch.
  // Built from BOTH the current folder (fast, scoped) and the vault-wide list
  // (covers folders the user hasn't opened yet, for auto-sync / bulk download).
  // The folder query lands first, so on a big vault (SDM25 ≈ 8.6k files) the
  // current folder's Download buttons appear immediately instead of waiting for
  // the whole-vault list — the perf fix that motivated v3.8.2.
  const versionsByFileId = useMemo(() => {
    const m = new Map<FileId, Version[]>();
    const add = (list: VaultFile[] | null | undefined) => {
      for (const f of list ?? []) {
        if (f.latest) m.set(f.id, [{ ...f.latest, properties: null }]);
      }
    };
    add(allFiles);
    add(filesInFolder);
    return m;
  }, [allFiles, filesInFolder]);

  // File-area error/loading state (H1). The file list itself comes from the
  // vault-wide query at root (allFilesError) or the per-folder query inside a
  // folder (filesError); either blocks the table. The locks and latest-version
  // queries feed the per-row status pills — a failure there doesn't blank the
  // list but must not be swallowed, so we fold all into one banner with a
  // single retry rather than leaving any on a permanent spinner.
  const fileListError = selectedFolder === null ? allFilesError : filesError;
  const fileAreaError = fileListError ?? locksError;
  const fileAreaErrorCtx: PgErrorContext = fileListError ? "file" : "lock";
  // Loading is now "we have NOTHING to show" — with the in-memory fallback
  // above, that's only the first load of a vault (allFiles not yet in), never
  // ordinary folder-to-folder navigation.
  const fileListLoading = files === null || (selectedFolder === null && allFiles === null);
  const retryFileArea = useCallback(() => {
    refetchFiles();
    refetchAllFiles();
    refetchLocks();
  }, [refetchFiles, refetchAllFiles, refetchLocks]);

  // Realtime: when anyone checks in / locks / unlocks / adds a file in this
  // vault, update the affected slice. With VAULT_INCREMENTAL_APPLY we patch the
  // changed row straight from the payload (instant, no round trip); otherwise —
  // or for any payload we can't apply safely (the patch updater returns REFETCH
  // and the hook refetches that list) — we fall back to a full refetch. The
  // auto-sync hook below picks up the new version state and downloads the bytes.
  const onVersion = useCallback((payload?: unknown) => {
    if (!VAULT_INCREMENTAL_APPLY || !payload) { refetchAllFiles(); refetchFiles(); return; }
    const ev = payload as RowEvent<Version>;
    patchAllFiles((rows) => applyVersionEvent(rows, ev));
    patchFiles((rows) => applyVersionEvent(rows, ev));
  }, [refetchAllFiles, refetchFiles, patchAllFiles, patchFiles]);
  const onLock = useCallback(() => { refetchLocks(); }, [refetchLocks]);
  const onFile = useCallback((payload?: unknown) => {
    if (!VAULT_INCREMENTAL_APPLY || !payload || !vaultId) {
      refetchAllFiles(); refetchFiles(); refetchDeleted(); refetchDeletedFolders(); return;
    }
    const ev = payload as RowEvent<VaultFile>;
    // Each list's `belongs` predicate mirrors its query WHERE clause; a single
    // soft-delete UPDATE thus drops the row from `allFiles` AND adds it to
    // `deletedFiles` (and vice-versa on restore).
    patchAllFiles((rows) => applyFileEvent(rows, ev, { vaultId, belongs: (f) => f.deleted_at == null }));
    if (selectedFolder !== null) {
      patchFiles((rows) => applyFileEvent(rows, ev, { vaultId, belongs: (f) => f.folder_id === selectedFolder && f.deleted_at == null }));
    }
    patchDeleted((rows) => applyFileEvent(rows, ev, { vaultId, belongs: (f) => f.deleted_at != null }));
    // A folder-cascade delete soft-deletes child files (fires file events,
    // handled above) but the deleted FOLDERS list is refreshed by onFolder.
  }, [vaultId, selectedFolder, refetchAllFiles, refetchFiles, refetchDeleted, refetchDeletedFolders, patchAllFiles, patchFiles, patchDeleted]);
  // Folder create/rename/move/delete by anyone. The folder set is small, so a
  // refetch feels instant — no incremental apply needed. Without this, folder
  // changes weren't realtime at all (folders weren't subscribed), and a rename
  // never propagated (the cursor count can't see it) until reload.
  const onFolder = useCallback(() => { refetchFolders(); refetchDeletedFolders(); }, [refetchFolders, refetchDeletedFolders]);
  useVaultRealtime(vaultId ?? undefined, { onVersion, onLock, onFile, onFolder });

  // Full reconcile of the vault metadata — the heavy path that re-pulls the
  // file catalog, locks and recycle-bin lists. Triggered by realtime (the fast
  // path) and, as a safety net, by useVaultCursor below.
  const reconcile = useCallback(() => {
    refetchAllFiles();
    refetchFiles();
    refetchFolders();
    refetchLocks();
    refetchDeleted();
    refetchDeletedFolders();
  }, [refetchAllFiles, refetchFiles, refetchFolders, refetchLocks, refetchDeleted, refetchDeletedFolders]);
  // Periodic safety net behind realtime, but WITHOUT a per-cycle full re-pull.
  // If realtime's channel drops, the app was backgrounded, or an event is
  // missed, the old code re-fetched the entire catalog (~MBs) every 15s to find
  // out — usually that nothing had changed. useVaultCursor instead probes a
  // cheap count signature each cycle and only runs `reconcile` when something
  // actually changed, so an idle vault costs a few empty head requests instead
  // of megabytes. Realtime still delivers the live, instant updates.
  useVaultCursor(vaultId ?? undefined, { intervalMs: VAULT_POLL_MS, onChange: reconcile });

  // Background auto-sync lives inside <VaultSyncSection> so its rapid status
  // updates (one per file start + one per file end) re-render only that
  // subtree, never BrowseScreen / FolderTree / FileTable. Busy state and
  // completion are forwarded back up via callbacks for the rescan-pause and
  // refetch wiring.
  const onAutoSyncComplete = useCallback(() => { rescan(); }, [rescan]);
  const onAutoSyncBusy = useCallback((b: boolean) => setSyncBusy(b), []);

  // Multi-select in the tree (shift / cmd click + drag marquee) + right-click
  // context menu. The bulk-download hook is shared with ManualDownloadAll's
  // button so the progress UI is identical regardless of trigger.
  const [treeSelection, setTreeSelection] = useState<TreeSelection>(emptyTreeSelection());
  useEffect(() => { setTreeSelection(emptyTreeSelection()); }, [vaultId]);
  // Escape clears the tree selection from anywhere in the Vault module — but
  // NOT when a modal/dialog is open. Otherwise pressing Escape to dismiss the
  // check-in comment box, a confirm dialog, or the new-folder prompt would also
  // wipe the tree multi-selection underneath (the modals live on `window` too,
  // and not all of them stopImmediatePropagation). Guarding on an open
  // [role="dialog"] makes this robust regardless of each modal's Esc handling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      setTreeSelection(emptyTreeSelection());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Flatten tree selection to a concrete file list — folders contribute
  // every descendant file recursively, de-duped with directly-selected files.
  const selectedFiles = useMemo(() => {
    const all = allFiles ?? [];
    if (treeSelection.files.size === 0 && treeSelection.folders.size === 0) return [];
    const out = new Map<FileId, VaultFile>();
    for (const fid of treeSelection.files) {
      const f = all.find((x) => x.id === fid);
      if (f) out.set(fid, f);
    }
    if (treeSelection.folders.size > 0) {
      // Recursive descent — files under folder X plus every descendant folder.
      const wanted = new Set<string>();
      const stack = Array.from(treeSelection.folders);
      while (stack.length > 0) {
        const id = stack.pop()!;
        wanted.add(id);
        for (const f of (folders ?? [])) if (f.parent_id === id) stack.push(f.id);
      }
      for (const f of all) {
        if (f.folder_id && wanted.has(f.folder_id)) out.set(f.id, f);
      }
    }
    return Array.from(out.values());
  }, [treeSelection, allFiles, folders]);

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: TreeContextTarget } | null>(null);
  const bulk = useBulkDownload({
    heliosRoot,
    vaultName: vault?.name ?? null,
    vaultId: vaultId ?? null,
    folders: folders ?? [],
    versionsByFileId,
    onPickedRoot: setHeliosRoot,
    onDone: () => { refetchFiles(); rescan(); },
  });
  function handleTreeContextMenu(target: TreeContextTarget, x: number, y: number) {
    setCtxMenu({ x, y, target });
  }

  function toggleOne(id: FileId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (prev.size === (files?.length ?? 0)) return new Set();
      return new Set((files ?? []).map((f) => f.id));
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  const createFolder = useCreateFolder();
  const createFile = useCreateFile();
  const deleteFolder = useDeleteFolder();
  const deleteFile = useDeleteFile();

  // Right-click "New folder…" parents the new folder at the clicked folder
  // rather than the navigation selection. Set when opening the prompt from the
  // folder context menu; reset to null whenever the prompt closes so a later
  // toolbar "+ Folder" parents at `selectedFolder` as before.
  const [promptParent, setPromptParent] = useState<FolderId | null>(null);

  // Generic confirm dialog for destructive context-menu actions (delete folder
  // / delete files). Held as a render-prop bundle so one <ConfirmDialog> serves
  // every call site. `error` surfaces an RPC failure message inline afterward.
  const [confirm, setConfirm] = useState<
    | { title: string; body: string; confirmLabel: string; onConfirm: () => void | Promise<void> }
    | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Tauri's webview doesn't render window.prompt(), so we use an in-app modal.
  const [prompt, setPrompt] = useState<{ kind: "folder" | "file" } | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [promptError, setPromptError] = useState<string | null>(null);

  // Reset the right-click "New folder…" parent override whenever the prompt
  // closes, so a subsequent toolbar "+ Folder" parents at the navigation
  // selection rather than a stale clicked-folder id.
  useEffect(() => {
    if (!prompt) setPromptParent(null);
  }, [prompt]);

  async function handlePromptSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = promptValue.trim();
    if (!name || !vaultId || !prompt) return;
    setPromptError(null);
    // Reject path separators / traversal / control chars in the raw name. The
    // DB stores the name verbatim and ensureFolderHierarchy splits folder paths
    // on "/", so "a/b" or ".." would inject phantom folders or escape the
    // intended location (sanitizePathSegment guards DISK paths, not the stored
    // name). SW PDM rejects these outright too.
    if (/[\\/]/.test(name) || name === "." || name === ".." || /[\x00-\x1f]/.test(name)) {
      setPromptError('Names can’t contain "/" or "\\", be "." or "..", or include control characters.');
      return;
    }
    // Friendly duplicate check BEFORE the RPC: the server's unique constraint
    // still backstops races, but "a folder named X already exists here" beats
    // a raw 23505 message (SW PDM tells you immediately).
    const lower = name.toLowerCase();
    const parentForDup = prompt.kind === "folder" ? (promptParent ?? selectedFolder) : selectedFolder;
    const dup =
      prompt.kind === "folder"
        ? (folders ?? []).some((f) => f.parent_id === parentForDup && f.name.toLowerCase() === lower)
        : (allFiles ?? []).some((f) => f.folder_id === parentForDup && f.name.toLowerCase() === lower);
    if (dup) {
      setPromptError(`A ${prompt.kind === "folder" ? "folder" : "file"} named "${name}" already exists here.`);
      return;
    }
    if (prompt.kind === "folder") {
      // A right-click "New folder…" sets promptParent to the clicked folder;
      // the toolbar button leaves it null → parent at the navigation selection.
      const parent = promptParent ?? selectedFolder;
      const r = await createFolder.run(vaultId, name, parent);
      if (r) {
        refetchFolders();
        setPrompt(null);
        setPromptValue("");
        toast(`Created folder ${name}`);
      } else if (createFolder.error) {
        setPromptError(createFolder.error.message);
      }
    } else {
      const r = await createFile.run(vaultId, selectedFolder, name);
      if (r) {
        refetchFiles();
        setPrompt(null);
        setPromptValue("");
        toast(`Created ${name}`);
      } else if (createFile.error) {
        setPromptError(createFile.error.message);
      }
    }
  }

  function openPrompt(kind: "folder" | "file") {
    setPromptValue("");
    setPromptError(null);
    setPrompt({ kind });
  }

  function handleActionComplete() {
    refetchFiles();
    refetchLocks();
    refetchAllFiles();
    rescan();
  }

  // Drag-and-drop import (T13). Active only for editors with an active vault.
  // The hook registers the OS drag-drop listener, exposes the hover-highlight
  // target for the tree, runs the sequential import, and reports per-item
  // results for the strip below. On batch completion it refreshes everything
  // (folders may have been created; files added as locked drafts) + rescans.
  // Root element of this screen — the drop-import listeners attach HERE, not
  // on window, so they go inert when the Shell hides the Vault module.
  const browseRootRef = useRef<HTMLDivElement | null>(null);
  const dropImport = useVaultDropImport({
    enabled: canEdit && !!vaultId,
    containerRef: browseRootRef,
    vaultId: vaultId ?? null,
    folders: folders ?? [],
    selectedFolder,
    vaultRoot: vaultFolderPath ?? null,
    onComplete: () => {
      refetchFolders();
      refetchAllFiles();
      refetchFiles();
      refetchLocks();
      rescan();
    },
  });

  // Human name of the live drop target, for the full-pane drag overlay.
  const dropTargetName = useMemo(() => {
    const rootName = vault?.name ?? "vault root";
    const id = dropImport.hoverFolderId ?? (selectedFolder || "");
    if (id === "") return rootName;
    return (folders ?? []).find((f) => f.id === id)?.name ?? rootName;
  }, [dropImport.hoverFolderId, selectedFolder, folders, vault]);

  // Search / recent-activity pick: navigate to the file's folder + select it.
  const jumpToFile = useCallback((fileId: FileId, folderId: FolderId | null) => {
    setSelectedFolder(folderId);
    setSelectedFile(fileId);
  }, []);

  // Tree drag-to-move (vault admins — the files UPDATE policy is admin-only).
  const moveFile = useMoveFile();
  const handleMoveFile = useCallback(
    async (fileId: string, targetFolderId: FolderId | null) => {
      const file = (allFiles ?? []).find((f) => f.id === fileId);
      if (!file || !vaultId) return;
      const ok = await moveFile.run(file, targetFolderId, {
        vaultRoot: vaultFolderPath ?? null,
        folders: folders ?? [],
        vaultId,
      });
      if (ok) {
        const destName =
          targetFolderId === null
            ? (vault?.name ?? "vault root")
            : ((folders ?? []).find((f) => f.id === targetFolderId)?.name ?? "folder");
        toast(`Moved ${file.name} to ${destName}`);
        refetchAllFiles();
        refetchFiles();
        rescan();
      } else if (moveFile.error) {
        toast(moveFile.error.message, "error");
      }
    },
    [allFiles, vaultId, moveFile, vaultFolderPath, folders, vault, refetchAllFiles, refetchFiles, rescan],
  );

  // Subfolders of the current view, shown as navigable rows in the file table
  // (file-manager convention) — a folder of folders is not a dead end.
  const childFolders = useMemo(
    () => (folders ?? []).filter((f) => f.parent_id === selectedFolder),
    [folders, selectedFolder],
  );
  // Recursive file count per folder for the subfolder rows' "Folder · N files".
  const fileCountByFolder = useMemo(() => {
    const direct = new Map<string, number>();
    for (const f of allFiles ?? []) {
      if (f.folder_id) direct.set(f.folder_id, (direct.get(f.folder_id) ?? 0) + 1);
    }
    const byParent = new Map<string | null, string[]>();
    for (const f of folders ?? []) {
      const arr = byParent.get(f.parent_id) ?? [];
      arr.push(f.id);
      byParent.set(f.parent_id, arr);
    }
    const total = new Map<string, number>();
    function count(id: string): number {
      const cached = total.get(id);
      if (cached !== undefined) return cached;
      let n = direct.get(id) ?? 0;
      for (const child of byParent.get(id) ?? []) n += count(child);
      total.set(id, n);
      return n;
    }
    for (const f of folders ?? []) count(f.id);
    return total;
  }, [allFiles, folders]);

  // First-run onboarding: a brand-new vault (no folders, no files) gets a
  // 3-step walkthrough instead of a bare empty table.
  const vaultIsEmpty =
    folders !== null && (folders?.length ?? 0) === 0 &&
    allFiles !== null && (allFiles?.length ?? 0) === 0;

  // No active vault — either the user has no vaults at all, or vaults are
  // still loading. Vault creation now lives in the NavRail switcher, so
  // empty-state copy points there.
  if (!vaultsLoading && !vaultId) {
    return (
      <div className="flex h-full items-center justify-center bg-helios-base">
        <p className="text-sm text-helios-dim">
          {vaults.length === 0
            ? (isAdmin
                ? "No vaults yet. Use the vault switcher in the top-left to create one."
                : "You don't have access to any vault yet — contact an admin.")
            : "Choose a vault from the switcher in the top-left."}
        </p>
      </div>
    );
  }

  return (
    <div ref={browseRootRef} className="flex h-full flex-col">
      {/* SW PDM parity: in auto mode, new local files vault themselves as
          private checked-out drafts — no "add to vault" click. Manual mode
          keeps the explicit banner. */}
      {autoSyncEnabled ? (
        <AutoAddBanner status={autoAdd} />
      ) : (
        <UnmatchedFilesBanner
          vaultId={vaultId ?? undefined}
          unmatched={unmatched}
          onDone={() => {
            refetchAllFiles();
            refetchFolders();
            refetchFiles();
            refetchLocks();
            rescan();
          }}
        />
      )}
      <LocalDeleteBanner />
      <VaultWarningBanner />
      <div className="flex min-h-0 flex-1">
      <div className="flex w-56 shrink-0 flex-col border-r border-helios-line bg-helios-base xl:w-64">
        <header className="flex items-center justify-between border-b border-helios-line px-3 py-2">
          <span className="text-xs uppercase tracking-wider text-helios-dim">
            {vault?.name ?? "(no vault)"}
          </span>
          {canEdit && vaultId && (
            <button
              onClick={() => openPrompt("folder")}
              className="rounded px-1.5 py-0.5 text-xs text-helios-dim hover:bg-helios-line hover:text-helios-text"
              title="New folder"
            >
              + Folder
            </button>
          )}
        </header>
        <div className="flex-1 overflow-auto">
          {/* Three distinct states: error (with retry) → loading → loaded.
              useFolders nulls `data` on error, so the error branch must come
              first or a failed query would sit on the loading placeholder
              forever (H1). */}
          {foldersError ? (
            <InlineError
              message={friendlyPgError(foldersError, "folder").message}
              fallback="Couldn't load folders."
              onRetry={refetchFolders}
            />
          ) : folders ? (
            <FolderTree
              folders={folders}
              selected={selectedFolder}
              onSelect={(id) => setSelectedFolder(id)}
              files={allFiles ?? []}
              selectedFile={selectedFile}
              onSelectFile={setSelectedFile}
              locks={locks ?? []}
              currentUserId={user?.id ?? ""}
              treeSelection={treeSelection}
              onTreeSelectionChange={setTreeSelection}
              onContextMenu={handleTreeContextMenu}
              dropHoverId={dropImport.hoverFolderId}
              holderLabelById={holderEmailById}
              onMoveFile={isVaultAdmin ? handleMoveFile : undefined}
            />
          ) : foldersLoading ? (
            <SkeletonTree />
          ) : (
            <div className="p-3 text-sm text-helios-dim">No folders yet.</div>
          )}
        </div>
        <RecentActivity
          allFiles={allFiles ?? []}
          holderEmailById={holderEmailById}
          onPick={jumpToFile}
        />
        {/* Lock-dot legend — the tree's blue/red dots are otherwise learned by
            accident. One quiet line makes them self-explaining. */}
        <div className="flex shrink-0 items-center gap-3 border-t border-helios-line px-3 py-1.5 text-[10px] text-helios-dim">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-sky-400" /> yours
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-[#EF5350]" /> checked out
          </span>
          {isVaultAdmin && <span className="ml-auto italic">drag files to move</span>}
        </div>
      </div>
      {/* min-w-0 lets this flex child SHRINK below its content width — without
          it a narrow window clipped the toolbar and pushed the detail panel
          off-screen instead of truncating/wrapping (SQUEEZE). */}
      <div className="min-w-0 flex-1 overflow-auto">
        {/* selectedFolder === null means "vault root view", not "nothing
            selected" — files at the vault root were previously unreachable
            because the FileTable was gated behind this check. Now we always
            render the table; the `files` variable above derives root files
            from allFiles when selectedFolder is null. */}
        <>
          {/* Orientation bar: clickable folder path + vault-wide search. */}
          <div className="flex items-center gap-3 border-b border-helios-line px-3 py-1.5">
            <Breadcrumbs
              vaultName={vault?.name ?? "Vault"}
              folders={folders ?? []}
              selectedFolder={selectedFolder}
              onNavigate={setSelectedFolder}
            />
            <VaultSearch
              allFiles={allFiles ?? []}
              folders={folders ?? []}
              propertiesMap={vaultPropertiesMap}
              onPick={jumpToFile}
            />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 border-b border-helios-line px-3 py-1.5">
              {vaultFolderPath && autoSyncEnabled && (
                <VaultSyncSection
                  enabled
                  files={allFiles}
                  localFiles={localFiles ?? null}
                  versionsByFileId={versionsByFileId}
                  locks={locks}
                  currentUserId={user?.id ?? null}
                  vaultRoot={vaultFolderPath}
                  folders={folders ?? []}
                  vaultId={vaultId ?? null}
                  onComplete={onAutoSyncComplete}
                  onBusyChange={onAutoSyncBusy}
                  onRescan={rescan}
                />
              )}
              {autoSyncEnabled && !vaultFolderPath && (
                /* Auto mode is on but no Helios root is configured. Without a
                   local destination useAutoSync can't run and useLocalFolderScan
                   has nothing to scan — previously this rendered NOTHING (the
                   VaultSyncSection and Manual-mode pills are both gated out),
                   so auto-download looked completely dead. Surface the state +
                   a one-click way to pick a folder (which activates sync). */
                <span
                  className="flex items-center gap-1.5 rounded px-2 py-0.5 text-xs text-[#FFB800]"
                  title="Auto-download is on for this vault, but you haven't picked a local Helios folder yet. Pick one to start syncing — or switch to Manual in Settings."
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#FFB800]" />
                  Auto-download on — no sync folder set
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const picked = await openDirDialog({ directory: true, multiple: false });
                        if (typeof picked === "string") setHeliosRoot(picked);
                      } catch {
                        /* user cancelled or dialog unavailable — no-op */
                      }
                    }}
                    className="ml-1 rounded border border-asu-gold/70 bg-asu-gold/15 px-2 py-0.5 text-xs text-helios-text hover:bg-asu-gold/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
                  >
                    Set folder
                  </button>
                </span>
              )}
              {!autoSyncEnabled && (
                <>
                  <span
                    className="flex items-center gap-1.5 rounded px-2 py-0.5 text-xs text-helios-dim"
                    title="Auto-sync is off for this vault. Click Download on a row, shift-click to multi-select, or use the bulk buttons. Change in Settings."
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-helios-line" />
                    Manual mode
                  </span>
                  {selectedFiles.length > 0 && (
                    <button
                      type="button"
                      onClick={() => bulk.start(selectedFiles)}
                      disabled={bulk.running}
                      className="rounded border border-asu-gold/70 bg-asu-gold/15 px-2 py-0.5 text-xs text-helios-text hover:bg-asu-gold/25 disabled:opacity-50"
                      title={`Download ${selectedFiles.length} selected file${selectedFiles.length === 1 ? "" : "s"}`}
                    >
                      Download {selectedFiles.length} selected
                    </button>
                  )}
                  {/* Context button: recursive descent of current folder view
                      (or whole vault when at root). Distinct from the master
                      vault button below — at root they're identical and the
                      master one wins for clarity. */}
                  {selectedFiles.length === 0 && selectedFolder !== null && (
                    <ManualDownloadAll
                      files={filesToDownloadAll}
                      versionsByFileId={versionsByFileId}
                      heliosRoot={heliosRoot}
                      vaultName={vault?.name ?? null}
                      folders={folders ?? []}
                      onPickedRoot={setHeliosRoot}
                      onDone={() => { refetchFiles(); rescan(); }}
                    />
                  )}
                  {/* Master vault button — always visible, never about the
                      current folder, always grabs the entire active vault.
                      Lives outside the row-selection logic on purpose so
                      "download the whole thing" is one click from any view. */}
                  {(allFiles?.length ?? 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => bulk.start(allFiles ?? [])}
                      disabled={bulk.running}
                      className="rounded bg-asu-gold px-2 py-0.5 text-xs text-white hover:bg-asu-gold/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
                      title={`Download every file in ${vault?.name ?? "the active vault"} (${allFiles?.length ?? 0} files)`}
                    >
                      Download {vault?.name ?? "vault"} ({allFiles?.length ?? 0})
                    </button>
                  )}
                </>
              )}
              {canEdit && (
                <button
                  onClick={() => openPrompt("file")}
                  className="rounded px-2 py-0.5 text-xs text-helios-dim hover:bg-helios-line hover:text-helios-text"
                >
                  + File
                </button>
              )}
            </div>
            {/* Three distinct states for the file list (H1): a failed query
                shows an inline error + retry, an initial load shows a
                placeholder, and the table (with its own per-row empty copy)
                shows otherwise. Previously a failed query left a permanent
                spinner because the error was never read. */}
            {fileAreaError ? (
              <InlineError
                message={friendlyPgError(fileAreaError, fileAreaErrorCtx).message}
                fallback="Couldn't load files."
                onRetry={retryFileArea}
              />
            ) : fileListLoading ? (
              <SkeletonRows />
            ) : vaultIsEmpty ? (
              <VaultOnboarding
                vaultName={vault?.name ?? "this vault"}
                canEdit={canEdit}
                hasLocalFolder={!!vaultFolderPath}
                onPickFolder={async () => {
                  try {
                    const picked = await openDirDialog({ directory: true, multiple: false });
                    if (typeof picked === "string") setHeliosRoot(picked);
                  } catch { /* cancelled */ }
                }}
              />
            ) : (
              <>
                <BulkActionBar
                  selectedIds={Array.from(selected)}
                  onClear={clearSelection}
                  onDone={() => {
                    refetchFiles();
                    refetchLocks();
                    rescan();
                    // Intentionally do NOT clearSelection() here: clearing the
                    // selection unmounts BulkActionBar (it returns null when
                    // nothing is selected), which destroys the aria-live result
                    // status ("Checked out 2/2 (1 failed)") in the same commit
                    // it's set — the user/screen-reader never sees it. Leave the
                    // selection so the result stays visible; the user clears it
                    // with the bar's own Clear button when ready.
                  }}
                  files={files ?? []}
                  localFiles={localFiles}
                  versionsByFileId={versionsByFileId}
                  vaultRoot={vaultFolderPath}
                  folders={folders ?? []}
                  vaultId={vaultId ?? null}
                  locks={locks ?? []}
                  currentUserId={user?.id ?? null}
                />
                <FileTable
                  files={files ?? []}
                  selected={selectedFile}
                  locks={locks ?? []}
                  holderEmailById={holderEmailById}
                  currentUserId={user?.id ?? ""}
                  canEdit={canEdit}
                  onSelect={setSelectedFile}
                  onActionComplete={handleActionComplete}
                  selectedIds={selected}
                  onToggleSelect={toggleOne}
                  onToggleSelectAll={toggleAll}
                  allSelected={files !== null && files.length > 0 && selected.size === files.length}
                  localFiles={localFiles}
                  versionsByFileId={versionsByFileId}
                  vaultRoot={vaultFolderPath}
                  folders={folders ?? []}
                  vaultId={vaultId ?? null}
                  downloadMode={downloadMode}
                  openInSw={openInSw}
                  onRowMenu={(f, x, y) =>
                    handleTreeContextMenu({ kind: "files", files: [f] }, x, y)
                  }
                  childFolders={childFolders}
                  onOpenFolder={(id) => setSelectedFolder(id)}
                  fileCountByFolder={fileCountByFolder}
                />
              </>
            )}
        </>
      </div>
      {/* Pass `undefined` (not `[]`) while allFiles is still loading so the
          panel shows its normal state, not a false "file deleted" message. It
          only treats a selection as missing once the list has actually loaded. */}
      <FileDetailPanel
        fileId={selectedFile}
        files={allFiles ?? undefined}
        vaultRoot={vaultFolderPath}
        folders={folders ?? []}
        canEdit={canEdit}
        vaultId={vaultId ?? null}
        isWatched={selectedFile ? isWatched(selectedFile) : false}
        onToggleWatch={toggleWatch}
      />
      </div>
      {/* Full-pane drag overlay: names the live drop target so a drop is never
          a guess. pointer-events-none keeps the underlying hit-testing (tree
          row hover) working while it's up. */}
      {dropImport.dragActive && (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-end justify-center bg-asu-gold/5 pb-16">
          <div className="rounded-lg border-2 border-dashed border-asu-gold bg-helios-base/95 px-6 py-3 shadow-2xl">
            <p className="text-sm font-semibold text-helios-text">
              Drop to add to <span className="text-asu-gold">{dropTargetName}</span>
            </p>
            <p className="mt-0.5 text-center text-[11px] text-helios-dim">
              Hover a folder in the tree to target it
            </p>
          </div>
        </div>
      )}
      {/* Bulk-download progress modal shared by ManualDownloadAll and the
          right-click context menu. */}
      <BulkDownloadModal api={bulk} />
      {/* Drag-and-drop import progress / result strip (T13). Mirrors the
          BulkActionBar visual language. Shows a live "Importing…" state while
          files land, then a per-item result list with errors + a dismiss. */}
      {(dropImport.importing || dropImport.results.length > 0) && (
        <div className="fixed bottom-3 right-3 z-40 w-80 rounded-lg border border-helios-line bg-helios-panel p-3 text-xs shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold text-helios-text">
              {dropImport.importing
                ? "Importing dropped files…"
                : (() => {
                    const ok = dropImport.results.filter((r) => r.ok).length;
                    const total = dropImport.results.length;
                    const failed = total - ok;
                    return `Imported ${ok}/${total}${failed ? ` (${failed} failed)` : ""}`;
                  })()}
            </span>
            {!dropImport.importing && (
              <button
                type="button"
                onClick={dropImport.clearResults}
                className="rounded px-1.5 py-0.5 text-helios-dim hover:bg-helios-line hover:text-helios-text"
              >
                Dismiss
              </button>
            )}
          </div>
          {dropImport.importing && (
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-helios-line">
              <div className="h-full w-1/3 animate-pulse bg-yellow-400" />
            </div>
          )}
          {dropImport.results.length > 0 && (
            <ul className="max-h-40 space-y-0.5 overflow-auto">
              {dropImport.results.map((r, i) => (
                <li
                  key={i}
                  title={r.error ?? r.name}
                  className={
                    "flex items-center gap-1.5 truncate font-mono-num text-[11px] " +
                    (r.ok ? "text-helios-dim" : "text-[#EF5350]")
                  }
                >
                  <span className={"inline-block h-1.5 w-1.5 shrink-0 rounded-full " + (r.ok ? "bg-green-400" : "bg-[#EF5350]")} />
                  <span className="truncate">{r.name}</span>
                  {!r.ok && r.error && <span className="ml-auto shrink-0 text-[10px]">failed</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* Right-click context menu on tree rows. Folder → download every file
          under it; files → download the current multi-selection. */}
      {ctxMenu && (() => {
        const actions: MenuAction[] = [];
        // Capture the concrete file list ONCE up front, narrowed against the
        // discriminated target. The click handler closes over this local const
        // instead of re-narrowing ctxMenu.target.kind (which could drift), and
        // we guard bulk.start so an empty list never opens an empty progress
        // modal (V9).
        // Run a destructive action then refresh the affected slices, surfacing
        // any RPC failure inline (the RPC's own message passes through).
        const afterMutate = () => {
          refetchFolders();
          refetchAllFiles();
          refetchFiles();
          refetchDeleted();
          refetchDeletedFolders();
          refetchLocks();
          rescan();
        };

        if (ctxMenu.target.kind === "folder") {
          const folder = ctxMenu.target.folder;
          const targetFiles = ctxMenu.target.descendantFiles;
          const n = targetFiles.length;
          actions.push({
            label: `Download ${n} file${n === 1 ? "" : "s"} in ${folder.name}`,
            disabledReason: n === 0 ? "Folder has no files" : undefined,
            onClick: () => { if (targetFiles.length > 0) bulk.start(targetFiles); },
          });
          actions.push({
            label: "New folder…",
            disabledReason: canEdit ? undefined : "You don't have edit access",
            onClick: () => {
              setPromptParent(folder.id);
              openPrompt("folder");
            },
          });
          actions.push({
            label: "Copy vault path",
            onClick: () => {
              void navigator.clipboard.writeText(folderPath(folder.id, folders ?? []));
            },
          });
          actions.push({
            label: `Reveal in ${FILE_MANAGER}`,
            disabledReason: vaultFolderPath ? undefined : "No local folder set",
            onClick: () => {
              if (vaultFolderPath) {
                void revealInExplorer(`${vaultFolderPath}/${folderPath(folder.id, folders ?? [])}`);
              }
            },
          });
          // Delete-folder gating: an empty subtree (0 live descendant files) is
          // deletable by any editor; a non-empty one needs a vault admin (else
          // the user must check out + delete the files first to empty it).
          let deleteReason: string | undefined;
          if (n === 0) deleteReason = canEdit ? undefined : "You don't have edit access";
          else deleteReason = isVaultAdmin ? undefined : "Contains files — admins only (or empty it first)";
          actions.push({
            label: "Delete folder",
            danger: true,
            disabledReason: deleteReason,
            onClick: () => {
              setActionError(null);
              setConfirm({
                title: "Delete folder",
                body: `Move '${folder.name}' and everything in it to Deleted? (${n} file${n === 1 ? "" : "s"})`,
                confirmLabel: "Delete folder",
                onConfirm: async () => {
                  const ok = await deleteFolder.run(folder.id);
                  if (ok) {
                    // M16: reset selectedFolder if it IS the deleted folder or
                    // any descendant of it. Navigate to the nearest still-live
                    // ancestor (or null/root if all ancestors are also gone).
                    if (
                      selectedFolder !== null &&
                      (selectedFolder === folder.id ||
                        isDescendantOf(folders ?? [], selectedFolder, folder.id))
                    ) {
                      const allFolders = folders ?? [];
                      // Build the set of ids that will still be live after the
                      // deletion: everything except the deleted folder and all
                      // its descendants (the server soft-deletes the whole subtree).
                      const deletedSubtree = new Set<FolderId>([folder.id]);
                      for (const f of allFolders) {
                        if (isDescendantOf(allFolders, f.id, folder.id)) {
                          deletedSubtree.add(f.id);
                        }
                      }
                      const liveIds = new Set(
                        allFolders.map((f) => f.id).filter((id) => !deletedSubtree.has(id)),
                      );
                      setSelectedFolder(
                        nearestLiveAncestor(allFolders, liveIds, selectedFolder),
                      );
                    }
                    toast(`Moved ${folder.name} to Deleted`, "info");
                    afterMutate();
                  } else {
                    setActionError(deleteFolder.error?.message ?? "Couldn't delete the folder.");
                  }
                },
              });
            },
          });
        } else {
          const targetFiles = ctxMenu.target.files;
          const n = targetFiles.length;
          actions.push({
            label: `Download ${n} selected file${n === 1 ? "" : "s"}`,
            disabledReason: n === 0 ? "Nothing selected" : undefined,
            onClick: () => { if (targetFiles.length > 0) bulk.start(targetFiles); },
          });
          // Delete gating mirrors BulkActionBar: a file is deletable when the
          // current user holds its lock, or is an admin. Enabled only when EVERY
          // selected file qualifies.
          const liveLockByFile = new Map<FileId, UserId>();
          for (const l of locks ?? []) {
            if (l.released_at === null) liveLockByFile.set(l.file_id, l.user_id);
          }
          const everyDeletable =
            n > 0 &&
            targetFiles.every(
              (f) => isVaultAdmin || liveLockByFile.get(f.id) === (user?.id ?? ""),
            );
          actions.push({
            label: `Delete ${n} file${n === 1 ? "" : "s"}`,
            danger: true,
            disabledReason:
              n === 0
                ? "Nothing selected"
                : everyDeletable
                  ? undefined
                  : "Only files you have checked out (or admins) can be deleted",
            onClick: () => {
              setActionError(null);
              // For a single-file delete, query where-used first and prepend an
              // impact warning to the confirm body so the user knows which
              // assemblies reference this file. Mirrors SW PDM impact warning.
              // Best-effort: if the query fails we fall through with no warning.
              const buildBody = async (): Promise<string> => {
                const baseBody = `Move ${n} file${n === 1 ? "" : "s"} to Deleted? They can be restored from the recycle bin.`;
                if (n !== 1) return baseBody;
                try {
                  const f = targetFiles[0]!;
                  const parents = await fetchWhereUsed(supabase, f.id);
                  const warning = whereUsedWarning(parents);
                  if (warning) return `${warning.message}\n\n${baseBody}`;
                } catch { /* ignore */ }
                return baseBody;
              };
              void buildBody().then((body) => {
                setConfirm({
                  title: `Delete ${n} file${n === 1 ? "" : "s"}`,
                  body,
                  confirmLabel: "Delete",
                  onConfirm: async () => {
                    const succeeded: FileId[] = [];
                    for (const f of targetFiles) {
                      const ok = await deleteFile.run(f.id);
                      if (ok) succeeded.push(f.id);
                    }
                    const failed = n - succeeded.length;
                    // M14: remove successfully-deleted ids from the selection even
                    // on partial failure, mirroring BulkActionBar.bulkDelete which
                    // keeps only the failed ids selected so the user can retry.
                    setSelected((prev) => selectionAfterPartialDelete(prev, succeeded));
                    if (failed > 0) {
                      setActionError(`${failed} of ${n} file${failed === 1 ? "" : "s"} couldn't be deleted.`);
                    } else {
                      toast(`Moved ${n} file${n === 1 ? "" : "s"} to Deleted`, "info");
                    }
                    afterMutate();
                  },
                });
              });
            },
          });
          // Single-file local affordances. matchLocal resolves the on-disk copy.
          if (n === 1) {
            const f = targetFiles[0]!;
            const m = matchLocal(f, localFiles ?? null, versionsByFileId, folders ?? []);
            const localPath = m.local?.absolutePath ?? null;
            actions.push({
              label: "Copy local path",
              disabledReason: localPath ? undefined : "No local copy of this file",
              onClick: () => { if (localPath) void navigator.clipboard.writeText(localPath); },
            });
            actions.push({
              label: "Copy name",
              onClick: () => { void navigator.clipboard.writeText(f.name); },
            });
            actions.push({
              label: `Reveal in ${FILE_MANAGER}`,
              disabledReason: localPath ? undefined : "No local copy of this file",
              onClick: () => { if (localPath) void revealInExplorer(localPath); },
            });
          }
        }
        return (
          <TreeContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            actions={actions}
            onClose={() => setCtxMenu(null)}
          />
        );
      })()}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          confirmTone="danger"
          cancelLabel="Cancel"
          onConfirm={() => { void confirm.onConfirm(); }}
          onClose={() => setConfirm(null)}
        />
      )}
      {actionError && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setActionError(null)}
        >
          <div
            role="alert"
            className="w-80 space-y-3 rounded-lg border border-[#EF5350]/50 bg-helios-panel p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-helios-text">Action failed</h3>
            <p className="text-xs text-red-200">{actionError}</p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setActionError(null)}
                className="rounded bg-asu-gold px-3 py-1 text-xs text-white hover:bg-asu-gold/90"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
      {prompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setPrompt(null)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handlePromptSubmit}
            className="w-80 space-y-3 rounded-lg border border-helios-line bg-helios-panel p-4 shadow-lg"
          >
            <h3 className="text-sm font-semibold text-helios-text">
              {prompt.kind === "folder" ? "New folder" : "New file"}
            </h3>
            <input
              autoFocus
              type="text"
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              placeholder={prompt.kind === "folder" ? "Folder name" : "File name (e.g. frame.sldprt)"}
              className="w-full rounded border border-helios-line bg-helios-base px-2 py-1 text-sm text-helios-text placeholder-helios-dim focus:outline-none focus:ring-1 focus:ring-asu-gold"
            />
            {promptError && <p className="text-xs text-[#EF5350]">{promptError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPrompt(null)}
                className="rounded px-3 py-1 text-xs text-helios-dim hover:bg-helios-line"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!promptValue.trim() || createFolder.loading || createFile.loading}
                className="rounded bg-asu-gold px-3 py-1 text-xs text-white hover:bg-asu-gold/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

/** First-run walkthrough shown when the active vault has zero folders AND zero
 *  files — three concrete steps instead of a bare empty table. */
function VaultOnboarding({
  vaultName,
  canEdit,
  hasLocalFolder,
  onPickFolder,
}: {
  vaultName: string;
  canEdit: boolean;
  hasLocalFolder: boolean;
  onPickFolder: () => void;
}) {
  const steps: Array<{ title: string; body: React.ReactNode; done?: boolean }> = [
    {
      title: "Pick your local folder",
      done: hasLocalFolder,
      body: hasLocalFolder ? (
        <span>Done — files sync to your Helios folder.</span>
      ) : (
        <span>
          Choose where {vaultName} lives on this machine.{" "}
          <button
            type="button"
            onClick={onPickFolder}
            className="rounded border border-asu-gold/70 bg-asu-gold/15 px-2 py-0.5 text-helios-text hover:bg-asu-gold/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          >
            Set folder
          </button>
        </span>
      ),
    },
    {
      title: "Drop files in",
      body: canEdit
        ? "Drag files or whole folders from Explorer anywhere onto this screen — they're vaulted and checked out to you."
        : "An editor drops files here to populate the vault; you'll see them appear live.",
    },
    {
      title: "Check out to edit",
      body: "Files are read-only until you check them out. Check Out grabs the lock + latest version; Check In publishes your changes for the team.",
    },
  ];
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md space-y-4">
        <h2 className="text-sm font-semibold text-helios-text">
          {vaultName} is empty — here's how it works
        </h2>
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={s.title} className="flex gap-3 rounded-lg border border-helios-line bg-helios-panel p-3">
              <span
                className={
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono-num text-xs " +
                  (s.done ? "bg-[#66BB6A]/20 text-[#9CCC65]" : "bg-asu-gold/15 text-asu-gold")
                }
              >
                {s.done ? "✓" : i + 1}
              </span>
              <div className="min-w-0 text-xs text-helios-dim">
                <p className="mb-0.5 font-medium text-helios-text">{s.title}</p>
                <p>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Inline error placeholder with a retry affordance. Rendered where a loading
 *  spinner would otherwise sit so a failed query is visibly distinct from
 *  loading and empty states (H1). */
function InlineError({ message, fallback, onRetry }: {
  message: string;
  fallback: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="m-3 rounded border border-[#EF5350]/50 bg-[#EF5350]/10 p-3 text-sm text-red-200">
      <p className="font-medium">{message || fallback}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded border border-[#EF5350]/60 px-2 py-0.5 text-xs text-red-100 hover:bg-[#EF5350]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
      >
        Retry
      </button>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Owns the autoSync state so its frequent status updates don't re-render the
 *  parent BrowseScreen (and therefore don't churn FolderTree / FileTable on
 *  every individual file download). */
function VaultSyncSection(props: {
  enabled: boolean;
  files: VaultFile[] | null | undefined;
  localFiles: import("../data/useLocalFolderScan").LocalFile[] | null;
  versionsByFileId: Map<FileId, Version[]>;
  locks: import("../data/types").Lock[] | null | undefined;
  currentUserId: string | null;
  vaultRoot: string | null;
  folders: import("../data/types").Folder[];
  vaultId: string | null;
  onComplete: () => void;
  onBusyChange: (busy: boolean) => void;
  onRescan: () => void;
}) {
  const status = useAutoSync({
    enabled: props.enabled,
    files: props.files,
    localFiles: props.localFiles,
    versionsByFileId: props.versionsByFileId,
    locks: props.locks,
    currentUserId: props.currentUserId,
    vaultRoot: props.vaultRoot,
    folders: props.folders,
    vaultId: props.vaultId,
    onComplete: props.onComplete,
  });
  const onBusyChange = props.onBusyChange;
  useEffect(() => { onBusyChange(status.busy); }, [status.busy, onBusyChange]);
  return <SyncStatusPill status={status} onRescan={props.onRescan} />;
}

function SyncStatusPill({ status, onRescan }: {
  status: import("../data/useAutoSync").AutoSyncStatus;
  onRescan: () => void;
}) {
  // Tick once a second while syncing AND the popover is open, so elapsed/ETA
  // updates inside the popover. Toolbar pill itself only re-renders on real
  // status changes — no per-second flicker for users who aren't looking at
  // the detail.
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!status.busy || !open) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [status.busy, open]);

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const { busy, lastDownloaded, lastFailed, lastRunAt, totalTasks, completedTasks,
    totalBytes, completedBytes, activeFiles, startedAt } = status;

  let label: string;
  let tone: string;
  let dot: string;
  if (busy) {
    // Always show what's in-flight inline so the user doesn't have to click
    // the pill to find out. Up to two filenames; truncates per-name so the
    // pill doesn't blow out the toolbar.
    const inFlight = activeFiles.slice(0, 2).join(", ");
    const base = totalTasks > 0 ? `Syncing ${completedTasks}/${totalTasks}` : "Syncing…";
    label = inFlight ? `${base} · ${inFlight}` : base;
    tone = "text-asu-gold";
    dot = "bg-yellow-400 animate-pulse";
  } else if (lastFailed > 0) {
    label = `${lastFailed} failed`;
    tone = "text-[#EF5350]";
    dot = "bg-[#EF5350]";
  } else if (lastDownloaded > 0) {
    label = `Pulled ${lastDownloaded}`;
    tone = "text-green-400";
    dot = "bg-green-400";
  } else if (lastRunAt) {
    label = "Up to date";
    tone = "text-helios-dim";
    dot = "bg-helios-line";
  } else {
    label = "Idle";
    tone = "text-helios-dim";
    dot = "bg-helios-line";
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        onDoubleClick={onRescan}
        className={"flex items-center gap-1.5 rounded px-2 py-0.5 text-xs hover:bg-helios-line " + tone}
        title="Click for sync detail · double-click to rescan"
      >
        <span className={"inline-block h-1.5 w-1.5 rounded-full " + dot} />
        {label}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-80 rounded-md border border-helios-line bg-helios-panel p-3 text-xs shadow-lg">
          {busy ? (() => {
            const pct = totalBytes > 0 ? Math.floor((completedBytes / totalBytes) * 100) : 0;
            const elapsed = startedAt ? Date.now() - startedAt : 0;
            const eta = completedBytes > 0 && totalBytes > completedBytes
              ? Math.round((elapsed / completedBytes) * (totalBytes - completedBytes))
              : null;
            return (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold text-helios-text">Syncing</span>
                  <span className="text-helios-dim">{completedTasks}/{totalTasks} files</span>
                </div>
                <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-helios-line">
                  <div
                    className="h-full bg-yellow-400 transition-[width] duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="mb-2 flex items-center justify-between text-[11px] text-helios-dim">
                  <span>{formatBytes(completedBytes)} / {formatBytes(totalBytes)} ({pct}%)</span>
                  <span>
                    {formatDuration(elapsed)} elapsed
                    {eta != null && ` · ~${formatDuration(eta)} left`}
                  </span>
                </div>
                {activeFiles.length > 0 && (
                  <div className="space-y-0.5">
                    <div className="text-[10px] uppercase tracking-wider text-helios-dim">In flight</div>
                    {activeFiles.map((name) => (
                      <div key={name} className="truncate font-mono-num text-[11px] text-helios-text">
                        {name}
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })() : (
            <>
              <div className="mb-1 font-semibold text-helios-text">{label}</div>
              <div className="text-helios-dim">
                {lastRunAt
                  ? `Last sync: ${new Date(lastRunAt).toLocaleTimeString()}`
                  : "No sync yet this session."}
              </div>
              <button
                onClick={() => { setOpen(false); onRescan(); }}
                className="mt-2 w-full rounded border border-helios-line px-2 py-1 text-helios-text hover:bg-helios-line"
              >
                Rescan local folder
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
