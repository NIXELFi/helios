import type { Version, VersionId } from "../data/types";

interface Props {
  versions: Version[];
  onSelect: (id: VersionId) => void;
}

/** Format an ISO timestamp as a short relative-time string ("3h ago",
 *  "2d ago"), falling back to the full locale date+time for old timestamps or
 *  parse errors — never the raw ISO string. */
function formatCreatedAt(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return new Date(iso).toLocaleString();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleString();
}

export function VersionList({ versions, onSelect }: Props) {
  if (versions.length === 0) {
    return <div className="p-3 text-sm text-helios-dim">No versions yet.</div>;
  }
  return (
    <ol className="divide-y divide-helios-line text-sm">
      {versions.map((v) => (
        <li key={v.id}>
          {/* Real, keyboard-accessible button so the clickable affordance
              isn't a mouse-only div. Enter/Space activate it natively. */}
          <button
            type="button"
            onClick={() => onSelect(v.id)}
            className="w-full cursor-pointer px-3 py-2 text-left hover:bg-helios-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-asu-gold"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono-num text-xs text-helios-dim">v{v.version_num}</span>
              <span className="text-xs text-helios-dim" title={v.created_at}>{formatCreatedAt(v.created_at)}</span>
            </div>
            <div className="text-helios-text">{v.comment ?? <em className="text-helios-dim">(no comment)</em>}</div>
          </button>
        </li>
      ))}
    </ol>
  );
}
