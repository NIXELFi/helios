import { useState } from "react";
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
    const key = f.parent_id;
    const arr = byParent.get(key) ?? [];
    arr.push(f);
    byParent.set(key, arr);
  }
  function nodesFor(parentId: string | null): Node[] {
    return (byParent.get(parentId) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ folder: f, children: nodesFor(f.id) }));
  }
  return nodesFor(null);
}

export function FolderTree({ folders, selected, onSelect }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tree = buildTree(folders);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderNode(node: Node, depth: number): React.ReactNode {
    const isExpanded = expanded.has(node.folder.id);
    const hasChildren = node.children.length > 0;
    return (
      <div key={node.folder.id}>
        <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
          {hasChildren ? (
            <span
              role="none"
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.folder.name}`}
              onClick={(e) => { e.stopPropagation(); toggleExpanded(node.folder.id); }}
              className="mr-1 inline-block w-4 cursor-pointer text-xs text-zinc-500 hover:text-zinc-200"
            >
              {isExpanded ? "▾" : "▸"}
            </span>
          ) : (
            <span className="mr-1 inline-block w-4" />
          )}
          <button
            type="button"
            onClick={() => onSelect(node.folder.id)}
            aria-current={selected === node.folder.id ? "page" : undefined}
            className={
              "flex-1 truncate rounded px-2 py-0.5 text-left text-sm " +
              (selected === node.folder.id
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-300 hover:bg-zinc-900")
            }
          >
            {node.folder.name}
          </button>
        </div>
        {isExpanded ? node.children.map((c) => renderNode(c, depth + 1)) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 p-2">{tree.map((n) => renderNode(n, 0))}</div>
  );
}
