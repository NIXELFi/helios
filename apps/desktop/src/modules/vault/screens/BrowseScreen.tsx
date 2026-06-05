import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";
import { useUser } from "@helios/auth";
import { useActiveVault } from "../data/useActiveVault";
import { useFolders } from "../data/useFolders";
import { useFiles } from "../data/useFiles";
import { useLocks } from "../data/useLocks";
import { useIsAdmin } from "../data/useIsAdmin";
import { useMyRole } from "../data/useMyRole";
import { useCanEditVault } from "../data/useVaultRole";
import { useCreateFolder } from "../data/useCreateFolder";
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
import { useDeletedFileReaper } from "../data/useDeletedFileReaper";
import { ensureLocalFolderTree } from "../data/ensureLocalFolderTree";
import { useAutoSync } from "../data/useAutoSync";
import { useVaultRealtime } from "../data/useVaultRealtime";
import { useInterval } from "../data/useInterval";
import { useVaultUsers } from "../data/useVaultUsers";
import { findUnmatchedLocal } from "../data/find-unmatched";
import { friendlyPgError, type PgErrorContext } from "../data/pg-errors";
import { FolderTree } from "../components/FolderTree";
import { FileTable } from "../components/FileTable";
import { BulkActionBar } from "../components/BulkActionBar";
import { UnmatchedFilesBanner } from "../components/UnmatchedFilesBanner";
import { FileDetailPanel } from "./FileDetailPanel";
import type { FileId, FolderId, UserId, VaultFile, Version } from "../data/types";

// How often to fall back to a full local rescan if the filesystem watcher
// drops events. 30s is short enough to feel live, long enough to be cheap.
const LOCAL_RESCAN_INTERVAL_MS = 30_000;

// How often to poll the vault metadata (files/versions/locks) for other
// people's changes, as a safety net behind realtime. 15s feels near-live for a
// shared CAD vault without hammering the server with full-list refetches.
const VAULT_POLL_MS = 15_000;

