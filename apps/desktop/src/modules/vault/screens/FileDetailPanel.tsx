import { useVersions } from "../data/useVersions";
import { VersionList } from "../components/VersionList";
import type { FileId } from "../data/types";

export function FileDetailPanel({ fileId }: { fileId: FileId | null }) {
  if (!fileId) {
    return (
      <aside className="flex h-full w-80 items-center justify-center border-l border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-500">
        Select a file to see its history.
      </aside>
    );
  }
  return <FileDetailLoader fileId={fileId} />;
}

function FileDetailLoader({ fileId }: { fileId: FileId }) {
  const { data, loading, error } = useVersions(fileId);
  return (
    <aside className="flex h-full w-80 flex-col border-l border-zinc-800 bg-zinc-950">
      <header className="border-b border-zinc-800 px-3 py-2 text-xs uppercase tracking-wider text-zinc-500">
        History
      </header>
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-3 text-sm text-zinc-500">Loading…</div>
        ) : error ? (
          <div className="p-3 text-sm text-red-400">{error.message}</div>
        ) : !data || data.length === 0 ? (
          <div className="p-3 text-sm text-zinc-500">No versions yet.</div>
        ) : (
          <VersionList versions={data} onSelect={() => {}} />
        )}
      </div>
    </aside>
  );
}
