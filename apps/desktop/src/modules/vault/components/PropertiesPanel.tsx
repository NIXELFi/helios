import { useEffect, useState } from "react";
import { useRecordProperties } from "../data/useRecordProperties";
import { localDestPath } from "../data/folder-paths";
import type { Folder, FolderId, SwProperty, Version } from "../data/types";

interface Props {
  /** Latest version of the selected file (its data card). */
  version: Version | null;
  fileName: string | null;
  folderId: FolderId | null;
  vaultRoot: string | null;
  folders: Folder[];
  /** Editors get lazy backfill — parsing the local copy to populate missing
   *  properties. Viewers just see whatever's stored. */
  canEdit: boolean;
}

/** SolidWorks custom properties (data card) for the selected file's latest
 *  version. If none are stored yet and an editor is viewing, we lazily parse
 *  the local working copy and store + show them. */
export function PropertiesPanel({ version, fileName, folderId, vaultRoot, folders, canEdit }: Props) {
  const record = useRecordProperties();
  const [props, setProps] = useState<SwProperty[] | null>(version?.properties ?? null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setProps(version?.properties ?? null);
    if (version && version.properties == null && canEdit && vaultRoot && fileName) {
      const dest = localDestPath(vaultRoot, folderId, fileName, folders);
      let alive = true;
      setLoading(true);
      record.run(version.id, dest, fileName)
        .then((p) => { if (alive && p && p.length > 0) setProps(p); })
        .finally(() => { if (alive) setLoading(false); });
      return () => { alive = false; };
    }
    // Only re-run when the selected version changes; the other inputs are
    // stable for a given selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version?.id]);

  if (!version) return null;
  return (
    <div className="border-t border-helios-line text-sm">
      <section className="p-3">
        <h4 className="mb-1 text-xs uppercase tracking-wider text-helios-dim">Properties</h4>
        {loading && (!props || props.length === 0) ? (
          <p className="text-helios-dim">Reading…</p>
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
