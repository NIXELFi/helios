import { useVersions } from "../data/useVersions";
import { VersionList } from "../components/VersionList";
import type { FileId } from "../data/types";

export function FileDetailPanel({ fileId }: { fileId: FileId | null }) {
  if (!fileId) {
    return (
      <aside className="flex h-full w-80 items-center justify-center border-l border-helios-line bg-helios-base p-4 text-sm text-helios-dim">
        Select a file to see its history.
      </aside>
    );
  }
  return <FileDetailLoader fileId={fileId} />;
}

function FileDetailLoader({ fileId }: { fileId: FileId }) {
  const { data, loading, error } = useVersions(fileId);
  return (
    <aside className="flex h-full w-80 flex-col border-l border-helios-line bg-helios-base">
      <header className="border-b border-helios-line px-3 py-2 text-xs uppercase tracking-wider text-helios-dim">
        History
      </header>
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-3 text-sm text-helios-dim">Loading…</div>
        ) : error ? (
          <div className="p-3 text-sm text-[#EF5350]">{error.message}</div>
        ) : !data || data.length === 0 ? (
          <div className="p-3 text-sm text-helios-dim">No versions yet.</div>
        ) : (
          <VersionList versions={data} onSelect={() => {}} />
        )}
      </div>
    </aside>
  );
}
