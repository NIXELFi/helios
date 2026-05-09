import { useState } from "react";
import { useUser } from "@helios/auth";
import { useVaults } from "../data/useVaults";
import { useFolders } from "../data/useFolders";
import { useFiles } from "../data/useFiles";
import { useVersions } from "../data/useVersions";
import { FolderTree } from "../components/FolderTree";
import { FileTable } from "../components/FileTable";
import { VersionList } from "../components/VersionList";
import type { FileId, FolderId } from "../data/types";

export function HistoryScreen() {
  const user = useUser();
  const { data: vaults } = useVaults();
  const vaultId = vaults?.[0]?.id;
  const { data: folders } = useFolders(vaultId);
  const [folderId, setFolderId] = useState<FolderId | null>(null);
  const { data: files } = useFiles(folderId ?? undefined);
  const [fileId, setFileId] = useState<FileId | null>(null);
  const { data: versions } = useVersions(fileId ?? undefined);

  return (
    <div className="flex h-full">
      <div className="w-56 border-r border-zinc-800 bg-zinc-950 overflow-auto">
        {folders ? (
          <FolderTree folders={folders} selected={folderId} onSelect={setFolderId} />
        ) : null}
      </div>
      <div className="w-72 border-r border-zinc-800 overflow-auto">
        {folderId && files ? (
          <FileTable
            files={files}
            selected={fileId}
            locks={[]}
            currentUserId={user?.id ?? ""}
            canEdit={false}
            onSelect={setFileId}
          />
        ) : (
          <div className="p-6 text-sm text-zinc-500">Pick a folder.</div>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {fileId && versions ? (
          <VersionList versions={versions} onSelect={() => {}} />
        ) : (
          <div className="p-6 text-sm text-zinc-500">Pick a file to see its history.</div>
        )}
      </div>
    </div>
  );
}
