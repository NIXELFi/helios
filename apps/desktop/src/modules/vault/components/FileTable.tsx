import { CheckOutButton, CheckInButton, CancelButton, GetLatestButton } from "./RowActions";
import { matchLocal } from "../data/local-match";
import type { FileId, Folder, Lock, UserId, VaultFile, Version } from "../data/types";
import type { LocalFile } from "../data/useLocalFolderScan";

interface Props {
  files: VaultFile[];
  selected: FileId | null;
  locks: Lock[];
  currentUserId: UserId;
  canEdit?: boolean;
  onSelect: (id: FileId) => void;
  onActionComplete?: () => void;
  // Multi-select
  selectedIds?: Set<FileId>;
  onToggleSelect?: (id: FileId) => void;
  onToggleSelectAll?: () => void;
  allSelected?: boolean;
  // Local folder sync
  localFiles?: LocalFile[] | null;
  versionsByFileId?: Map<FileId, Version[]>;
  // Download support
  vaultRoot?: string | null;
  folders?: Folder[];
}

/**
 * Combined per-row state. Derives a single visual state from lock state +
 * local sync state. Lock takes priority because "someone owns this" is the
 * most actionable signal.
 */
type RowState =
  | "locked-other"          // someone else has it — don't touch
  | "locked-me-modified"    // you hold it AND have local changes — ready to check in
  | "locked-me"             // you hold it, no local changes yet
  | "modified-unlocked"     // local changes exist but no lock — danger; should check out
  | "vault-only"            // server-only; not on disk
  | "synced"                // matches latest, no lock
  | "neutral";              // no local-folder context, or vault-only with no folder

function lockStateFor(file: VaultFile, locks: Lock[], me: UserId) {
  const lock = locks.find((l) => l.file_id === file.id && l.released_at === null);
  if (!lock) return { kind: "none" as const };
  return lock.user_id === me
    ? { kind: "me" as const, lock }
    : { kind: "other" as const, lock };
}

interface RowStateInfo {
  state: RowState;
  /** Tailwind border-color class for the left stripe. */
  stripe: string;
  /** Tailwind classes for the status pill background + text. */
  pill: string;
  /** Pill label. */
  label: string;
  /** Optional pill prefix (small icon char). */
  glyph?: string;
}

function deriveRowState(
  lockK: ReturnType<typeof lockStateFor>,
  localStatus: "synced" | "modified" | "vault-only" | "no-folder" | undefined,
  holderEmailById: Map<UserId, string>,
): RowStateInfo {
  if (lockK.kind === "other") {
    const email = holderEmailById.get(lockK.lock.user_id);
    return {
      state: "locked-other",
      stripe: "border-red-500",
      pill: "bg-red-500/15 text-red-200 border-red-700/60",
      label: email ? `Locked by ${email}` : "Locked by other",
      glyph: "🔒",
    };
  }
  if (lockK.kind === "me") {
    if (localStatus === "modified") {
      return {
        state: "locked-me-modified",
        stripe: "border-amber-400",
        pill: "bg-amber-500/20 text-amber-200 border-amber-600/70",
        label: "Locked by me · Modified",
        glyph: "🔒",
      };
    }
    return {
      state: "locked-me",
      stripe: "border-sky-400",
      pill: "bg-sky-500/15 text-sky-200 border-sky-700/60",
      label: "Locked by me",
      glyph: "🔒",
    };
  }
  if (localStatus === "modified") {
    return {
      state: "modified-unlocked",
      stripe: "border-orange-400",
      pill: "bg-orange-500/15 text-orange-200 border-orange-700/60",
      label: "Modified",
      glyph: "●",
    };
  }
  if (localStatus === "vault-only") {
    return {
      state: "vault-only",
      stripe: "border-zinc-600",
      pill: "bg-zinc-700/40 text-zinc-300 border-zinc-700",
      label: "Not local",
      glyph: "↓",
    };
  }
  if (localStatus === "synced") {
    return {
      state: "synced",
      stripe: "border-emerald-500",
      pill: "bg-emerald-500/15 text-emerald-300 border-emerald-700/60",
      label: "Synced",
      glyph: "✓",
    };
  }
  // no-folder, or vault file with no local match info — neutral.
  return {
    state: "neutral",
    stripe: "border-zinc-700",
    pill: "bg-zinc-800/60 text-zinc-400 border-zinc-700",
    label: "—",
  };
}

