import { useEffect, useRef, useState } from "react";
import { formatLapTime } from "@helios/lib";
import type { LapRef, LapSelection, LapSelectionEmitter } from "@helios/lib";
import type { LoadedSession } from "../lib/session";
import { SESSION_PALETTE } from "../lib/session";
import { MOD_KEY } from "../lib/platform";

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
  /** Give a session a custom display label (double-click the row label).
   *  `null` clears the override, falling back to the filename-derived one.
   *  App.tsx owns the persist + re-apply. */
  onRenameSession: (id: string, label: string | null) => void;
  /** Pin a session's trace color (click the swatch). `null` clears the
   *  override, returning it to its positional palette color. */
  onRecolorSession: (id: string, color: string | null) => void;
  /** Lap-selection bus shared with lap-panel widget. Sidebar lap list reads
   *  + writes through the same emitter so Main/Ref highlighting stays
   *  in sync wherever it's surfaced. */
  lapSelectionEmitter: LapSelectionEmitter;
  lapSelection: LapSelection;
}

export function SessionPanel({
  sessions, primaryId, onToggleVisibility, onSetPrimary, onConfigureLaps,
  onAddSession, onRemoveSession, onRenameSession, onRecolorSession,
  lapSelectionEmitter, lapSelection,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Inline rename state — same shape as WorkspaceTabBar's tab rename.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const primary = sessions.find((s) => s.id === primaryId) ?? null;

  function startRename(s: LoadedSession) {
    // If a rename is already in flight on another row, commit it against the
    // row it was started for BEFORE retargeting: the outgoing input's onBlur
    // fires as focus moves to the new one and would otherwise commit its text
    // under the new id.
    if (renamingId !== null && renamingId !== s.id) commitRename();
    setRenamingId(s.id);
    setRenameValue(s.label);
  }

  /** Commit the rename for a SPECIFIC id (captured at the call site so a
   *  concurrent target switch can't redirect it). Committing empty text — or
   *  text equal to the filename-derived label — CLEARS the override rather
   *  than storing a redundant one; that's the discoverable way back to "auto".
   *  No-ops when the text is unchanged so we don't churn localStorage. */
  function commitRename(id: string | null = renamingId) {
    if (id === null || renamingId !== id) return;
    const target = sessions.find((s) => s.id === id);
    if (target) {
      const base = target.defaultLabel ?? target.label;
      const trimmed = renameValue.trim();
      const next = trimmed.length === 0 || trimmed === base ? null : trimmed;
      const current = target.label === base ? null : target.label;
      if (next !== current) onRenameSession(id, next);
    }
    setRenamingId((cur) => (cur === id ? null : cur));
  }

  function cancelRename(id: string | null = renamingId) {
    setRenamingId((cur) => (cur === id ? null : cur));
  }

  if (collapsed) {
    return (
      <aside className="w-8 flex-shrink-0 border-r border-[#2A2C32] bg-[#0E0E10] flex flex-col items-center pt-2">
        <button
          aria-label="Expand sessions panel"
          onClick={() => setCollapsed(false)}
          className="w-6 h-6 flex items-center justify-center text-[#9097A0] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
          title="Sessions"
        >›</button>
      </aside>
    );
  }

  return (
    <aside className="w-60 flex-shrink-0 border-r border-[#2A2C32] bg-[#0E0E10] flex flex-col">
      <div className="h-8 flex items-center justify-between px-2 border-b border-[#2A2C32]">
        <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">Sessions</span>
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
            className="w-5 h-5 flex items-center justify-center text-[#9097A0] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
            title="Collapse"
          >‹</button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {sessions.map((s) => {
          const isPrimary = s.id === primaryId;
          const isExpanded = s.id === expandedId;
          const isRenaming = s.id === renamingId;
          // The loader-derived label, kept by applySessionMeta. When it differs
          // from the live label the user has renamed this session, and the
          // tooltip should still name the file it came from.
          const baseLabel = s.defaultLabel ?? s.label;
          const isRenamed = s.label !== baseLabel;
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
                title={s.visible
                  ? "Click to make primary · double-click the name to rename"
                  : "Enable visibility first"}
              >
                <input
                  type="checkbox"
                  checked={s.visible}
                  onChange={(e) => { e.stopPropagation(); onToggleVisibility(s.id); }}
                  onClick={(e) => e.stopPropagation()}
                  className="cursor-pointer accent-[#FFC627]"
                />
                <SessionSwatch session={s} onPick={(hex) => onRecolorSession(s.id, hex)} />
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameValue}
                    aria-label={`Rename ${baseLabel}`}
                    onChange={(e) => setRenameValue(e.target.value)}
                    // Select-all on focus: renaming usually means replacing,
                    // not appending.
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault(); e.stopPropagation(); commitRename(s.id);
                      } else if (e.key === "Escape") {
                        e.preventDefault(); e.stopPropagation(); cancelRename(s.id);
                      }
                    }}
                    onBlur={() => commitRename(s.id)}
                    // The row sets primary on click and expands on
                    // double-click-ish interactions; neither should fire while
                    // the user is editing text inside it.
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className="flex-1 min-w-0 bg-[#0B0B0D] border border-[#FFC627] text-[#D8DCE2] rounded-sm px-1 outline-none text-xs"
                  />
                ) : (
                  <span
                    title={isRenamed ? `${s.label} — renamed from "${baseLabel}"` : s.label}
                    onDoubleClick={(e) => { e.stopPropagation(); startRename(s); }}
                    className={"flex-1 truncate " + (s.visible ? "text-[#D8DCE2]" : "text-[#5A5F66]")}
                  >
                    {s.label}
                  </span>
                )}
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
                    <span className="text-[#9097A0] uppercase tracking-wider">Laps</span>
                    <span className="text-[#D8DCE2]">
                      {s.lapConfig.mode === "none"
                        ? <span className="text-[#9097A0]">not configured</span>
                        : `${lapCount} trusted${bestLap ? ` · best ${formatLapTime(bestLap.durationS * 1_000_000)}` : ""}`}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#9097A0] uppercase tracking-wider">Mode</span>
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
      <SidebarLapList
        primary={primary}
        emitter={lapSelectionEmitter}
        selection={lapSelection}
      />
      <div className="px-2 py-1.5 border-t border-[#2A2C32] text-[10px] text-[#5A5F66]">
        Drag CSVs anywhere to add. + to browse.
      </div>
    </aside>
  );
}

