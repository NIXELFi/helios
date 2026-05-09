import { useState } from "react";
import { useUser } from "@helios/auth";
import { useVaults } from "../data/useVaults";
import { useFolders } from "../data/useFolders";
import { useFiles } from "../data/useFiles";
import { useLocks } from "../data/useLocks";
import { FolderTree } from "../components/FolderTree";
import { FileTable } from "../components/FileTable";
import { FileDetailPanel } from "./FileDetailPanel";
import type { FileId, FolderId } from "../data/types";

export function BrowseScreen() {
  const user = useUser();
  const { data: vaults } = useVaults();
  const vaultId = vaults?.[0]?.id;
  const { data: folders } = useFolders(vaultId);
  const [selectedFolder, setSelectedFolder] = useState<FolderId | null>(null);
  const { data: files } = useFiles(selectedFolder ?? undefined);
  const { data: locks } = useLocks();
  const [selectedFile, setSelectedFile] = useState<FileId | null>(null);

  return (
    <div className="flex h-full">
      <div className="flex w-64 flex-col border-r border-zinc-800 bg-zinc-950">
        <header className="border-b border-zinc-800 px-3 py-2 text-xs uppercase tracking-wider text-zinc-500">
          {vaults?.[0]?.name ?? "(no vault)"}
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
          <FileTable
            files={files ?? []}
            selected={selectedFile}
            locks={locks ?? []}
            currentUserId={user?.id ?? ""}
            onSelect={setSelectedFile}
          />
        ) : (
          <div className="p-6 text-sm text-zinc-500">Select a folder to see its files.</div>
        )}
      </div>
      <FileDetailPanel fileId={selectedFile} />
    </div>
  );
}
