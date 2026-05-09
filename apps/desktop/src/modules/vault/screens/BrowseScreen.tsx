import { useState } from "react";
import { useUser } from "@helios/auth";
import { useVaults } from "../data/useVaults";
import { useFolders } from "../data/useFolders";
import { useFiles } from "../data/useFiles";
import { useLocks } from "../data/useLocks";
import { useIsAdmin } from "../data/useIsAdmin";
import { useCreateVault } from "../data/useCreateVault";
import { useCreateFolder } from "../data/useCreateFolder";
import { useCreateFile } from "../data/useCreateFile";
import { FolderTree } from "../components/FolderTree";
import { FileTable } from "../components/FileTable";
import { FileDetailPanel } from "./FileDetailPanel";
import type { FileId, FolderId } from "../data/types";

export function BrowseScreen() {
  const user = useUser();
  const isAdmin = useIsAdmin();

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

  const createVault = useCreateVault();
  const createFolder = useCreateFolder();
  const createFile = useCreateFile();

  const [vaultNameInput, setVaultNameInput] = useState("");

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

  async function handleCreateFolder() {
    if (!vaultId) return;
    const name = window.prompt("Folder name:");
    if (!name || name.trim() === "") return;
    const result = await createFolder.run(vaultId, name.trim(), selectedFolder);
    if (result) refetchFolders();
  }

  async function handleCreateFile() {
    if (!vaultId) return;
    const name = window.prompt("File name:");
    if (!name || name.trim() === "") return;
    const result = await createFile.run(vaultId, selectedFolder, name.trim());
    if (result) refetchFiles();
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
              onClick={handleCreateFolder}
              className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              title="New folder"
            >
              + Folder
            </button>
          )}
        </header>
        <div className="flex-1 overflow-auto">
          {folders ? (
            <FolderTree folders={folders} selected={selectedFolder} onSelect={setSelectedFolder} />
          ) : (
            <div className="p-3 text-sm text-zinc-500">Loading folders…</div>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {selectedFolder ? (
          <>
            {isAdmin && (
              <div className="flex justify-end border-b border-zinc-800 px-3 py-1.5">
                <button
                  onClick={handleCreateFile}
                  className="rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  + File
                </button>
              </div>
            )}
            <FileTable
              files={files ?? []}
              selected={selectedFile}
              locks={locks ?? []}
              currentUserId={user?.id ?? ""}
              canEdit={isAdmin}
              onSelect={setSelectedFile}
              onActionComplete={handleActionComplete}
            />
          </>
        ) : (
          <div className="p-6 text-sm text-zinc-500">Select a folder to see its files.</div>
        )}
      </div>
      <FileDetailPanel fileId={selectedFile} />
    </div>
  );
}
