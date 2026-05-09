import { useState } from "react";
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
import { FolderTree } from "../components/FolderTree";
import { FileTable } from "../components/FileTable";
import { BulkActionBar } from "../components/BulkActionBar";
import { FileDetailPanel } from "./FileDetailPanel";
import type { FileId, FolderId } from "../data/types";

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

  // Local vault folder scan
  const { path: vaultFolderPath } = useVaultFolder();
  const { files: localFiles, refetch: rescan } = useLocalFolderScan(vaultFolderPath);

  // Latest versions for local-status matching
  const fileIds = (files ?? []).map((f) => f.id);
  const { data: latestByFileId } = useLatestVersions(fileIds);
  const versionsByFileId = new Map(
    Array.from(latestByFileId.entries()).map(([id, v]) => [id, [v]]),
  );

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
    <div className="flex h-full">
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
                <button
                  onClick={rescan}
                  className="rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  title="Rescan local vault folder"
                >
                  Rescan
                </button>
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
            />
          </>
        ) : (
          <div className="p-6 text-sm text-zinc-500">Select a folder to see its files.</div>
        )}
      </div>
      <FileDetailPanel fileId={selectedFile} />
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
