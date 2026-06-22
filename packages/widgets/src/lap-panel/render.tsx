import { useEffect, useState } from "react";
import { formatLapTime } from "@helios/lib";
import type { Lap, LapRef } from "@helios/lib";
import type { WidgetRenderProps, OverlaySession } from "../types";

export interface LapEntry { number: number; time_ms: number; }
export interface LapPanelConfig {
  /** Legacy static laps used when no detection is configured. New configs
   *  should leave this empty — laps come from the session's LapSet. */
  laps: LapEntry[];
  /** Show all visible sessions stacked. Defaults true. */
  perSession?: boolean;
  /** Hide untrusted laps. Defaults false (out/in laps stay visible, dimmed). */
  hideUntrusted?: boolean;
}

export function LapPanelRender(props: WidgetRenderProps<LapPanelConfig>) {
  const { config, overlays, lapSelectionEmitter, lapSelection } = props;
  const visible = overlays && overlays.length > 0 ? overlays : [];
  const [selection, setSelection] = useState(lapSelection ?? null);
  useEffect(() => {
    if (!lapSelectionEmitter) return;
    return lapSelectionEmitter.subscribe((s) => setSelection(s));
  }, [lapSelectionEmitter]);

  // Build per-session blocks. Always include the primary; include others
  // when perSession is true (default).
  const perSession = config.perSession !== false;
  const hideUntrusted = config.hideUntrusted === true;
  const blocks: { session: OverlaySession; laps: Lap[]; best: number | null }[] = [];
  for (const session of visible) {
    if (!perSession && !session.isPrimary) continue;
    const all = session.laps?.laps ?? [];
    const list = hideUntrusted ? all.filter((l) => l.trusted) : all;
    const trustedTimes = list.filter((l) => l.trusted).map((l) => l.durationS);
    const best = trustedTimes.length === 0 ? null : Math.min(...trustedTimes);
    blocks.push({ session, laps: list, best });
  }

  // Legacy: if no laps detected anywhere AND the static `config.laps` field
  // is populated, show the static list as a fallback. New users get laps via
  // detection; saved workspaces with the old shape keep working.
  const hasAnyDetected = blocks.some((b) => b.laps.length > 0);
  if (!hasAnyDetected && config.laps.length > 0) {
    return <LegacyStaticTable laps={config.laps} />;
  }

  if (!hasAnyDetected) {
    return (
      <div className="w-full h-full bg-[#16171B] flex items-center justify-center text-[11px] text-[#9097A0] text-center px-4">
        no laps detected — open a session and configure lap detection from the Sessions panel
      </div>
    );
  }

  function isSelected(role: "main" | "ref" | "overlay", ref: LapRef): boolean {
    if (!selection) return false;
    const eq = (a: LapRef | null, b: LapRef) => !!a && a.sessionId === b.sessionId && a.lapIndex === b.lapIndex;
    if (role === "main") return eq(selection.main, ref);
    if (role === "ref") return eq(selection.ref, ref);
    return selection.overlays.some((r) => eq(r, ref));
  }

  function selectLap(ref: LapRef, e: React.MouseEvent): void {
    if (!lapSelectionEmitter) return;
    if (e.metaKey || e.ctrlKey) lapSelectionEmitter.setRef(ref);
    else if (e.shiftKey) lapSelectionEmitter.toggleOverlay(ref);
    else lapSelectionEmitter.setMain(ref);
  }

  return (
    <div className="w-full h-full bg-[#16171B] overflow-auto">
      {blocks.map(({ session, laps, best }, bi) => (
        <div key={session.id}>
          {visible.length > 1 && (
            <div className="px-2 py-1 flex items-center gap-2 bg-[#0E0E10] border-b border-[#2A2C32]">
              <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: session.color }} aria-hidden />
              <span className="text-[10px] uppercase tracking-wider text-[#9097A0] flex-1 truncate">{session.label}</span>
              <span className="text-[9px] text-[#5A5F66]">{laps.length} laps</span>
            </div>
          )}
          <table className="w-full text-xs font-mono-num">
            {bi === 0 && (
              <thead className="text-[#9097A0] uppercase text-[10px]">
                <tr className="border-b border-[#2A2C32]">
                  <th className="text-left px-2 py-1">Lap</th>
                  <th className="text-right px-2 py-1">Time</th>
                  <th className="text-right px-2 py-1">Δ best</th>
                  <th className="text-right px-2 py-1">Sel</th>
                </tr>
              </thead>
            )}
            <tbody>
              {laps.map((lap) => {
                // We need the index in the ORIGINAL laps array (with untrusted),
                // since LapRef.lapIndex points there.
                const allIdx = (session.laps?.laps ?? []).indexOf(lap);
                const ref: LapRef = { sessionId: session.id, lapIndex: allIdx };
                const isBest = best !== null && lap.trusted && lap.durationS === best;
                const dt = best !== null ? lap.durationS - best : 0;
                const main = isSelected("main", ref);
                const refSel = isSelected("ref", ref);
                const overlay = isSelected("overlay", ref);
                return (
                  <tr
                    key={`${session.id}-${allIdx}`}
                    onClick={(e) => selectLap(ref, e)}
                    className={
                      "border-b border-[#23252B] cursor-pointer " +
                      (main ? "bg-[#1F1F23] " : refSel ? "bg-[#16191F] " : overlay ? "bg-[#13141A] " : "hover:bg-[#0E0E10] ") +
                      (!lap.trusted ? "text-[#5A5F66]" : "text-[#D8DCE2]")
                    }
                    title="click = Main · ⌘+click = Ref · shift+click = toggle overlay"
                  >
                    <td className="px-2 py-0.5">
                      {lap.index}
                      {!lap.trusted && <span className="ml-1 text-[#9097A0]">·</span>}
                      {isBest && <span className="ml-1 text-[#FFC627]">★</span>}
                    </td>
                    <td className={"text-right px-2 py-0.5 " + (isBest ? "text-[#FFC627] font-bold" : "")}>
                      {formatLapTime(lap.durationS * 1_000_000)}
                    </td>
                    <td className="text-right px-2 py-0.5 text-[#9097A0]">
                      {dt === 0 ? "—" : `+${dt.toFixed(3)}`}
                    </td>
                    <td className="text-right px-2 py-0.5 text-[10px]">
                      {main && <span className="text-[#FFC627]">M</span>}
                      {refSel && <span className="text-[#4FC3F7]">R</span>}
                      {overlay && <span className="text-[#9CCC65]">O</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/** Legacy fallback rendering for workspaces saved with the v1 lap_panel
 *  config (a hand-entered list of lap numbers and times). New configs leave
 *  `config.laps` empty and rely on the session's LapSet. */
function LegacyStaticTable({ laps }: { laps: LapEntry[] }) {
  if (laps.length === 0) {
    return (
      <div className="w-full h-full bg-[#16171B] flex items-center justify-center text-[11px] text-[#9097A0] text-center px-4">
        no laps configured
      </div>
    );
  }
  const best = laps.reduce((a, b) => (b.time_ms < a.time_ms ? b : a)).time_ms;
  return (
    <div className="w-full h-full bg-[#16171B] overflow-auto">
      <table className="w-full text-xs font-mono-num">
        <thead className="text-[#9097A0] uppercase text-[10px]">
          <tr className="border-b border-[#2A2C32]">
            <th className="text-left px-2 py-1">Lap</th>
            <th className="text-right px-2 py-1">Time</th>
            <th className="text-right px-2 py-1">Δ best</th>
          </tr>
        </thead>
        <tbody>
          {laps.map((lap) => {
            const isBest = lap.time_ms === best;
            const dt = lap.time_ms - best;
            return (
              <tr key={lap.number} className={`border-b border-[#23252B] ${isBest ? "bg-[#0E0E10]" : ""}`}>
                <td className="px-2 py-1">{lap.number}</td>
                <td className={`text-right px-2 py-1 ${isBest ? "text-[#FFC627] font-bold" : "text-[#D8DCE2]"}`}>{formatLapTime(lap.time_ms * 1000)}</td>
                <td className="text-right px-2 py-1 text-[#9097A0]">{dt === 0 ? "—" : `+${(dt / 1000).toFixed(3)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
