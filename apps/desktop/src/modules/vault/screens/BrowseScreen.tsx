import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "@helios/auth";
import { useActiveVault } from "../data/useActiveVault";
import { useFolders } from "../data/useFolders";
import { useFiles } from "../data/useFiles";
import { useLocks } from "../data/useLocks";
import { useIsAdmin } from "../data/useIsAdmin";
import { useMyRole } from "../data/useMyRole";
import { useCreateFolder } from "../data/useCreateFolder";
import { useCreateFile } from "../data/useCreateFile";
import { useVaultFolder } from "../data/useVaultFolder";
import { useDownloadMode } from "../data/useDownloadMode";
import { ManualDownloadAll } from "../components/ManualDownloadAll";
import { useBulkDownload } from "../data/useBulkDownload";
import { BulkDownloadModal } from "../components/BulkDownloadModal";
import { TreeContextMenu, type MenuAction } from "../components/TreeContextMenu";
import type { TreeContextTarget } from "../components/FolderTree";
import { useLocalFolderScan } from "../data/useLocalFolderScan";
import { useLatestVersions } from "../data/useLatestVersions";
import { useAllFiles } from "../data/useAllFiles";
import { useAutoSync } from "../data/useAutoSync";
import { useVaultRealtime } from "../data/useVaultRealtime";
import { findUnmatchedLocal } from "../data/find-unmatched";
import { FolderTree } from "../components/FolderTree";
import { FileTable } from "../components/FileTable";
import { BulkActionBar } from "../components/BulkActionBar";
import { UnmatchedFilesBanner } from "../components/UnmatchedFilesBanner";
import { FileDetailPanel } from "./FileDetailPanel";
import type { FileId, FolderId, VaultFile, Version } from "../data/types";

// How often to fall back to a full local rescan if the filesystem watcher
// drops events. 30s is short enough to feel live, long enough to be cheap.
const LOCAL_RESCAN_INTERVAL_MS = 30_000;

