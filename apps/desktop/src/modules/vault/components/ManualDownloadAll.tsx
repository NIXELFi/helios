import { useBulkDownload } from "../data/useBulkDownload";
import { BulkDownloadModal } from "./BulkDownloadModal";
import type { FileId, Folder, VaultFile, Version } from "../data/types";

interface Props {
  files: VaultFile[];
  versionsByFileId: Map<FileId, Version[]>;
  vaultRoot: string | null;
  folders: Folder[];
  onDone?: () => void;
}

/**
 * Button + modal that downloads every file in the current view. Thin
 * wrapper around `useBulkDownload` so the right-click context menu can
 * share the same machinery via the headless hook.
 */
export function ManualDownloadAll({ files, versionsByFileId, vaultRoot, folders, onDone }: Props) {
  const api = useBulkDownload({ vaultRoot, folders, versionsByFileId, onDone });
  const downloadableCount = files.filter((f) => {
    const v = versionsByFileId.get(f.id)?.[0];
    return v && v.sha256;
  }).length;
  if (downloadableCount === 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => api.start(files)}
        disabled={api.running}
        className="rounded border border-helios-line bg-helios-base px-2 py-0.5 text-xs text-helios-text hover:bg-helios-line disabled:opacity-50"
        title={
          vaultRoot
            ? `Download all ${downloadableCount} files in this view to ${vaultRoot}`
            : `Download all ${downloadableCount} files — you'll be prompted for a destination`
        }
      >
        Download all ({downloadableCount})
      </button>
      <BulkDownloadModal api={api} />
    </>
  );
}
