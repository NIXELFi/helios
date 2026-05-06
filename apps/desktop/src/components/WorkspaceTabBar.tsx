import { useRef, useState } from "react";
import type { Workspace } from "../workspaces/types";
import { SESSION_PALETTE } from "../lib/session";
import { TabContextMenu } from "./TabContextMenu";

export interface WorkspaceTabBarProps {
  workspaces: Workspace[];
  activeId: string;
  appVersion: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, label: string) => void;
  onRecolor: (id: string, hex: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onExport: (id: string) => void;
  onExportAll: () => void;
  onImport: () => void;
}

/** Where to insert a dragged tab given the current mouse-X and the on-screen
 *  rects of every tab. Returns a "gap index" in [0..rects.length]: 0 means
 *  before the first tab, rects.length means after the last. The drop handler
 *  in App.tsx subtracts 1 when moving rightward (because the source is removed
 *  before the insertion happens), so the value here is the **pre-removal**
 *  gap index — see Task 6.3 below for the +/-1 convention. */
export function computeDropIndex(
  rects: Array<Pick<DOMRect, "left" | "right">>,
  mouseX: number,
): number {
  if (mouseX < (rects[0]?.left ?? 0)) return 0;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    const mid = (r.left + r.right) / 2;
    if (mouseX < mid) return i;
  }
  return rects.length;
}

export function WorkspaceTabBar(props: WorkspaceTabBarProps) {
  const { workspaces, activeId, onSelect, onCreate, onImport, onExportAll } = props;

  // Inline rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Drag-reorder state
  const tabRefs = useRef<Array<HTMLElement | null>>([]);
  const [dragSourceIndex, setDragSourceIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // Context menu state
  const [menuFor, setMenuFor] = useState<{ workspaceId: string; x: number; y: number } | null>(null);

  function startRename(w: Workspace) {
    setRenamingId(w.id);
    setRenameValue(w.label);
  }

  function commitRename() {
    if (renamingId === null) return;
    const trimmed = renameValue.trim();
    if (trimmed.length > 0 && trimmed !== workspaces.find((w) => w.id === renamingId)?.label) {
      props.onRename(renamingId, trimmed);
    }
    setRenamingId(null);
  }

  function cancelRename() {
    setRenamingId(null);
  }

  return (
    <div className="ml-2 flex gap-1 items-center">
      <div role="tablist" className="flex gap-1">
        {workspaces.map((w, i) => {
          const active = w.id === activeId;
          return (
            <button
              key={w.id}
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(w.id)}
              ref={(el) => { tabRefs.current[i] = el; }}
              draggable={renamingId !== w.id}
              onDragStart={(e) => {
                setDragSourceIndex(i);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", w.id);
              }}
              onDragOver={(e) => {
                if (dragSourceIndex === null) return;
                e.preventDefault();
                const rects = tabRefs.current
                  .map((el) => el?.getBoundingClientRect())
                  .filter(Boolean) as DOMRect[];
                setDropIndex(computeDropIndex(rects.map((r) => ({ left: r.left, right: r.right })), e.clientX));
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragSourceIndex !== null && dropIndex !== null && dropIndex !== dragSourceIndex && dropIndex !== dragSourceIndex + 1) {
                  const target = dropIndex > dragSourceIndex ? dropIndex - 1 : dropIndex;
                  props.onReorder(dragSourceIndex, target);
                }
                setDragSourceIndex(null);
                setDropIndex(null);
              }}
              onDragEnd={() => { setDragSourceIndex(null); setDropIndex(null); }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuFor({ workspaceId: w.id, x: e.clientX, y: e.clientY });
              }}
              className={
                "flex items-center gap-1.5 px-2 py-0.5 text-xs border rounded-sm cursor-pointer transition-colors " +
                (active
                  ? "bg-[#FFC627] text-[#0E0E10] border-[#FFC627] font-semibold"
                  : "bg-[#16171B] text-[#D8DCE2] border-[#2A2C32] hover:border-[#FFC627]")
              }
            >
              <span
                data-testid="workspace-swatch"
                aria-hidden
                className="inline-block w-2 h-2 rounded-sm"
                style={{ background: w.color }}
              />
              {renamingId === w.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                    else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                  }}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  className="bg-transparent border-b border-current px-0.5 outline-none w-24"
                />
              ) : (
                <span onDoubleClick={(e) => { e.stopPropagation(); startRename(w); }}>{w.label}</span>
              )}
            </button>
          );
        })}
      </div>
      <button
        onClick={onCreate}
        className="ml-1 px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#FFC627] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
        title="Create a new empty workspace"
      >
        + New workspace
      </button>
      <button
        onClick={onImport}
        className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#D8DCE2] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
        title="Import workspaces from a Helios bundle"
      >
        Import…
      </button>
      <button
        onClick={onExportAll}
        className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#D8DCE2] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
        title="Export every workspace to a single file"
      >
        Export all…
      </button>

      {menuFor && (() => {
        const target = workspaces.find((w) => w.id === menuFor.workspaceId);
        if (!target) return null;
        return (
          <TabContextMenu
            anchor={{ x: menuFor.x, y: menuFor.y }}
            canDelete={workspaces.length > 1}
            palette={SESSION_PALETTE}
            onRename={() => startRename(target)}
            onRecolor={(hex) => props.onRecolor(target.id, hex)}
            onDuplicate={() => props.onDuplicate(target.id)}
            onExport={() => props.onExport(target.id)}
            onDelete={() => props.onDelete(target.id)}
            onClose={() => setMenuFor(null)}
          />
        );
      })()}
    </div>
  );
}