export function BrowseScreen() {
  const user = useUser();
  const isAdmin = useIsAdmin();
  const myRole = useMyRole();
  const canEdit = isAdmin || myRole === "editor";

  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);

  const { activeVault: vault, activeVaultId: vaultId, vaults, loading: vaultsLoading } = useActiveVault();

  const { data: folders, refetch: refetchFolders } = useFolders(vaultId ?? undefined);
  const [selectedFolder, setSelectedFolder] = useState<FolderId | null>(null);

  const { data: filesInFolder, refetch: refetchFiles } = useFiles(selectedFolder ?? undefined);
  const { data: locks, refetch: refetchLocks } = useLocks();
  const [selectedFile, setSelectedFile] = useState<FileId | null>(null);
  const [selected, setSelected] = useState<Set<FileId>>(new Set());

  // Reset folder/file selection on vault switch so we don't show a SDM27 folder
  // tree but a SDM26 file open in the side panel.
  useEffect(() => {
    setSelectedFolder(null);
    setSelectedFile(null);
    setSelected(new Set());
  }, [vaultId]);

  // Local vault folder scan — auto-rescan on window focus + 30s interval +
  // native filesystem watcher so the synced/modified state stays live without
  // the user touching a button. The folder is per-vault: SDM26 and SDM27 each
  // remember their own working directory.
  // Shared-root model: user picks ONE root in Settings, each vault syncs
  // into `<root>/<vault.name>/`. The hook computes the effective path for
  // the active vault from its name.
  const { path: vaultFolderPath } = useVaultFolder({ vaultName: vault?.name ?? null });
  const { mode: downloadMode } = useDownloadMode(vaultId);
  const autoSyncEnabled = downloadMode === "auto";
  // useAutoSync (declared below) → setSyncBusy → useLocalFolderScan paused.
  // While a sync pass is writing files we suppress automatic rescans so the
  // file table doesn't flicker between modified/synced as bytes land; the
  // explicit rescan from onComplete catches the final state.
  const [syncBusy, setSyncBusy] = useState(false);
  const { files: localFiles, refetch: rescan } = useLocalFolderScan(vaultFolderPath, {
    intervalMs: LOCAL_RESCAN_INTERVAL_MS,
    rescanOnFocus: true,
    watchFs: true,
    paused: syncBusy,
  });

  // Use vault-wide files for the auto-sync pass (so it covers folders the user
  // hasn't opened yet) and for unmatched-local detection.
  const { data: allFiles, refetch: refetchAllFiles } = useAllFiles(vaultId ?? undefined);
  const unmatched =
    allFiles && localFiles && folders
      ? findUnmatchedLocal(allFiles, localFiles, folders)
      : [];

  // When the user has the vault root selected (selectedFolder === null) we
  // derive the file list from the vault-wide query instead of asking the
  // server for "files where folder_id IS NULL" — keeps the wiring simple and
  // avoids a second query. allFiles paginates, so this is correct at scale.
  const rootFiles = useMemo(
    () => (allFiles ?? []).filter((f) => f.folder_id === null),
    [allFiles],
  );
  const files = selectedFolder === null ? rootFiles : filesInFolder;

  // Latest versions across the entire vault. The current-folder file table
  // and the background auto-sync both read from this single source so we
  // don't duplicate the round-trip.
  const allFileIds = useMemo(() => (allFiles ?? []).map((f) => f.id), [allFiles]);
  const { data: latestByFileId, refetch: refetchLatest } = useLatestVersions(allFileIds);
  const versionsByFileId = useMemo(
    () => new Map<FileId, Version[]>(
      Array.from(latestByFileId.entries()).map(([id, v]) => [id, [v]]),
    ),
    [latestByFileId],
  );

  // Realtime: when anyone checks in / locks / unlocks / adds a file in this
  // vault, refetch the affected slice. The auto-sync hook below picks up the
  // new version state and downloads the bytes.
  const onVersion = useCallback(() => { refetchLatest(); refetchAllFiles(); }, [refetchLatest, refetchAllFiles]);
  const onLock = useCallback(() => { refetchLocks(); }, [refetchLocks]);
  const onFile = useCallback(() => { refetchAllFiles(); refetchFiles(); }, [refetchAllFiles, refetchFiles]);
  useVaultRealtime(vaultId ?? undefined, { onVersion, onLock, onFile });

  // Background auto-sync lives inside <VaultSyncSection> so its rapid status
  // updates (one per file start + one per file end) re-render only that
  // subtree, never BrowseScreen / FolderTree / FileTable. Busy state and
  // completion are forwarded back up via callbacks for the rescan-pause and
  // refetch wiring.
  const onAutoSyncComplete = useCallback(() => { rescan(); }, [rescan]);
  const onAutoSyncBusy = useCallback((b: boolean) => setSyncBusy(b), []);

  // Multi-select in the tree (shift / cmd click) + right-click context menu.
  // The bulk-download hook is shared with ManualDownloadAll's button so the
  // progress UI is identical regardless of how the action was triggered.
  const [treeSelection, setTreeSelection] = useState<Set<FileId>>(new Set());
  useEffect(() => { setTreeSelection(new Set()); }, [vaultId]);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: TreeContextTarget } | null>(null);
  const bulk = useBulkDownload({
    vaultRoot: vaultFolderPath,
    folders: folders ?? [],
    versionsByFileId,
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
    bump();
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
          {isAdmin && vaultId && (
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
          {folders ? (
            <FolderTree
              folders={folders}
              selected={selectedFolder}
              onSelect={(id) => { setSelectedFolder(id); clearSelection(); }}
              files={allFiles ?? []}
              selectedFile={selectedFile}
              onSelectFile={setSelectedFile}
              locks={locks ?? []}
              currentUserId={user?.id ?? ""}
              multiSelectedFiles={treeSelection}
              onMultiSelectChange={setTreeSelection}
              onContextMenu={handleTreeContextMenu}
            />
          ) : (
            <div className="p-3 text-sm text-helios-dim">Loading folders…</div>
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
              {!autoSyncEnabled && (
                <>
                  <span
                    className="flex items-center gap-1.5 rounded px-2 py-0.5 text-xs text-helios-dim"
                    title="Auto-sync is off for this vault. Click Download on a row to pull bytes, or use Download all. Change in Settings."
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-helios-line" />
                    Manual mode
                  </span>
                  <ManualDownloadAll
                    files={files ?? []}
                    versionsByFileId={versionsByFileId}
                    vaultRoot={vaultFolderPath}
                    folders={folders ?? []}
                    onDone={() => { refetchFiles(); rescan(); }}
                  />
                </>
              )}
              {isAdmin && (
                <button
                  onClick={() => openPrompt("file")}
                  className="rounded px-2 py-0.5 text-xs text-helios-dim hover:bg-helios-line hover:text-helios-text"
                >
                  + File
                </button>
              )}
            </div>
            <BulkActionBar
              selectedIds={Array.from(selected)}
              onClear={clearSelection}
              onDone={() => {
                refetchFiles();
                refetchLocks();
                rescan();
                clearSelection();
              }}
              files={files ?? []}
              localFiles={localFiles}
              versionsByFileId={versionsByFileId}
              vaultRoot={vaultFolderPath}
              folders={folders ?? []}
            />
            <FileTable
              files={files ?? []}
              selected={selectedFile}
              locks={locks ?? []}
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
            />
        </>
      </div>
      <FileDetailPanel fileId={selectedFile} />
      </div>
      {/* Bulk-download progress modal shared by ManualDownloadAll and the
          right-click context menu. */}
      <BulkDownloadModal api={bulk} />
      {/* Right-click context menu on tree rows. Folder → download every file
          under it; files → download the current multi-selection. */}
      {ctxMenu && (() => {
        const actions: MenuAction[] = [];
        if (ctxMenu.target.kind === "folder") {
          const n = ctxMenu.target.descendantFiles.length;
          actions.push({
            label: `Download ${n} file${n === 1 ? "" : "s"} in ${ctxMenu.target.folder.name}`,
            disabledReason: n === 0 ? "Folder has no files" : undefined,
            onClick: () => bulk.start(ctxMenu.target.kind === "folder" ? ctxMenu.target.descendantFiles : []),
          });
        } else {
          const n = ctxMenu.target.files.length;
          actions.push({
            label: `Download ${n} selected file${n === 1 ? "" : "s"}`,
            disabledReason: n === 0 ? "Nothing selected" : undefined,
            onClick: () => bulk.start(ctxMenu.target.kind === "files" ? ctxMenu.target.files : []),
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
                className="rounded bg-asu-gold px-3 py-1 text-xs text-white hover:bg-asu-gold disabled:opacity-50"
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
    label = totalTasks > 0 ? `Syncing ${completedTasks}/${totalTasks}` : "Syncing…";
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
