import { useEffect, useState } from "react";
import type { Folder, FolderId } from "../data/types";

interface Props {
  folders: Folder[];
  selected: FolderId | null;
  onSelect: (id: FolderId | null) => void;
}

interface Node {
  folder: Folder;
  children: Node[];
}

function buildTree(folders: Folder[]): Node[] {
  const byParent = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const arr = byParent.get(f.parent_id) ?? [];
    arr.push(f);
    byParent.set(f.parent_id, arr);
  }
  function nodesFor(parentId: string | null): Node[] {
    return (byParent.get(parentId) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ folder: f, children: nodesFor(f.id) }));
  }
  return nodesFor(null);
}

function ancestorsOf(folderId: FolderId, folders: Folder[]): FolderId[] {
  const out: FolderId[] = [];
  let current = folders.find((f) => f.id === folderId);
  while (current?.parent_id) {
    out.push(current.parent_id);
    current = folders.find((f) => f.id === current!.parent_id);
  }
  return out;
}

function FolderIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" fillOpacity="0.85" stroke="currentColor" strokeWidth="0.6" strokeLinejoin="round">
      <path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v.5H3.5a1 1 0 0 0-.97.76L2 8V4Z" />
      <path d="M2.5 13.5l1.2-5.05A1 1 0 0 1 4.67 7.7H14.3a.6.6 0 0 1 .58.74l-1.05 4.5a1 1 0 0 1-.97.76H2.5Z" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" fillOpacity="0.85" stroke="currentColor" strokeWidth="0.6" strokeLinejoin="round">
      <path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4Z" />
    </svg>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      className={"transition-transform duration-150 " + (expanded ? "rotate-90" : "")}
    >
      <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FolderTree({ folders, selected, onSelect }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tree = buildTree(folders);

  // When the selection changes externally (e.g. by clicking from a different
  // screen), auto-expand the chain of ancestor folders so the selected one
  // is visible.
  useEffect(() => {
    if (!selected) return;
    const ancestors = ancestorsOf(selected, folders);
    if (ancestors.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of ancestors) next.add(id);
      return next;
    });
  }, [selected, folders]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleRowClick(node: Node) {
    onSelect(node.folder.id);
    // Selecting a parent also reveals its children; subsequent clicks on the
    // row don't collapse — use the chevron for that.
    if (node.children.length > 0 && !expanded.has(node.folder.id)) {
      setExpanded((prev) => new Set(prev).add(node.folder.id));
    }
  }

  function renderNode(node: Node, depth: number): React.ReactNode {
    const isExpanded = expanded.has(node.folder.id);
    const isSelected = selected === node.folder.id;
    const hasChildren = node.children.length > 0;

    return (
      <div key={node.folder.id}>
        <div
          role="button"
          tabIndex={0}
          aria-current={isSelected ? "page" : undefined}
          onClick={() => handleRowClick(node)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleRowClick(node);
            }
          }}
          className={
            "group flex cursor-pointer items-center gap-1.5 border-l-2 py-1 pr-2 text-sm outline-none transition-colors " +
            "focus-visible:ring-1 focus-visible:ring-yellow-500 " +
            (isSelected
              ? "border-yellow-500 bg-zinc-800 text-zinc-100"
              : "border-transparent text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100")
          }
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          {hasChildren ? (
            <span
              role="none"
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.folder.name}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpanded(node.folder.id);
              }}
              className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
            >
              <Chevron expanded={isExpanded} />
            </span>
          ) : (
            <span className="inline-block w-4 shrink-0" />
          )}
          <span className={"shrink-0 " + (isSelected ? "text-yellow-400" : "text-zinc-500")}>
            <FolderIcon open={isExpanded} />
          </span>
          <span className="truncate">{node.folder.name}</span>
        </div>
        {isExpanded && hasChildren && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  }

  return (
    <div className="flex select-none flex-col gap-0.5 py-2">
      <div
        role="button"
        tabIndex={0}
        aria-current={selected === null ? "page" : undefined}
        onClick={() => onSelect(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(null);
          }
        }}
        className={
          "flex cursor-pointer items-center gap-1.5 border-l-2 px-2 py-1.5 text-xs uppercase tracking-wider outline-none transition-colors " +
          "focus-visible:ring-1 focus-visible:ring-yellow-500 " +
          (selected === null
            ? "border-yellow-500 bg-zinc-800 text-zinc-100"
            : "border-transparent text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300")
        }
      >
        <span className="inline-block w-4 shrink-0" />
        <span>All folders</span>
      </div>
      {tree.length === 0 ? (
        <div className="px-3 py-3 text-xs italic text-zinc-500">No folders yet.</div>
      ) : (
        tree.map((n) => renderNode(n, 0))
      )}
    </div>
  );
}
