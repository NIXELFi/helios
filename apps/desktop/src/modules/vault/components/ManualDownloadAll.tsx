import { useBulkDownload } from "../data/useBulkDownload";
import { sanitizeVaultName } from "../data/useVaultFolder";
import { BulkDownloadModal } from "./BulkDownloadModal";
import type { FileId, Folder, VaultFile, Version } from "../data/types";

interface Props {
  files: VaultFile[];
  versionsByFileId: Map<FileId, Version[]>;
  /** Shared Helios folder root (user picked in Settings). */
  heliosRoot: string | null;
  /** Active vault name — files land in `<heliosRoot>/<vaultName>/...`. */
  vaultName: string | null;
  folders: Folder[];
  /** Forwarded to the hook so a prompted parent picks gets saved. */
  onPickedRoot?: (root: string) => void;
  onDone?: () => void;
}

/**
 * Button + modal that downloads every file in the current view. Thin
 * wrapper around `useBulkDownload` so the right-click context menu can
 * share the same machinery via the headless hook.
 */
export function ManualDownloadAll({
  files,
  versionsByFileId,
  heliosRoot,
  vaultName,
  folders,
  onPickedRoot,
  onDone,
}: Props) {
  const api = useBulkDownload({
    heliosRoot,
    vaultName,
    folders,
    versionsByFileId,
    onPickedRoot,
    onDone,
  });
  const downloadableCount = files.filter((f) => {
    const v = versionsByFileId.get(f.id)?.[0];
    return v && v.sha256;
  }).length;
  if (downloadableCount === 0) return null;
  // Files actually land under `sanitizeVaultName(vaultName)` (see
  // useBulkDownload.ts / useVaultFolder.ts), so the shown destination must
  // sanitize too — otherwise it claims a path that won't exist on disk.
  const effective = heliosRoot && vaultName
    ? `${heliosRoot.replace(/\/+$/, "")}/${sanitizeVaultName(vaultName)}`
    : null;
  return (
    <>
      <button
        type="button"
        onClick={() => api.start(files)}
        disabled={api.running}
        className="rounded border border-helios-line bg-helios-base px-2 py-0.5 text-xs text-helios-text hover:bg-helios-line disabled:opacity-50"
        title={
          effective
            ? `Download all ${downloadableCount} files in this view to ${effective}`
            : `Download all ${downloadableCount} files — you'll be prompted for a destination`
        }
      >
        Download all ({downloadableCount})
      </button>
      <BulkDownloadModal api={api} />
    </>
  );
}
