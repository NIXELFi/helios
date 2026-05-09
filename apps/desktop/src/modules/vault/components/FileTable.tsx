import { LockBadge } from "./LockBadge";
import { LocalStatusBadge } from "./LocalStatusBadge";
import { CheckOutButton, CheckInButton, CancelButton } from "./RowActions";
import { matchLocal } from "../data/local-match";
import type { FileId, Lock, UserId, VaultFile, Version } from "../data/types";
import type { LocalFile } from "../data/useLocalFolderScan";

interface Props {
  files: VaultFile[];
  selected: FileId | null;
  locks: Lock[];
  currentUserId: UserId;
  canEdit?: boolean;
  onSelect: (id: FileId) => void;
  onActionComplete?: () => void;
  // Multi-select (optional — existing callers without selection still work)
  selectedIds?: Set<FileId>;
  onToggleSelect?: (id: FileId) => void;
  onToggleSelectAll?: () => void;
  allSelected?: boolean;
  // Local folder sync (optional — when undefined the Local column is hidden)
  localFiles?: LocalFile[] | null;
  versionsByFileId?: Map<FileId, Version[]>;
}

function lockStateFor(file: VaultFile, locks: Lock[], me: UserId) {
  const lock = locks.find((l) => l.file_id === file.id && l.released_at === null);
  if (!lock) return "latest" as const;
  return lock.user_id === me ? ("locked-by-me" as const) : ("locked-by-other" as const);
}

export function FileTable({
  files,
  selected,
  locks,
  currentUserId,
  canEdit = true,
  onSelect,
  onActionComplete,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  allSelected = false,
  localFiles,
  versionsByFileId,
}: Props) {
  const hasMultiSelect = selectedIds !== undefined && onToggleSelect !== undefined;
  const hasLocalColumn = localFiles !== undefined;
  const versionsMap = versionsByFileId ?? new Map<FileId, Version[]>();

  return (
    <table className="w-full text-sm">
      <thead className="border-b border-zinc-800 text-left text-zinc-400">
        <tr>
          {hasMultiSelect && (
            <th className="w-8 px-3 py-2">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleSelectAll}
                aria-label="Select all"
              />
            </th>
          )}
          <th className="px-3 py-2 font-normal">Name</th>
          <th className="px-3 py-2 font-normal">Status</th>
          {hasLocalColumn && (
            <th className="px-3 py-2 font-normal">Local</th>
          )}
          <th className="px-3 py-2 font-normal">Actions</th>
        </tr>
      </thead>
      <tbody>
        {files.map((f) => {
          const isSel = selected === f.id;
          const state = lockStateFor(f, locks, currentUserId);
          const localMatch = hasLocalColumn
            ? matchLocal(f, localFiles ?? null, versionsMap)
            : null;
          return (
            <tr
              key={f.id}
              onClick={() => onSelect(f.id)}
              className={
                "cursor-pointer border-b border-zinc-900 " +
                (isSel ? "bg-zinc-800" : "hover:bg-zinc-900")
              }
            >
              {hasMultiSelect && (
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selectedIds!.has(f.id)}
                    onChange={(e) => { e.stopPropagation(); onToggleSelect!(f.id); }}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select ${f.name}`}
                  />
                </td>
              )}
              <td className="px-3 py-2 text-zinc-100">{f.name}</td>
              <td className="px-3 py-2">
                <LockBadge state={state} />
              </td>
              {hasLocalColumn && (
                <td className="px-3 py-2">
                  {localMatch && <LocalStatusBadge status={localMatch.status} />}
                </td>
              )}
              <td className="px-3 py-2">
                {state === "latest" && canEdit ? (
                  <CheckOutButton fileId={f.id} onDone={onActionComplete} />
                ) : state === "locked-by-me" ? (
                  <>
                    <CheckInButton
                      fileId={f.id}
                      localFile={localMatch?.local}
                      onDone={onActionComplete}
                    />
                    <CancelButton fileId={f.id} onDone={onActionComplete} />
                  </>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
