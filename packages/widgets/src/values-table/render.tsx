import { Fragment, useEffect, useMemo, useState } from "react";
import type { ZoomRange } from "@helios/lib";
import type { WidgetRenderProps, OverlaySession } from "../types";
import { sampleAt } from "../lib/sample-at";
import {
  channelStats, deltaTint, displayMeta, formatDelta, formatValue,
  type ChannelStats,
} from "./compute";

export interface ValuesTableConfig {
  /** Channels to show, one row per entry, in this order. */
  channelIds: string[];
  /** Show min / max / avg columns for the PRIMARY session over the current
   *  zoom window (full extent when unzoomed). Default true. */
  showStats: boolean;
}

/** Δ tint matching the footer's lap-compare segment (App.tsx): red for
 *  positive (session above primary), green for negative, neutral when the
 *  delta rounds to zero at display precision. */
const TINT_COLOR: Record<ReturnType<typeof deltaTint>, string> = {
  pos: "#EF5350", neg: "#66BB6A", zero: "#D8DCE2",
};

// Sticky header cells: with collapsed table borders, a border on a sticky th
// scrolls away with the rows (Chromium), so the bottom/left edges are drawn
// with inset shadows instead.
const TH = "sticky top-0 z-10 bg-[#16171B] px-2 py-1 shadow-[inset_0_-1px_0_#2A2C32]";
const TH_L = "sticky top-0 z-10 bg-[#16171B] px-2 py-1 shadow-[inset_1px_-1px_0_#2A2C32]";

export function ValuesTableRender(props: WidgetRenderProps<ValuesTableConfig>) {
  const { config, slice, cursorEmitter, timeRange, overlays, viewState, availableChannels } = props;

  const visible: OverlaySession[] = overlays && overlays.length > 0
    ? overlays
    : [{ id: "primary", label: "primary", color: "#FFC627", slice, range: timeRange, isPrimary: true }];
  const primary = visible[0]!;

  // rAF-coalesced cursor tracking (tire-grid pattern): one setState per frame,
  // read the emitter during render. Never setState per emit — the cursor runs
  // at 100 Hz.
  const [, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const off = cursorEmitter.subscribe(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; setTick((x) => x + 1); });
    });
    return () => { off(); if (raf) cancelAnimationFrame(raf); };
  }, [cursorEmitter]);
  const t = cursorEmitter.get();

  // Mirror the zoom window into React state (fft pattern): the stats memo has
  // to recompute when the zoom changes, and `viewState` is a long-lived
  // emitter whose identity never changes. setZoomWindow keeps the previous
  // object when the range is value-equal so an unrelated view-state emit
  // (e.g. a datum drop) doesn't churn the memo.
  const [zoomWindow, setZoomWindow] = useState<ZoomRange | null>(
    () => viewState?.get().zoomRange ?? null,
  );
  useEffect(() => {
    if (!viewState) return;
    const apply = (state: { zoomRange: ZoomRange | null }) => {
      setZoomWindow((prev) => (sameZoom(prev, state.zoomRange) ? prev : state.zoomRange));
    };
    apply(viewState.get());
    return viewState.subscribe(apply);
  }, [viewState]);

  // Stable session-set key (channel-report convention): slice identities churn
  // on every parent render but their content only changes with the id set.
  const visibleIdsKey = JSON.stringify(visible.map((v) => v.id));

  // Primary-session stats over the zoom window (full extent when unzoomed).
  // Keyed on session set + zoom + config — NOT on cursor ticks.
  const stats = useMemo(() => {
    const out = new Map<string, ChannelStats | null>();
    if (!config.showStats) return out;
    const startUs = zoomWindow ? zoomWindow.startUs : primary.range.startUs;
    const endUs = zoomWindow ? zoomWindow.endUs : primary.range.endUs;
    for (const id of config.channelIds) {
      out.set(id, channelStats(primary.slice, id, startUs, endUs));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey, zoomWindow, config]);

  if (config.channelIds.length === 0) {
    return (
      <div className="w-full h-full bg-[#16171B] flex items-center justify-center text-xs text-[#9097A0] text-center px-4">
        no channels configured — add channels via the config panel
      </div>
    );
  }

  const showDelta = visible.length >= 2;

  return (
    <div className="w-full h-full bg-[#16171B] overflow-auto text-[11px]">
      <table className="w-full font-mono-num">
        <thead className="text-[9px] uppercase tracking-wider text-[#9097A0]">
          <tr>
            <th className={TH + " text-left"}>Channel</th>
            {visible.map((s) => (
              <Fragment key={s.id}>
                <th className={TH_L + " text-right whitespace-nowrap"}>
                  <span
                    className="inline-block w-2 h-2 rounded-sm mr-1 align-middle"
                    style={{ background: s.color }}
                    aria-hidden
                  />
                  {s.label}
                </th>
                {showDelta && !s.isPrimary && (
                  <th className={TH + " text-right text-[#5A5F66]"}>Δ</th>
                )}
              </Fragment>
            ))}
            {config.showStats && ["min", "max", "avg"].map((lab, i) => (
              <th key={lab} className={(i === 0 ? TH_L : TH) + " text-right text-[#5A5F66]"}>{lab}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {config.channelIds.map((id) => {
            const meta = displayMeta(id, availableChannels);
            const primaryVal = sampleAt(primary.slice, id, t);
            const st = stats.get(id) ?? null;
            const statCells: Array<number | null> = st ? [st.min, st.max, st.avg] : [null, null, null];
            return (
              <tr key={id} className="border-b border-[#23252B] text-[#D8DCE2]">
                <td className="px-2 py-0.5 whitespace-nowrap">
                  {meta.label}
                  {meta.units !== "" && (
                    <span className="ml-1 text-[10px] text-[#5A5F66]">{meta.units}</span>
                  )}
                </td>
                {visible.map((s) => {
                  const v = s.isPrimary ? primaryVal : sampleAt(s.slice, id, t);
                  const d = !s.isPrimary && v !== null && primaryVal !== null ? v - primaryVal : null;
                  return (
                    <Fragment key={s.id}>
                      <td className={"text-right px-2 py-0.5 border-l border-[#2A2C32] " + (v === null ? "text-[#5A5F66]" : "")}>
                        {formatValue(v, meta.decimals)}
                      </td>
                      {showDelta && !s.isPrimary && (
                        <td
                          className="text-right px-2 py-0.5"
                          style={{ color: d === null ? "#5A5F66" : TINT_COLOR[deltaTint(d, meta.decimals)] }}
                        >
                          {formatDelta(d, meta.decimals)}
                        </td>
                      )}
                    </Fragment>
                  );
                })}
                {config.showStats && statCells.map((v, i) => (
                  <td
                    key={i}
                    className={
                      "text-right px-2 py-0.5 " +
                      (i === 0 ? "border-l border-[#2A2C32] " : "") +
                      (v === null ? "text-[#5A5F66]" : "text-[#9AA0A6]")
                    }
                  >
                    {formatValue(v, meta.decimals)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Value-equality for zoom ranges, so a view-state emit that only changed the
 *  datums doesn't hand the stats memo a new object and force a recompute. */
function sameZoom(a: ZoomRange | null, b: ZoomRange | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.startUs === b.startUs && a.endUs === b.endUs;
}