export function BrowseScreen() {
  const user = useUser();
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

  const { data: folders, loading: foldersLoading, error: foldersError, refetch: refetchFolders } = useFolders(vaultId ?? undefined);
  const [selectedFolder, setSelectedFolder] = useState<FolderId | null>(null);

  const { data: filesInFolder, loading: filesLoading, error: filesError, refetch: refetchFiles } = useFiles(selectedFolder ?? undefined);
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
  const { data: allFiles, error: allFilesError, refetch: refetchAllFiles } = useAllFiles(vaultId ?? undefined);
  // Soft-deleted files (the recycle bin). Threaded into the realtime/poll
  // refetch below so a delete by another member lands here promptly, and fed to
  // the reaper that removes their local working copies on this machine.
  const { data: deletedFiles, refetch: refetchDeleted } = useDeletedFiles(vaultId ?? undefined);
  // Propagate deletes to disk: remove the local copy of any soft-deleted file.
  // Only in auto-sync mode — in manual mode the user owns their local files and
  // we never delete them out from under them.
  useDeletedFileReaper({
    enabled: autoSyncEnabled,
    deletedFiles,
    localFiles,
    folders: folders ?? [],
    onReaped: rescan,
  });
  // Materialize the vault folder scaffolding locally in BOTH download modes —
  // empty folders included — so the local tree always mirrors the vault
  // (spec 2a). Auto mode also runs this per sync pass; this effect covers
  // manual mode and the time before the first pass.
  useEffect(() => {
    if (!vaultFolderPath || !folders || folders.length === 0) return;
    void ensureLocalFolderTree(folders, vaultFolderPath);
  }, [folders, vaultFolderPath]);
  // Lock-holder names: map each user id → email (fall back to display name) so
  // the FileTable can render "Locked by <person>" instead of "Locked by other".
  // useVaultUsers errors for non-admins (the RPC is admin-gated); that's fine —
  // we simply fall back to the generic label, so we don't surface its error.
  const { data: vaultUsers } = useVaultUsers();
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

  // When the user has the vault root selected (selectedFolder === null) we
  // derive the file list from the vault-wide query instead of asking the
  // server for "files where folder_id IS NULL" — keeps the wiring simple and
  // avoids a second query. allFiles paginates, so this is correct at scale.
  const rootFiles = useMemo(
    () => (allFiles ?? []).filter((f) => f.folder_id === null),
    [allFiles],
  );
  const files = selectedFolder === null ? rootFiles : filesInFolder;

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
  // At the vault root the list is derived from allFiles (no per-folder spinner);
  // inside a folder it reflects the per-folder query's loading flag.
  const fileListLoading = selectedFolder !== null && filesLoading && filesInFolder === null;
  const retryFileArea = useCallback(() => {
    refetchFiles();
    refetchAllFiles();
    refetchLocks();
  }, [refetchFiles, refetchAllFiles, refetchLocks]);

  // Realtime: when anyone checks in / locks / unlocks / adds a file in this
  // vault, refetch the affected slice. The auto-sync hook below picks up the
  // new version state and downloads the bytes.
  const onVersion = useCallback(() => { refetchAllFiles(); refetchFiles(); }, [refetchAllFiles, refetchFiles]);
  const onLock = useCallback(() => { refetchLocks(); }, [refetchLocks]);
  const onFile = useCallback(() => { refetchAllFiles(); refetchFiles(); refetchDeleted(); }, [refetchAllFiles, refetchFiles, refetchDeleted]);
  useVaultRealtime(vaultId ?? undefined, { onVersion, onLock, onFile });

  // Periodic safety-net poll. Realtime (above) is the fast path, but if its
  // channel drops, the app was backgrounded, or an event is missed, new files
  // would never appear until the user manually did something (e.g. started a
  // download). Polling the vault metadata on an interval picks up other people's
  // check-ins automatically — the auto-sync hook then downloads them — so the
  // local vault stays current with zero user action. Gated on an active vault.
  const poll = useCallback(() => {
    refetchAllFiles();
    refetchFiles();
    refetchLocks();
    refetchDeleted();
  }, [refetchAllFiles, refetchFiles, refetchLocks, refetchDeleted]);
  useInterval(poll, vaultId ? VAULT_POLL_MS : null);

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

  // Tauri's webview doesn't render window.prompt(), so we use an in-app modal.
  const [prompt, setPrompt] = useState<{ kind: "folder" | "file" } | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [promptError, setPromptError] = useState<string | null>(null);

  async function handlePromptSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = promptValue.trim();
    if (!name || !vaultId || !prompt) return;
    setPromptError(null);
    if (prompt.kind === "folder") {
      const r = await createFolder.run(vaultId, name, selectedFolder);
      if (r) {
        refetchFolders();
        setPrompt(null);
        setPromptValue("");
      } else if (createFolder.error) {
        setPromptError(createFolder.error.message);
      }
    } else {
      const r = await createFile.run(vaultId, selectedFolder, name);
      if (r) {
        refetchFiles();
        setPrompt(null);
        setPromptValue("");
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
    <div className="flex h-full flex-col">
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
      <div className="flex min-h-0 flex-1">
      <div className="flex w-64 flex-col border-r border-helios-line bg-helios-base">
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
            />
          ) : foldersLoading ? (
            <div className="p-3 text-sm text-helios-dim">Loading folders…</div>
          ) : (
            <div className="p-3 text-sm text-helios-dim">No folders yet.</div>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {/* selectedFolder === null means "vault root view", not "nothing
            selected" — files at the vault root were previously unreachable
            because the FileTable was gated behind this check. Now we always
            render the table; the `files` variable above derives root files
            from allFiles when selectedFolder is null. */}
        <>
          <div className="flex items-center justify-end gap-2 border-b border-helios-line px-3 py-1.5">
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
              <div className="p-3 text-sm text-helios-dim">Loading files…</div>
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
                  downloadMode={downloadMode}
                  openInSw={openInSw}
                />
              </>
            )}
        </>
      </div>
      {/* Pass `undefined` (not `[]`) while allFiles is still loading so the
          panel shows its normal state, not a false "file deleted" message. It
          only treats a selection as missing once the list has actually loaded. */}
      <FileDetailPanel fileId={selectedFile} files={allFiles ?? undefined} vaultRoot={vaultFolderPath} folders={folders ?? []} canEdit={canEdit} />
      </div>
      {/* Bulk-download progress modal shared by ManualDownloadAll and the
          right-click context menu. */}
      <BulkDownloadModal api={bulk} />
      {/* Right-click context menu on tree rows. Folder → download every file
          under it; files → download the current multi-selection. */}
      {ctxMenu && (() => {
        const actions: MenuAction[] = [];
        // Capture the concrete file list ONCE up front, narrowed against the
        // discriminated target. The click handler closes over this local const
        // instead of re-narrowing ctxMenu.target.kind (which could drift), and
        // we guard bulk.start so an empty list never opens an empty progress
        // modal (V9).
        if (ctxMenu.target.kind === "folder") {
          const targetFiles = ctxMenu.target.descendantFiles;
          const n = targetFiles.length;
          actions.push({
            label: `Download ${n} file${n === 1 ? "" : "s"} in ${ctxMenu.target.folder.name}`,
            disabledReason: n === 0 ? "Folder has no files" : undefined,
            onClick: () => { if (targetFiles.length > 0) bulk.start(targetFiles); },
          });
        } else {
          const targetFiles = ctxMenu.target.files;
          const n = targetFiles.length;
          actions.push({
            label: `Download ${n} selected file${n === 1 ? "" : "s"}`,
            disabledReason: n === 0 ? "Nothing selected" : undefined,
            onClick: () => { if (targetFiles.length > 0) bulk.start(targetFiles); },
          });
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