/** Small file-extension icon: same shape, different tint per extension. */
function FileTypeIcon({ name }: { name: string }) {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const tint =
    ext === "sldprt" ? "text-sky-400" :
    ext === "sldasm" ? "text-emerald-400" :
    ext === "slddrw" ? "text-orange-400" :
    "text-zinc-500";
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      className={"shrink-0 " + tint}
      fill="currentColor"
      fillOpacity="0.7"
      stroke="currentColor"
      strokeOpacity="0.95"
      strokeWidth="0.6"
      strokeLinejoin="round"
    >
      <path d="M3 2.5a1 1 0 0 1 1-1h5L13 5.5v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11Z" />
      <path d="M9 1.5V5h4" fill="none" stroke="currentColor" strokeWidth="0.8" />
    </svg>
  );
}

function StatusPill({ info }: { info: RowStateInfo }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium " +
        info.pill
      }
    >
      {info.glyph && <span aria-hidden className="leading-none">{info.glyph}</span>}
      <span>{info.label}</span>
    </span>
  );
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
  vaultRoot,
  folders = [],
}: Props) {
  const hasMultiSelect = selectedIds !== undefined && onToggleSelect !== undefined;
  const versionsMap = versionsByFileId ?? new Map<FileId, Version[]>();

  // We don't have user-email-by-id wired here (would need a useUsers hook).
  // Keep an empty map; falls through to the generic "Locked by other" label.
  const holderEmailById = new Map<UserId, string>();

  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur text-left text-[11px] uppercase tracking-wider text-zinc-500">
        <tr>
          {hasMultiSelect && (
            <th className="w-10 px-3 py-2.5">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleSelectAll}
                aria-label="Select all"
                className="accent-yellow-500"
              />
            </th>
          )}
          <th className="px-3 py-2.5 font-medium">Name</th>
          <th className="px-3 py-2.5 font-medium">Status</th>
          <th className="px-3 py-2.5 font-medium text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {files.map((f) => {
          const isSel = selected === f.id;
          const lk = lockStateFor(f, locks, currentUserId);
          const localMatch = localFiles !== undefined
            ? matchLocal(f, localFiles ?? null, versionsMap, folders)
            : null;
          const info = deriveRowState(
            lk,
            localMatch?.status,
            holderEmailById,
          );
          return (
            <tr
              key={f.id}
              onClick={() => onSelect(f.id)}
              className={
                "group cursor-pointer border-b border-zinc-900/80 transition-colors " +
                (isSel
                  ? "bg-zinc-800/80"
                  : "hover:bg-zinc-900/60")
              }
            >
              {hasMultiSelect && (
                <td className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selectedIds!.has(f.id)}
                    onChange={(e) => { e.stopPropagation(); onToggleSelect!(f.id); }}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select ${f.name}`}
                    className="accent-yellow-500"
                  />
                </td>
              )}
              <td
                className={
                  "px-3 py-2 text-zinc-100 border-l-[3px] " + info.stripe
                }
              >
                <div className="flex items-center gap-2">
                  <FileTypeIcon name={f.name} />
                  <span className="truncate font-mono text-[13px]">{f.name}</span>
                </div>
              </td>
              <td className="px-3 py-2">
                <StatusPill info={info} />
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {info.state !== "locked-me" && info.state !== "locked-me-modified" && info.state !== "locked-other" && canEdit && (
                    <CheckOutButton fileId={f.id} onDone={onActionComplete} />
                  )}
                  {(info.state === "locked-me" || info.state === "locked-me-modified") && (
                    <>
                      <CheckInButton
                        fileId={f.id}
                        localFile={localMatch?.local}
                        onDone={onActionComplete}
                      />
                      <CancelButton fileId={f.id} onDone={onActionComplete} />
                    </>
                  )}
                  {(localMatch?.status === "vault-only" || localMatch?.status === "modified") &&
                    vaultRoot && (
                      <GetLatestButton
                        fileId={f.id}
                        fileName={f.name}
                        folderId={f.folder_id}
                        latestSha={versionsMap.get(f.id)?.[0]?.sha256 ?? null}
                        vaultRoot={vaultRoot}
                        folders={folders}
                        onDone={onActionComplete}
                      />
                    )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