/** The session's color chip, plus the recolor popover it opens: the eight
 *  SESSION_PALETTE entries and an "auto" button that clears the override so
 *  the session goes back to its positional color.
 *
 *  Open state is deliberately LOCAL rather than lifted to a single
 *  `openSwatchId` in the panel. Two rows can't actually end up open at once —
 *  mousing down on row B's swatch trips row A's click-outside listener first —
 *  and keeping it local means the effect's deps don't churn on every parent
 *  render. Click-outside + Esc follow App.tsx's ExportMenuButton idiom.
 *
 *  Everything here stopPropagation's: this sits inside the row, whose click
 *  handler sets the primary session. */
function SessionSwatch({ session, onPick }: {
  session: LoadedSession;
  onPick: (hex: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(hex: string | null) {
    onPick(hex);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative flex-shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={`Change color for ${session.label}`}
        aria-expanded={open}
        title="Change trace color"
        onClick={() => setOpen((o) => !o)}
        className="w-4 h-4 flex items-center justify-center rounded-sm cursor-pointer hover:bg-[#2A2C32]"
      >
        <span className="w-2.5 h-2.5 rounded-sm block" style={{ background: session.color }} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 bg-[#0E0E10] border border-[#2A2C32] p-1.5 w-[132px]">
          <div className="grid grid-cols-4 gap-1">
            {SESSION_PALETTE.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={`Set color ${hex}`}
                title={hex}
                onClick={() => pick(hex)}
                className={
                  "w-6 h-5 rounded-sm cursor-pointer border " +
                  (session.color.toLowerCase() === hex.toLowerCase()
                    ? "border-[#D8DCE2]"
                    : "border-transparent hover:border-[#FFC627]")
                }
                style={{ background: hex }}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => pick(null)}
            className="mt-1.5 w-full px-1 py-0.5 text-[10px] text-[#9097A0] border border-[#2A2C32] rounded-sm cursor-pointer hover:border-[#FFC627] hover:text-[#FFC627]"
            title="Clear the pinned color — back to the automatic color for this slot"
          >auto</button>
        </div>
      )}
    </div>
  );
}

function SidebarLapList({ primary, emitter, selection }: {
  primary: LoadedSession | null;
  emitter: LapSelectionEmitter;
  selection: LapSelection;
}) {
  const [sel, setSel] = useState(selection);
  useEffect(() => emitter.subscribe(setSel), [emitter]);

  if (!primary || !primary.laps || primary.laps.laps.length === 0) {
    return null;
  }

  const all = primary.laps.laps;
  const trustedTimes = all.filter((l) => l.trusted).map((l) => l.durationS);
  const best = trustedTimes.length === 0 ? null : Math.min(...trustedTimes);
  // Drive the star from the authoritative bestLapIndex (matches the rest of the
  // app) rather than fragile float === equality on durationS, which can tag the
  // wrong row (or none) when two laps share a rounded time.
  const bestIndex = primary.laps.bestLapIndex;

  function isMain(ref: LapRef) {
    return !!sel.main && sel.main.sessionId === ref.sessionId && sel.main.lapIndex === ref.lapIndex;
  }
  function isRef(ref: LapRef) {
    return !!sel.ref && sel.ref.sessionId === ref.sessionId && sel.ref.lapIndex === ref.lapIndex;
  }
  function isOverlay(ref: LapRef) {
    return sel.overlays.some((r) => r.sessionId === ref.sessionId && r.lapIndex === ref.lapIndex);
  }
  function selectLap(ref: LapRef, e: React.MouseEvent) {
    if (e.metaKey || e.ctrlKey) emitter.setRef(ref);
    else if (e.shiftKey) emitter.toggleOverlay(ref);
    else emitter.setMain(ref);
  }

  return (
    <div className="border-t border-[#2A2C32] flex flex-col min-h-0 max-h-[40%]">
      <div className="h-7 flex items-center justify-between px-2 border-b border-[#2A2C32] flex-shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">Laps</span>
        <span className="text-[9px] text-[#5A5F66]">{trustedTimes.length} trusted</span>
      </div>
      <div className="overflow-y-auto flex-1">
        <table className="w-full text-xs font-mono-num">
          <tbody>
            {all.map((lap, i) => {
              const ref: LapRef = { sessionId: primary.id, lapIndex: i };
              const isBest = bestIndex >= 0 && i === bestIndex;
              const dt = best !== null ? lap.durationS - best : 0;
              const main = isMain(ref);
              const refSel = isRef(ref);
              const overlay = isOverlay(ref);
              return (
                <tr
                  key={i}
                  onClick={(e) => selectLap(ref, e)}
                  className={
                    "border-b border-[#16171B] cursor-pointer " +
                    (main ? "bg-[#1F1F23] " : refSel ? "bg-[#16191F] " : overlay ? "bg-[#13141A] " : "hover:bg-[#0E0E10] ") +
                    (!lap.trusted ? "text-[#5A5F66]" : "text-[#D8DCE2]")
                  }
                  title="Row click sets Main. Use the M / R / O buttons on the right for explicit control."
                >
                  <td className="px-2 py-0.5 w-8">
                    {lap.index}
                    {isBest && <span className="ml-0.5 text-[#FFC627]">★</span>}
                  </td>
                  <td className={"text-right px-2 py-0.5 " + (isBest ? "text-[#FFC627] font-bold" : "")}>
                    {formatLapTime(lap.durationS * 1_000_000)}
                  </td>
                  <td className="text-right px-2 py-0.5 text-[#9097A0] w-12">
                    {dt === 0 ? "—" : `+${dt.toFixed(2)}`}
                  </td>
                  <td className="text-right px-1 py-0 w-[64px]">
                    <div className="inline-flex items-center gap-px">
                      <LapToggleBtn
                        letter="M"
                        active={main}
                        activeColor="#FFC627"
                        title="Set as Main lap (or row click)"
                        onClick={(e) => { e.stopPropagation(); emitter.setMain(main ? null : ref); }}
                      />
                      <LapToggleBtn
                        letter="R"
                        active={refSel}
                        activeColor="#4FC3F7"
                        title={`Set as Ref lap (also ${MOD_KEY}+click row)`}
                        onClick={(e) => { e.stopPropagation(); emitter.setRef(refSel ? null : ref); }}
                      />
                      <LapToggleBtn
                        letter="O"
                        active={overlay}
                        activeColor="#9CCC65"
                        title="Toggle overlay (also shift+click row)"
                        onClick={(e) => { e.stopPropagation(); emitter.toggleOverlay(ref); }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LapToggleBtn({
  letter, active, activeColor, title, onClick,
}: {
  letter: string;
  active: boolean;
  activeColor: string;
  title: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={
        "w-[18px] h-[16px] flex items-center justify-center text-[10px] font-mono-num leading-none rounded-sm cursor-pointer transition-colors " +
        (active ? "text-helios-base font-bold" : "text-helios-dim hover:text-helios-text hover:bg-helios-panel")
      }
      style={active ? { background: activeColor } : undefined}
    >
      {letter}
    </button>
  );
}
