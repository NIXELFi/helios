import { useEffect, useMemo, useState } from "react";
import { useUser } from "@helios/auth";
import { useActiveVault } from "../data/useActiveVault";
import { useFolders } from "../data/useFolders";
import { useFiles } from "../data/useFiles";
import { useVersions } from "../data/useVersions";
import { useLocks } from "../data/useLocks";
import { FolderTree } from "../components/FolderTree";
import { FileTable } from "../components/FileTable";
import { VersionList } from "../components/VersionList";
import type { FileId, FolderId } from "../data/types";

export function HistoryScreen() {
  const user = useUser();
  const { activeVaultId: vaultId } = useActiveVault();
  const { data: folders, loading: foldersLoading, error: foldersError } = useFolders(vaultId ?? undefined);
  const [folderId, setFolderId] = useState<FolderId | null>(null);
  const { data: files, loading: filesLoading, error: filesError } = useFiles(folderId ?? undefined);
  const [fileId, setFileId] = useState<FileId | null>(null);
  const { data: versions, loading: versionsLoading, error: versionsError } = useVersions(fileId ?? undefined);
  // Real lock state so the file table can show who has each file checked out,
  // instead of the previous hardcoded `locks={[]}`. useLocks is cross-vault;
  // FileTable matches by file_id so unrelated locks are simply ignored.
  const { data: locks } = useLocks();

  // Scope locks to the files currently shown so a cross-vault lock can't tint
  // an unrelated row (FileTable matches on file_id, but keep the prop tight).
  const folderLocks = useMemo(() => {
    if (!locks || !files) return [];
    const ids = new Set(files.map((f) => f.id));
    return locks.filter((l) => ids.has(l.file_id));
  }, [locks, files]);

  // Reset selection when the active vault changes — otherwise switching
  // from SDM26 to SDM27 keeps the SDM26 folder/file ids selected and
  // the version list silently shows wrong-vault rows (or empty under RLS).
  useEffect(() => {
    setFolderId(null);
    setFileId(null);
  }, [vaultId]);

  return (
    <div className="flex h-full">
      <div className="w-56 border-r border-helios-line bg-helios-base overflow-auto">
        {foldersLoading && !folders ? (
          <div className="p-4 text-sm text-helios-dim">Loading folders…</div>
        ) : foldersError ? (
          <div className="p-4 text-sm text-[#EF5350]">{foldersError.message}</div>
        ) : folders ? (
          <FolderTree folders={folders} selected={folderId} onSelect={setFolderId} />
        ) : null}
      </div>
      <div className="w-72 border-r border-helios-line overflow-auto">
        {!folderId ? (
          <div className="p-6 text-sm text-helios-dim">Pick a folder.</div>
        ) : filesLoading && !files ? (
          <div className="p-6 text-sm text-helios-dim">Loading files…</div>
        ) : filesError ? (
          <div className="p-6 text-sm text-[#EF5350]">{filesError.message}</div>
        ) : files ? (
          <FileTable
            files={files}
            selected={fileId}
            locks={folderLocks}
            currentUserId={user?.id ?? ""}
            canEdit={false}
            onSelect={setFileId}
          />
        ) : null}
      </div>
      <div className="flex-1 overflow-auto">
        {!fileId ? (
          <div className="p-6 text-sm text-helios-dim">Pick a file to see its history.</div>
        ) : versionsLoading && !versions ? (
          <div className="p-6 text-sm text-helios-dim">Loading history…</div>
        ) : versionsError ? (
          <div className="p-6 text-sm text-[#EF5350]">{versionsError.message}</div>
        ) : versions ? (
          <VersionList versions={versions} onSelect={() => {}} />
        ) : null}
      </div>
    </div>
  );
}
