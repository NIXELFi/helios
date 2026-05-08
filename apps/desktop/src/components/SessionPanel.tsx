import { useState } from "react";
import { formatLapTime } from "@helios/lib";
import type { LoadedSession } from "../lib/session";

interface Props {
  sessions: LoadedSession[];
  primaryId: string;
  onToggleVisibility: (id: string) => void;
  onSetPrimary: (id: string) => void;
  /** Open the lap-detection dialog for this session. App.tsx owns the modal
   *  state since the dialog dispatches recompute + math re-apply. */
  onConfigureLaps: (id: string) => void;
  /** Open a native file picker; files chosen there get loaded as new
   *  sessions. App.tsx owns the load + persist + math re-apply. */
  onAddSession: () => void;
  /** Remove a session from the active list. App.tsx confirms before
   *  applying. Bundled samples reappear on next launch; user-loaded files
   *  stay on disk. */
  onRemoveSession: (id: string) => void;
}

export function SessionPanel({
  sessions, primaryId, onToggleVisibility, onSetPrimary, onConfigureLaps,
  onAddSession, onRemoveSession,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (collapsed) {
    return (
      <aside className="w-8 flex-shrink-0 border-r border-[#2A2C32] bg-[#0E0E10] flex flex-col items-center pt-2">
        <button
          aria-label="Expand sessions panel"
          onClick={() => setCollapsed(false)}
          className="w-6 h-6 flex items-center justify-center text-[#7B8088] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
          title="Sessions"
        >›</button>
      </aside>
    );
  }

  return (
    <aside className="w-60 flex-shrink-0 border-r border-[#2A2C32] bg-[#0E0E10] flex flex-col">
      <div className="h-8 flex items-center justify-between px-2 border-b border-[#2A2C32]">
        <span className="text-[10px] uppercase tracking-wider text-[#7B8088]">Sessions</span>
        <div className="flex items-center gap-1">
          <button
            aria-label="Add session"
            onClick={onAddSession}
            className="w-5 h-5 flex items-center justify-center text-[#FFC627] hover:bg-[#16171B] rounded-sm font-bold"
            title="Add CSV file(s) — drag-and-drop also works"
          >+</button>
          <button
            aria-label="Collapse sessions panel"
            onClick={() => setCollapsed(true)}
            className="w-5 h-5 flex items-center justify-center text-[#7B8088] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
            title="Collapse"
          >‹</button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {sessions.map((s) => {
          const isPrimary = s.id === primaryId;
          const isExpanded = s.id === expandedId;
          const lapCount = s.laps?.laps.filter((l) => l.trusted).length ?? 0;
          const bestLap = s.laps && s.laps.bestLapIndex >= 0 ? s.laps.laps[s.laps.bestLapIndex] : null;
          return (
            <div key={s.id} className="border-b border-[#16171B] last:border-b-0 group">
              <div
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
                <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: s.color }} aria-hidden />
                <span className={"flex-1 truncate " + (s.visible ? "text-[#D8DCE2]" : "text-[#5A5F66]")}>
                  {s.label}
                </span>
                {isPrimary && (
                  <span className="text-[9px] uppercase tracking-wider text-[#FFC627] flex-shrink-0">primary</span>
                )}
                <button
                  aria-label="Remove session"
                  className="text-[#5A5F66] opacity-0 group-hover:opacity-100 hover:text-[#EF5350] text-[12px] flex-shrink-0 px-1 transition-opacity"
                  onClick={(e) => { e.stopPropagation(); onRemoveSession(s.id); }}
                  title="Remove from session list"
                >×</button>
                <button
                  className="text-[#5A5F66] hover:text-[#FFC627] text-[10px] flex-shrink-0 px-1"
                  onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : s.id); }}
                  title="Show lap detection details"
                >{isExpanded ? "▼" : "▶"}</button>
              </div>
              {isExpanded && (
                <div className="px-3 py-1.5 bg-[#0B0B0D] flex flex-col gap-1.5 text-[10px]">
                  <div className="flex items-center justify-between">
                    <span className="text-[#7B8088] uppercase tracking-wider">Laps</span>
                    <span className="text-[#D8DCE2]">
                      {s.lapConfig.mode === "none"
                        ? <span className="text-[#7B8088]">not configured</span>
                        : `${lapCount} trusted${bestLap ? ` · best ${formatLapTime(bestLap.durationS * 1_000_000)}` : ""}`}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#7B8088] uppercase tracking-wider">Mode</span>
                    <span className="text-[#9AA0A6] font-mono-num">{s.lapConfig.mode}</span>
                  </div>
                  <button
                    onClick={() => onConfigureLaps(s.id)}
                    className="self-stretch px-2 py-0.5 text-[10px] border border-[#2A2C32] hover:border-[#FFC627] hover:text-[#FFC627] mt-1"
                  >Configure lap detection…</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="px-2 py-1.5 border-t border-[#2A2C32] text-[10px] text-[#5A5F66]">
        Drag CSVs anywhere to add. + to browse.
      </div>
    </aside>
  );
}
