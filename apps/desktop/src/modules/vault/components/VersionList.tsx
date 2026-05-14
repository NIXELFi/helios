import type { Version, VersionId } from "../data/types";

interface Props {
  versions: Version[];
  onSelect: (id: VersionId) => void;
}

export function VersionList({ versions, onSelect }: Props) {
  return (
    <ol className="divide-y divide-helios-line text-sm">
      {versions.map((v) => (
        <li
          key={v.id}
          onClick={() => onSelect(v.id)}
          className="cursor-pointer px-3 py-2 hover:bg-helios-panel"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono-num text-xs text-helios-dim">v{v.version_num}</span>
            <span className="text-xs text-helios-dim">{v.created_at}</span>
          </div>
          <div className="text-helios-text">{v.comment ?? <em className="text-helios-dim">(no comment)</em>}</div>
        </li>
      ))}
    </ol>
  );
}
