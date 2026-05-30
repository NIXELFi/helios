import { useContains, useWhereUsed } from "../data/useReferences";
import type { FileId, VersionId } from "../data/types";

interface Props {
  /** Latest version of the selected file — its children ("Contains"). */
  versionId: VersionId | null;
  /** The selected file — its parents ("Where Used"). */
  fileId: FileId | null;
}

/** SW-PDM Contains / Where-Used for the selected file's latest version. */
export function ReferencesPanel({ versionId, fileId }: Props) {
  const contains = useContains(versionId);
  const whereUsed = useWhereUsed(fileId);
  return (
    <div className="border-t border-helios-line text-sm">
      <section className="p-3">
        <h4 className="mb-1 text-xs uppercase tracking-wider text-helios-dim">Contains</h4>
        {!contains.data || contains.data.length === 0 ? (
          <p className="text-helios-dim">No references.</p>
        ) : (
          <ul className="space-y-0.5">
            {contains.data.map((c) => (
              <li key={c.childPathHint} className={c.resolved ? "text-helios-text" : "italic text-helios-dim"}>
                {c.childName}{!c.resolved && " (unresolved)"}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="p-3">
        <h4 className="mb-1 text-xs uppercase tracking-wider text-helios-dim">Where Used</h4>
        {!whereUsed.data || whereUsed.data.length === 0 ? (
          <p className="text-helios-dim">Not used by any assembly.</p>
        ) : (
          <ul className="space-y-0.5">
            {whereUsed.data.map((w) => (
              <li key={w.parentVersionId} className="text-helios-text">{w.parentName}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
