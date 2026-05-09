import { LockBadge } from "./LockBadge";
import { CheckOutButton, CheckInButton, CancelButton } from "./RowActions";
import type { FileId, Lock, UserId, VaultFile } from "../data/types";

interface Props {
  files: VaultFile[];
  selected: FileId | null;
  locks: Lock[];
  currentUserId: UserId;
  canEdit?: boolean;
  onSelect: (id: FileId) => void;
  onActionComplete?: () => void;
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
}: Props) {
  return (
    <table className="w-full text-sm">
      <thead className="border-b border-zinc-800 text-left text-zinc-400">
        <tr>
          <th className="px-3 py-2 font-normal">Name</th>
          <th className="px-3 py-2 font-normal">Status</th>
          <th className="px-3 py-2 font-normal">Actions</th>
        </tr>
      </thead>
      <tbody>
        {files.map((f) => {
          const isSel = selected === f.id;
          const state = lockStateFor(f, locks, currentUserId);
          return (
            <tr
              key={f.id}
              onClick={() => onSelect(f.id)}
              className={
                "cursor-pointer border-b border-zinc-900 " +
                (isSel ? "bg-zinc-800" : "hover:bg-zinc-900")
              }
            >
              <td className="px-3 py-2 text-zinc-100">{f.name}</td>
              <td className="px-3 py-2">
                <LockBadge state={state} />
              </td>
              <td className="px-3 py-2">
                {state === "latest" && canEdit ? (
                  <CheckOutButton fileId={f.id} onDone={onActionComplete} />
                ) : state === "locked-by-me" ? (
                  <>
                    <CheckInButton fileId={f.id} onDone={onActionComplete} />
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
