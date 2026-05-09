import { useCallback, useMemo, useState } from "react";
import { useUser } from "@helios/auth";
import { useVaults } from "../data/useVaults";
import { useFolders } from "../data/useFolders";
import { useFiles } from "../data/useFiles";
import { useLocks } from "../data/useLocks";
import { useIsAdmin } from "../data/useIsAdmin";
import { useMyRole } from "../data/useMyRole";
import { useCreateVault } from "../data/useCreateVault";
import { useCreateFolder } from "../data/useCreateFolder";
import { useCreateFile } from "../data/useCreateFile";
import { useVaultFolder } from "../data/useVaultFolder";
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
import type { FileId, FolderId, Version } from "../data/types";

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

  const { data: vaults, refetch: refetchVaults } = useVaults();
  const vault = vaults?.[0];
  const vaultId = vault?.id;

  const { data: folders, refetch: refetchFolders } = useFolders(vaultId);
  const [selectedFolder, setSelectedFolder] = useState<FolderId | null>(null);

  const { data: files, refetch: refetchFiles } = useFiles(selectedFolder ?? undefined);
  const { data: locks, refetch: refetchLocks } = useLocks();
  const [selectedFile, setSelectedFile] = useState<FileId | null>(null);
  const [selected, setSelected] = useState<Set<FileId>>(new Set());

  // Local vault folder scan — auto-rescan on window focus + 30s interval +
  // native filesystem watcher so the synced/modified state stays live without
  // the user touching a button.
  const { path: vaultFolderPath } = useVaultFolder();
  const { files: localFiles, refetch: rescan } = useLocalFolderScan(vaultFolderPath, {
    intervalMs: LOCAL_RESCAN_INTERVAL_MS,
    rescanOnFocus: true,
    watchFs: true,
  });

  // Use vault-wide files for the auto-sync pass (so it covers folders the user
  // hasn't opened yet) and for unmatched-local detection.
  const { data: allFiles, refetch: refetchAllFiles } = useAllFiles(vaultId);
  const unmatched =
    allFiles && localFiles && folders
      ? findUnmatchedLocal(allFiles, localFiles, folders)
      : [];

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
  useVaultRealtime(vaultId, { onVersion, onLock, onFile });

  // Background auto-sync: download every vault file that isn't already on
  // disk and isn't locked by the current user. Re-runs whenever versions /
  // locks / files / local scan change.
  const onAutoSyncComplete = useCallback(() => { rescan(); }, [rescan]);
  const autoSync = useAutoSync({
    enabled: !!vaultFolderPath,
    files: allFiles,
    localFiles: localFiles ?? null,
    versionsByFileId,
    locks,
    currentUserId: user?.id ?? null,
    vaultRoot: vaultFolderPath,
    folders: folders ?? [],
    onComplete: onAutoSyncComplete,
  });

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

  const createVault = useCreateVault();
  const createFolder = useCreateFolder();
  const createFile = useCreateFile();

  const [vaultNameInput, setVaultNameInput] = useState("");

  // Tauri's webview doesn't render window.prompt(), so we use an in-app modal.
  const [prompt, setPrompt] = useState<{ kind: "folder" | "file" } | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [promptError, setPromptError] = useState<string | null>(null);

  async function handleCreateVault(e: React.FormEvent) {
    e.preventDefault();
    const name = vaultNameInput.trim();
    if (!name) return;
    const result = await createVault.run(name);
    if (result) {
      setVaultNameInput("");
      refetchVaults();
    }
  }

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

  // Empty-vault state for admins
  if (isAdmin && (!vaults || vaults.length === 0)) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950">
        <form onSubmit={handleCreateVault} className="flex flex-col items-center gap-3">
          <p className="text-sm text-zinc-400">No vault exists yet. Create one to get started.</p>
          <input
            type="text"
            placeholder="Vault name"
            value={vaultNameInput}
            onChange={(e) => setVaultNameInput(e.target.value)}
            className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-600"
          />
          <button
            type="submit"
            disabled={createVault.loading || !vaultNameInput.trim()}
            className="rounded bg-blue-700 px-4 py-1.5 text-sm text-white hover:bg-blue-600 disabled:opacity-50"
          >
            Create vault
          </button>
          {createVault.error && (
            <p className="text-xs text-red-400">{createVault.error.message}</p>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <UnmatchedFilesBanner
        vaultId={vaultId}
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
      <div className="flex w-64 flex-col border-r border-zinc-800 bg-zinc-950">
        <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <span className="text-xs uppercase tracking-wider text-zinc-500">
            {vault?.name ?? "(no vault)"}
          </span>
          {isAdmin && vaultId && (
            <button
              onClick={() => openPrompt("folder")}
              className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
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
            />
          ) : (
            <div className="p-3 text-sm text-zinc-500">Loading folders…</div>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {selectedFolder ? (
          <>
            <div className="flex items-center justify-end gap-2 border-b border-zinc-800 px-3 py-1.5">
              {vaultFolderPath && (
                <SyncStatusPill
                  busy={autoSync.busy}
                  lastDownloaded={autoSync.lastDownloaded}
                  lastFailed={autoSync.lastFailed}
                  lastRunAt={autoSync.lastRunAt}
                  onRescan={rescan}
                />
              )}
              {isAdmin && (
                <button
                  onClick={() => openPrompt("file")}
                  className="rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
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
            />
          </>
        ) : (
          <div className="p-6 text-sm text-zinc-500">Select a folder to see its files.</div>
        )}
      </div>
      <FileDetailPanel fileId={selectedFile} />
      </div>
      {prompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setPrompt(null)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handlePromptSubmit}
            className="w-80 space-y-3 rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-lg"
          >
            <h3 className="text-sm font-semibold text-zinc-100">
              {prompt.kind === "folder" ? "New folder" : "New file"}
            </h3>
            <input
              autoFocus
              type="text"
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              placeholder={prompt.kind === "folder" ? "Folder name" : "File name (e.g. frame.sldprt)"}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-600"
            />
            {promptError && <p className="text-xs text-red-400">{promptError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPrompt(null)}
                className="rounded px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!promptValue.trim() || createFolder.loading || createFile.loading}
                className="rounded bg-blue-700 px-3 py-1 text-xs text-white hover:bg-blue-600 disabled:opacity-50"
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

function SyncStatusPill({ busy, lastDownloaded, lastFailed, lastRunAt, onRescan }: {
  busy: boolean;
  lastDownloaded: number;
  lastFailed: number;
  lastRunAt: string | null;
  onRescan: () => void;
}) {
  let label: string;
  let tone: string;
  if (busy) {
    label = "Syncing…";
    tone = "text-yellow-400";
  } else if (lastFailed > 0) {
    label = `${lastFailed} failed`;
    tone = "text-red-400";
  } else if (lastDownloaded > 0) {
    label = `Pulled ${lastDownloaded}`;
    tone = "text-green-400";
  } else if (lastRunAt) {
    label = "Up to date";
    tone = "text-zinc-500";
  } else {
    label = "Idle";
    tone = "text-zinc-500";
  }
  return (
    <button
      onClick={onRescan}
      className={"flex items-center gap-1.5 rounded px-2 py-0.5 text-xs hover:bg-zinc-800 " + tone}
      title="Auto-syncs in the background. Click to rescan local folder."
    >
      <span className={"inline-block h-1.5 w-1.5 rounded-full " + (busy ? "bg-yellow-400 animate-pulse" : lastFailed > 0 ? "bg-red-400" : "bg-zinc-600")} />
      {label}
    </button>
  );
}
