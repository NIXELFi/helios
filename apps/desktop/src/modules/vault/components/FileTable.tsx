import { CheckOutButton, CheckInButton, CancelButton, GetLatestButton } from "./RowActions";
import { matchLocal } from "../data/local-match";
import type { FileId, Folder, Lock, UserId, VaultFile, Version } from "../data/types";
import type { LocalFile } from "../data/useLocalFolderScan";

interface Props {
  files: VaultFile[];
  selected: FileId | null;
  locks: Lock[];
  /** Resolves a lock holder's user id → display string (email or name) so a
   *  locked-by-other row shows "Locked by <person>". Optional: callers that
   *  don't supply it fall through to the generic "Locked by other" label. */
  holderEmailById?: Map<UserId, string>;
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
  /**
   * Per-vault download mode. In "manual" mode every server file with a known
   * latest version shows a "Download" action regardless of localMatch status,
   * because the user has opted out of background syncing and the row action
   * is their only way to pull bytes. Defaults to "auto" so callers that don't
   * pass this prop see the legacy behavior.
   */
  downloadMode?: "auto" | "manual";
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

// The vault status palette. This is now the SINGLE live renderer of vault
// status — the old LockBadge / LocalStatusBadge components were dead code and
// were deleted (DEAD-BADGES / V14), so there's no second palette to drift
// against. green = good, gold = needs attention, red = locked, neutral =
// absent; locked-by-me gets a slightly stronger red fill than locked-by-other
// so the user can tell at a glance which lock is theirs.
const PILL = {
  green: "bg-[#66BB6A]/20 text-[#9CCC65] border-[#66BB6A]/40",
  gold: "bg-[#FFB800]/20 text-[#FFD24D] border-[#FFB800]/40",
  redMe: "bg-[#EF5350]/30 text-[#EF9A9A] border-[#EF5350]/50",
  redOther: "bg-[#EF5350]/20 text-[#E57373] border-[#EF5350]/40",
  neutral: "bg-helios-line/40 text-helios-dim border-helios-line",
} as const;

function deriveRowState(
  lockK: ReturnType<typeof lockStateFor>,
  localStatus: "synced" | "modified" | "vault-only" | "no-folder" | undefined,
  holderEmailById: Map<UserId, string>,
): RowStateInfo {
  if (lockK.kind === "other") {
    const email = holderEmailById.get(lockK.lock.user_id);
    return {
      state: "locked-other",
      stripe: "border-[#EF5350]",
      pill: PILL.redOther,
      label: email ? `Locked by ${email}` : "Locked by other",
      glyph: "🔒",
    };
  }
  if (lockK.kind === "me") {
    if (localStatus === "modified") {
      return {
        state: "locked-me-modified",
        stripe: "border-[#FFB800]",
        pill: PILL.gold,
        label: "Locked by me · Modified",
        glyph: "🔒",
      };
    }
    return {
      state: "locked-me",
      stripe: "border-[#EF5350]",
      pill: PILL.redMe,
      label: "Locked by me",
      glyph: "🔒",
    };
  }
  if (localStatus === "modified") {
    return {
      state: "modified-unlocked",
      stripe: "border-[#FFB800]",
      pill: PILL.gold,
      label: "Modified",
      glyph: "●",
    };
  }
  if (localStatus === "vault-only") {
    return {
      state: "vault-only",
      stripe: "border-helios-line",
      pill: PILL.neutral,
      label: "Not local",
      glyph: "↓",
    };
  }
  if (localStatus === "synced") {
    return {
      state: "synced",
      stripe: "border-[#66BB6A]",
      pill: PILL.green,
      label: "Synced",
      glyph: "✓",
    };
  }
  // no-folder, or vault file with no local match info — neutral.
  return {
    state: "neutral",
    stripe: "border-helios-line",
    pill: PILL.neutral,
    label: "—",
  };
}

/** Small file-extension icon: same shape, different tint per extension. */
function FileTypeIcon({ name }: { name: string }) {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const tint =
    ext === "sldprt" ? "text-sky-400" :
    ext === "sldasm" ? "text-[#66BB6A]" :
    ext === "slddrw" ? "text-orange-400" :
    "text-helios-dim";
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
  holderEmailById,
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
  downloadMode = "auto",
}: Props) {
  const hasMultiSelect = selectedIds !== undefined && onToggleSelect !== undefined;
  const versionsMap = versionsByFileId ?? new Map<FileId, Version[]>();

  // Lock-holder name resolution is supplied by the parent (BrowseScreen wires
  // useVaultUsers). When absent we use an empty map, which falls through to the
  // generic "Locked by other" label in deriveRowState.
  const holderEmails = holderEmailById ?? new Map<UserId, string>();

  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-helios-base/95 backdrop-blur text-left text-[11px] uppercase tracking-wider text-helios-dim">
        <tr>
          {hasMultiSelect && (
            <th className="w-10 px-3 py-2.5">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleSelectAll}
                aria-label="Select all"
                className="accent-asu-gold"
              />
            </th>
          )}
          <th className="px-2.5 py-2 font-medium">Name</th>
          <th className="px-2.5 py-2 font-medium">Status</th>
          <th className="px-2.5 py-2 font-medium">Actions</th>
          {/* Trailing spacer absorbs slack so Name/Status/Actions cluster on
              the left and sit next to each other, instead of Actions drifting
              to the far right edge on a wide panel. */}
          <th className="w-full" aria-hidden />
        </tr>
      </thead>
      <tbody>
        {files.length === 0 && (
          <tr>
            <td
              colSpan={hasMultiSelect ? 5 : 4}
              className="px-3 py-8 text-center text-sm italic text-helios-dim"
            >
              No files in this folder
            </td>
          </tr>
        )}
        {files.map((f) => {
          const isSel = selected === f.id;
          const lk = lockStateFor(f, locks, currentUserId);
          const localMatch = localFiles !== undefined
            ? matchLocal(f, localFiles ?? null, versionsMap, folders)
            : null;
          const info = deriveRowState(
            lk,
            localMatch?.status,
            holderEmails,
          );
          return (
            <tr
              key={f.id}
              role="button"
              tabIndex={0}
              aria-current={isSel ? "page" : undefined}
              // Name the row via aria-labelledby pointing at the visible file
              // name span (below) instead of a redundant aria-label string.
              // This drops the double-announce AND scopes the row's accessible
              // name to just the file name — without it, a role="button" row
              // would otherwise absorb the inner action-button labels (Check
              // In, Get Latest, …) into its own name (FileTable aria-label
              // a11y smell).
              aria-labelledby={`file-row-name-${f.id}`}
              onClick={() => onSelect(f.id)}
              onKeyDown={(e) => {
                // Keyboard parity with the row's click affordance: Enter/Space
                // opens the file detail panel. Other keys (Tab etc.) pass
                // through untouched.
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(f.id);
                }
              }}
              className={
                "group cursor-pointer border-b border-helios-line/60 outline-none transition-colors " +
                "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-asu-gold " +
                (isSel
                  ? "bg-helios-line/80"
                  : "hover:bg-helios-panel/60")
              }
            >
              {hasMultiSelect && (
                <td
                  // Stop propagation on the whole cell so clicks in the
                  // cell padding (around the small checkbox itself) toggle
                  // selection instead of falling through to the <tr>
                  // onClick which would open the file detail panel.
                  className="w-10 px-3 py-2"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleSelect!(f.id);
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds!.has(f.id)}
                    // onChange still has stopPropagation as a backup —
                    // some browsers fire change before the cell's click
                    // handler reaches stopPropagation.
                    onChange={(e) => e.stopPropagation()}
                    aria-label={`Select ${f.name}`}
                    className="accent-asu-gold"
                  />
                </td>
              )}
              <td
                className={
                  "px-2.5 py-1.5 text-helios-text border-l-[3px] " + info.stripe
                }
              >
                <div className="flex items-center gap-2">
                  <FileTypeIcon name={f.name} />
                  <span id={`file-row-name-${f.id}`} className="block max-w-[22rem] truncate font-mono-num text-[13px]">{f.name}</span>
                </div>
              </td>
              <td className="px-2.5 py-1.5">
                <StatusPill info={info} />
              </td>
              <td className="px-2.5 py-1.5">
                <div className="flex flex-wrap items-center justify-start gap-1.5">
                  {info.state !== "locked-me" && info.state !== "locked-me-modified" && info.state !== "locked-other" && canEdit && (
                    <CheckOutButton
                      fileId={f.id}
                      onDone={onActionComplete}
                      vaultRoot={vaultRoot ?? null}
                      folderId={f.folder_id}
                      fileName={f.name}
                      folders={folders}
                      latestSha={versionsMap.get(f.id)?.[0]?.sha256 ?? null}
                      localFile={localMatch?.local}
                    />
                  )}
                  {(info.state === "locked-me" || info.state === "locked-me-modified") && (
                    <>
                      <CheckInButton
                        fileId={f.id}
                        localFile={localMatch?.local}
                        onDone={onActionComplete}
                        vaultRoot={vaultRoot ?? null}
                        folderId={f.folder_id}
                        fileName={f.name}
                        folders={folders}
                      />
                      <CancelButton
                        fileId={f.id}
                        onDone={onActionComplete}
                        vaultRoot={vaultRoot ?? null}
                        folderId={f.folder_id}
                        fileName={f.name}
                        folders={folders}
                        latestSha={versionsMap.get(f.id)?.[0]?.sha256 ?? null}
                      />
                    </>
                  )}
                  {(() => {
                    // Manual mode: surface a Download action on every file that
                    // has a latest version, regardless of localMatch — including
                    // "synced" (user may want to re-pull after a local edit) and
                    // "no-folder" (vaultRoot is unset → button uses a save
                    // dialog so the user can still get the bytes).
                    //
                    // Auto mode: keep the original gate — button only shows for
                    // "vault-only" or "modified" rows that have a vault folder,
                    // because background sync already handles the rest.
                    const showButton =
                      downloadMode === "manual"
                        ? true
                        : (localMatch?.status === "vault-only" || localMatch?.status === "modified") && !!vaultRoot;
                    if (!showButton) return null;
                    return (
                      <GetLatestButton
                        fileId={f.id}
                        fileName={f.name}
                        folderId={f.folder_id}
                        latestSha={versionsMap.get(f.id)?.[0]?.sha256 ?? null}
                        vaultRoot={vaultRoot ?? null}
                        folders={folders}
                        onDone={onActionComplete}
                        variant={downloadMode}
                      />
                    );
                  })()}
                </div>
              </td>
              {/* Slack-absorbing spacer so the columns above cluster left. */}
              <td aria-hidden />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
