import { useState } from "react";
import type { LoadedSession } from "../lib/session";

interface Props {
  sessions: LoadedSession[];
  primaryId: string;
  onToggleVisibility: (id: string) => void;
  onSetPrimary: (id: string) => void;
}

export function SessionPanel({ sessions, primaryId, onToggleVisibility, onSetPrimary }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <aside className="w-8 flex-shrink-0 border-r border-[#2A2C32] bg-[#0E0E10] flex flex-col items-center pt-2">
        <button
          aria-label="Expand sessions panel"
          onClick={() => setCollapsed(false)}
          className="w-6 h-6 flex items-center justify-center text-[#7B8088] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
          title="Sessions"
        >
          ›
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-56 flex-shrink-0 border-r border-[#2A2C32] bg-[#0E0E10] flex flex-col">
      <div className="h-8 flex items-center justify-between px-2 border-b border-[#2A2C32]">
        <span className="text-[10px] uppercase tracking-wider text-[#7B8088]">Sessions</span>
        <button
          aria-label="Collapse sessions panel"
          onClick={() => setCollapsed(true)}
          className="w-5 h-5 flex items-center justify-center text-[#7B8088] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
          title="Collapse"
        >
          ‹
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {sessions.map((s) => {
          const isPrimary = s.id === primaryId;
          return (
            <div
              key={s.id}
              className={
                "flex items-center gap-2 px-2 py-1 cursor-pointer text-xs " +
                (isPrimary ? "bg-[#16171B]" : "hover:bg-[#16171B]")
              }
              onClick={() => { if (s.visible) onSetPrimary(s.id); }}
              title={s.visible ? "Click to make primary" : "Enable visibility first"}
            >
              <input
                type="checkbox"
                checked={s.visible}
                onChange={(e) => { e.stopPropagation(); onToggleVisibility(s.id); }}
                onClick={(e) => e.stopPropagation()}
                className="cursor-pointer accent-[#FFC627]"
              />
              <span
                className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                style={{ background: s.color }}
                aria-hidden
              />
              <span className={"flex-1 truncate " + (s.visible ? "text-[#D8DCE2]" : "text-[#5A5F66]")}>
                {s.label}
              </span>
              {isPrimary && (
                <span className="text-[9px] uppercase tracking-wider text-[#FFC627] flex-shrink-0">primary</span>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
