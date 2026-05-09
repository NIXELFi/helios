import type { Version, VersionId } from "../data/types";

interface Props {
  versions: Version[];
  onSelect: (id: VersionId) => void;
}

export function VersionList({ versions, onSelect }: Props) {
  return (
    <ol className="divide-y divide-zinc-800 text-sm">
      {versions.map((v) => (
        <li
          key={v.id}
          onClick={() => onSelect(v.id)}
          className="cursor-pointer px-3 py-2 hover:bg-zinc-900"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-zinc-400">v{v.version_num}</span>
            <span className="text-xs text-zinc-500">{v.created_at}</span>
          </div>
          <div className="text-zinc-100">{v.comment ?? <em className="text-zinc-500">(no comment)</em>}</div>
        </li>
      ))}
    </ol>
  );
}
