import { useEffect, useMemo, useState } from "react";
import { useUser } from "@helios/auth";
import { useActiveVault } from "../data/useActiveVault";
import { useFolders } from "../data/useFolders";
import { useFolderFiles, useVaultFiles } from "../data/vault-files-context";
import { useVersions } from "../data/useVersions";
import { useLocks } from "../data/useLocks";
import { useVaultUsers } from "../data/useVaultUsers";
import { usePeopleNames } from "../data/usePeopleNames";
import { useVaultFolder } from "../data/useVaultFolder";
import { FolderTree } from "../components/FolderTree";
import { FileTable } from "../components/FileTable";
import { VersionList } from "../components/VersionList";
import { GetVersionButton } from "../components/RowActions";
import { absoluteWhen, relativeWhen, whoLabel } from "../lib/when";
import type { FileId, FolderId, UserId, VaultFile } from "../data/types";

/** How many check-ins the no-file-selected activity feed lists. */
const ACTIVITY_LIMIT = 50;

export function HistoryScreen() {
  const user = useUser();
  const { activeVaultId: vaultId, activeVault } = useActiveVault();
  const { data: folders, loading: foldersLoading, error: foldersError } = useFolders(vaultId ?? undefined);
  const [folderId, setFolderId] = useState<FolderId | null>(null);
  // Folder listing derived from the shared vault catalog (VaultHome provides
  // it once) instead of a second per-folder query.
  const { data: allFiles, loading: filesLoading, error: filesError } = useVaultFiles();
  const files = useFolderFiles(folderId);
  const [fileId, setFileId] = useState<FileId | null>(null);
  const { data: versions, loading: versionsLoading, error: versionsError } = useVersions(fileId ?? undefined);
  // Per-vault local working folder → enables the "Get this version" action on
  // each history row (SW-PDM Get Version). Null when no folder is configured,
  // in which case Get falls back to a save dialog.
  const { path: vaultFolderPath } = useVaultFolder({ vaultName: activeVault?.name ?? null });
  const selectedFile = useMemo(
    () => files?.find((f) => f.id === fileId) ?? allFiles?.find((f) => f.id === fileId) ?? null,
    [files, allFiles, fileId],
  );
  // Real lock state so the file table can show who has each file checked out,
  // instead of the previous hardcoded `locks={[]}`. useLocks is cross-vault;
  // FileTable matches by file_id so unrelated locks are simply ignored.
  const { data: locks } = useLocks();
  // Names for "who did it": the vault user list (admin-gated — raises for
  // members, error ignored) layered over the org directory every signed-in
  // user can read, so members see real names too.
  const { data: vaultUsers } = useVaultUsers(vaultId);
  const nameById = usePeopleNames(vaultUsers);

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

  const folderName = folderId ? folders?.find((f) => f.id === folderId)?.name ?? null : null;

  return (
    <div className="flex h-full">
      <div className="w-56 border-r border-helios-line bg-helios-base overflow-auto">
        {foldersLoading && !folders ? (
          <div className="p-4 text-sm text-helios-dim">Loading folders…</div>
        ) : foldersError ? (
          <div className="p-4 text-sm text-[#EF5350]">{foldersError.message}</div>
        ) : folders ? (
          <FolderTree
            folders={folders}
            selected={folderId}
            onSelect={(id) => {
              setFolderId(id);
              setFileId(null);
            }}
          />
        ) : null}
      </div>
      <div className="w-60 shrink-0 overflow-auto border-r border-helios-line xl:w-72">
        {!folderId ? (
          <div className="p-6 text-sm text-helios-dim">Pick a folder to browse its files.</div>
        ) : filesLoading && !files ? (
          <div className="p-6 text-sm text-helios-dim">Loading files…</div>
        ) : filesError ? (
          <div className="p-6 text-sm text-[#EF5350]">{filesError.message}</div>
        ) : files ? (
          <FileTable
            files={files}
            selected={fileId}
            locks={folderLocks}
            holderEmailById={nameById}
            currentUserId={user?.id ?? ""}
            canEdit={false}
            onSelect={setFileId}
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {!fileId ? (
          <ActivityFeed
            // Remount per scope so a person filter from one folder can't stick
            // (hidden, matching nothing) on another.
            key={folderId ?? "all"}
            files={folderId ? files ?? [] : allFiles ?? []}
            scopeLabel={folderName ? `in ${folderName}` : "across the vault"}
            loading={filesLoading && !allFiles}
            nameById={nameById}
            currentUserId={user?.id ?? null}
            onPick={(f) => {
              setFolderId(f.folder_id);
              setFileId(f.id);
            }}
          />
        ) : versionsLoading && !versions ? (
          <div className="p-6 text-sm text-helios-dim">Loading history…</div>
        ) : versionsError ? (
          <div className="p-6 text-sm text-[#EF5350]">{versionsError.message}</div>
        ) : versions ? (
          <>
            <div className="flex items-center gap-2 border-b border-helios-line px-3 py-2">
              <button
                type="button"
                onClick={() => setFileId(null)}
                className="rounded px-1.5 py-0.5 text-xs text-helios-dim hover:bg-helios-line hover:text-helios-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold"
              >
                ← Activity
              </button>
              <span className="min-w-0 truncate font-mono-num text-sm text-helios-text" title={selectedFile?.name}>
                {selectedFile?.name}
              </span>
              <span className="ml-auto shrink-0 text-[11px] text-helios-dim">
                {versions.length} version{versions.length === 1 ? "" : "s"}
              </span>
            </div>
            <VersionList
              versions={versions}
              nameById={nameById}
              currentUserId={user?.id ?? null}
              renderActions={
                selectedFile
                  ? (v) => (
                      <GetVersionButton
                        version={v}
                        fileName={selectedFile.name}
                        folderId={selectedFile.folder_id}
                        vaultRoot={vaultFolderPath}
                        folders={folders ?? []}
                      />
                    )
                  : undefined
              }
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Latest check-ins (who / what / when) for the vault or the selected folder,
 * shown while no file is picked so History opens on "what changed lately"
 * instead of a blank pane. Built from the latest-version rows already embedded
 * on the shared catalog — no extra queries. One row per file (its newest
 * version); the person filter narrows to one author.
 */
function ActivityFeed({
  files,
  scopeLabel,
  loading,
  nameById,
  currentUserId,
  onPick,
}: {
  files: VaultFile[];
  scopeLabel: string;
  loading: boolean;
  nameById: ReadonlyMap<UserId, string>;
  currentUserId: string | null;
  onPick: (f: VaultFile) => void;
}) {
  const [author, setAuthor] = useState<string>("");
  const withVersion = useMemo(
    () =>
      files
        .filter((f) => f.latest?.created_at)
        .sort((a, b) => (a.latest!.created_at < b.latest!.created_at ? 1 : -1)),
    [files],
  );
  // Authors present in this scope, for the filter dropdown ("You" first).
  const authors = useMemo(() => {
    const ids = new Set<string>();
    for (const f of withVersion) if (f.latest?.author_id) ids.add(f.latest.author_id);
    return [...ids]
      .map((id) => ({ id, label: whoLabel(id, nameById, currentUserId) }))
      .sort((a, b) => (a.label === "You" ? -1 : b.label === "You" ? 1 : a.label.localeCompare(b.label)));
  }, [withVersion, nameById, currentUserId]);
  const shown = useMemo(
    () => (author ? withVersion.filter((f) => f.latest?.author_id === author) : withVersion).slice(0, ACTIVITY_LIMIT),
    [withVersion, author],
  );

  if (loading) return <div className="p-6 text-sm text-helios-dim">Loading activity…</div>;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-helios-line px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-helios-dim">
          Latest check-ins <span className="normal-case tracking-normal">{scopeLabel}</span>
        </h2>
        {authors.length > 1 && (
          <select
            aria-label="Filter by person"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            className="ml-auto rounded border border-helios-line bg-helios-base px-1.5 py-0.5 text-xs text-helios-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold"
          >
            <option value="">Everyone</option>
            {authors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        )}
      </div>
      {shown.length === 0 ? (
        <div className="p-6 text-sm text-helios-dim">No check-ins yet. Pick a file to see its history.</div>
      ) : (
        <ol className="divide-y divide-helios-line text-sm">
          {shown.map((f) => {
            const v = f.latest!;
            return (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => onPick(f)}
                  className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-helios-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-asu-gold"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono-num text-xs text-helios-text" title={f.name}>
                      {f.name}
                    </span>
                    <span className="shrink-0 font-mono-num text-[11px] text-asu-gold/90">v{v.version_num}</span>
                    <time
                      dateTime={v.created_at}
                      title={absoluteWhen(v.created_at)}
                      className="w-20 shrink-0 text-right text-xs text-helios-dim"
                    >
                      {relativeWhen(v.created_at)}
                    </time>
                  </span>
                  <span className="truncate text-[11px] text-helios-dim">
                    <span className="text-helios-text/80">{whoLabel(v.author_id, nameById, currentUserId)}</span>
                    {" · "}
                    {absoluteWhen(v.created_at)}
                    {v.comment ? <> · <span className="italic">"{v.comment}"</span></> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
