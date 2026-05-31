import { useFileProperties } from "../data/useFileProperties";
import { localDestPath } from "../data/folder-paths";
import type { Folder, FolderId, Version } from "../data/types";

interface Props {
  /** Latest version of the selected file (its data card). */
  version: Version | null;
  fileName: string | null;
  folderId: FolderId | null;
  vaultRoot: string | null;
  folders: Folder[];
}

/** SolidWorks custom properties (data card) for the selected file's latest
 *  version. Resolves from the backend cache, the local copy, or by downloading
 *  + parsing — so it works for both downloaded and not-yet-downloaded files,
 *  for any user. */
export function PropertiesPanel({ version, fileName, folderId, vaultRoot, folders }: Props) {
  const localPath = vaultRoot && fileName ? localDestPath(vaultRoot, folderId, fileName, folders) : null;
  const { props, loading, notDownloaded } = useFileProperties(version, localPath, fileName);

  if (!version) return null;
  return (
    <div className="border-t border-helios-line text-sm">
      <section className="p-3">
        <h4 className="mb-1 text-xs uppercase tracking-wider text-helios-dim">Properties</h4>
        {loading ? (
          <p className="text-helios-dim">Reading…</p>
        ) : notDownloaded ? (
          <p className="text-helios-dim italic">Not downloaded — download this file to read its properties.</p>
        ) : !props || props.length === 0 ? (
          <p className="text-helios-dim">No custom properties.</p>
        ) : (
          <dl className="space-y-0.5">
            {props.map((p) => (
              <div key={p.name} className="flex gap-2">
                <dt className="w-32 shrink-0 truncate text-helios-dim" title={p.name}>{p.name}</dt>
                <dd className="flex-1 break-words text-helios-text">{p.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </div>
  );
}
