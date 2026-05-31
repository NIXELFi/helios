import type { ReactNode } from "react";
import { useFileProperties } from "../data/useFileProperties";
import { localDestPath } from "../data/folder-paths";
import type { Folder, FolderId, SwProperty, Version } from "../data/types";

interface Props {
  /** Latest version of the selected file (its data card). */
  version: Version | null;
  fileName: string | null;
  folderId: FolderId | null;
  vaultRoot: string | null;
  folders: Folder[];
}

// Card fields fall into three groups so the (now much richer) card reads as
// organized sections rather than one long flat list. Anything not named here is
// a modeler-entered custom field and lands in "Properties".
const PHYSICAL = ["Mass", "Volume", "Surface Area", "Center of Mass"];
const FILE_META = ["Configuration", "Last Saved By"];

function Rows({ title, rows }: { title: string; rows: SwProperty[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="px-3 py-2.5">
      <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-helios-dim">{title}</h4>
      <dl className="space-y-1">
        {rows.map((p) => (
          <div key={p.name} className="flex gap-3">
            <dt className="w-28 shrink-0 truncate text-helios-dim" title={p.name}>{p.name}</dt>
            <dd className="flex-1 break-words text-helios-text tabular-nums">{p.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-3 py-2.5">
      <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-helios-dim">{title}</h4>
      {children}
    </section>
  );
}

/** SolidWorks data card for the selected file's latest version. Resolves from
 *  the Supabase cache or the local copy (never forces a download) and presents
 *  the fields in three groups: computed Physical properties (mass / volume /
 *  surface area / CG), the modeler's custom Properties, and File metadata. */
export function PropertiesPanel({ version, fileName, folderId, vaultRoot, folders }: Props) {
  const localPath = vaultRoot && fileName ? localDestPath(vaultRoot, folderId, fileName, folders) : null;
  const { props, loading, notDownloaded } = useFileProperties(version, localPath, fileName);

  if (!version) return null;

  const all = props ?? [];
  const physical = PHYSICAL.map((n) => all.find((p) => p.name === n)).filter((p): p is SwProperty => !!p);
  const meta = FILE_META.map((n) => all.find((p) => p.name === n)).filter((p): p is SwProperty => !!p);
  const custom = all.filter((p) => !PHYSICAL.includes(p.name) && !FILE_META.includes(p.name));
  const hasAny = physical.length + meta.length + custom.length > 0;

  return (
    <div className="divide-y divide-helios-line border-t border-helios-line text-sm">
      {loading ? (
        <Note title="Properties"><p className="text-helios-dim">Reading…</p></Note>
      ) : notDownloaded ? (
        <Note title="Properties">
          <p className="italic text-helios-dim">Not downloaded — download this file to read its properties.</p>
        </Note>
      ) : !hasAny ? (
        <Note title="Properties"><p className="text-helios-dim">No custom properties.</p></Note>
      ) : (
        <>
          <Rows title="Physical" rows={physical} />
          <Rows title="Properties" rows={custom} />
          <Rows title="File" rows={meta} />
        </>
      )}
    </div>
  );
}
