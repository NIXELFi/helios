import { useEffect, useRef } from "react";
import {
  stripChartWidget, numericReadoutWidget, roundGaugeWidget, barGaugeWidget,
  engineBarWidget, gpsTrackWidget, lapPanelWidget, alarmPanelWidget,
  tireGridWidget, histogramWidget, xyPlotWidget, steeringWheelWidget,
  channelReportWidget, timeReportWidget, zoneStatsWidget, fftWidget,
  lapDeltaWidget, sectorTableWidget, valuesTableWidget,
  type Widget,
} from "@helios/widgets";
import type { TileSpec, WidgetType } from "../workspaces/types";
import { WidgetIcon } from "./widget-icons";

type PaletteCategory = "Charts" | "Gauges" | "Timing" | "Data";

interface PaletteEntry {
  type: WidgetType;
  category: PaletteCategory;
  description: string;
  defaultCells: { w: number; h: number }; // in grid cells
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  widget: Widget<any>;
}

/** Section order in the modal. */
const CATEGORIES: PaletteCategory[] = ["Charts", "Gauges", "Timing", "Data"];

// Exported so tests can assert the palette covers every registered widget
// type — lap_delta and sector_table once shipped registered-but-unaddable
// because this list drifted from the registry. Display names come from each
// widget's registry label; this list adds only palette-specific presentation
// (category, blurb, spawn size).
export const PALETTE: PaletteEntry[] = [
  { type: "strip_chart",     category: "Charts", description: "Time-series line chart",            defaultCells: { w: 12, h: 5 }, widget: stripChartWidget },
  { type: "lap_delta",       category: "Charts", description: "Main − Ref time delta by distance", defaultCells: { w: 12, h: 5 }, widget: lapDeltaWidget },
  { type: "xy_plot",         category: "Charts", description: "Two channels as a scatter",         defaultCells: { w: 8,  h: 6 }, widget: xyPlotWidget },
  { type: "histogram",       category: "Charts", description: "Value distribution",                defaultCells: { w: 8,  h: 5 }, widget: histogramWidget },
  { type: "fft",             category: "Charts", description: "Frequency-domain magnitude",        defaultCells: { w: 10, h: 6 }, widget: fftWidget },
  { type: "gps_track",       category: "Charts", description: "Lap path on lat/lon plane",         defaultCells: { w: 8,  h: 6 }, widget: gpsTrackWidget },
  { type: "round_gauge",     category: "Gauges", description: "Arc-style needle gauge",            defaultCells: { w: 4,  h: 5 }, widget: roundGaugeWidget },
  { type: "bar_gauge",       category: "Gauges", description: "Vertical or horizontal bar",        defaultCells: { w: 3,  h: 5 }, widget: barGaugeWidget },
  { type: "numeric_readout", category: "Gauges", description: "Big-number value display",          defaultCells: { w: 4,  h: 3 }, widget: numericReadoutWidget },
  { type: "engine_bar",      category: "Gauges", description: "RPM segments + gear indicator",     defaultCells: { w: 24, h: 2 }, widget: engineBarWidget },
  { type: "steering_wheel",  category: "Gauges", description: "Animated wheel + degree readout",   defaultCells: { w: 4,  h: 5 }, widget: steeringWheelWidget },
  { type: "lap_panel",       category: "Timing", description: "List of laps with times",           defaultCells: { w: 6,  h: 5 }, widget: lapPanelWidget },
  { type: "time_report",     category: "Timing", description: "Lap times w/ rolling minimum",      defaultCells: { w: 8,  h: 6 }, widget: timeReportWidget },
  { type: "sector_table",    category: "Timing", description: "Per-lap sector times w/ optimal",   defaultCells: { w: 10, h: 6 }, widget: sectorTableWidget },
  { type: "zone_stats",      category: "Timing", description: "Stats between two datums",          defaultCells: { w: 10, h: 5 }, widget: zoneStatsWidget },
  { type: "values_table",    category: "Data",   description: "Live channel values at the cursor", defaultCells: { w: 7,  h: 6 }, widget: valuesTableWidget },
  { type: "channel_report",  category: "Data",   description: "Per-lap stats × per-channel",       defaultCells: { w: 12, h: 6 }, widget: channelReportWidget },
  { type: "tire_grid",       category: "Data",   description: "Per-corner temp + pressure",        defaultCells: { w: 8,  h: 6 }, widget: tireGridWidget },
  { type: "alarm_panel",     category: "Data",   description: "List of alarm events",              defaultCells: { w: 6,  h: 5 }, widget: alarmPanelWidget },
];

interface Props {
  existingIds: string[];
  onAdd: (newTile: Omit<TileSpec, "x" | "y" | "w" | "h"> & { defaultCellsW: number; defaultCellsH: number }) => void;
  onClose: () => void;
}

export function AddTileModal({ existingIds, onAdd, onClose }: Props) {
  // A single add closes the modal; guard against a rapid double-click or
  // Enter-repeat firing onAdd twice (which would mint a colliding id from the
  // same `existingIds` snapshot before the parent re-renders).
  const addedRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Modal a11y: Escape-to-close, focus-trap, focus-restore. Mirrors
  // ConfirmDialog's convention.
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const root = dialogRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prevFocus?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Add tile"
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 helios-overlay-in"
      onClick={onClose}
    >
      <div
        className="bg-[#0E0E10] border border-[#2A2C32] rounded-md helios-elevate helios-modal-in w-[640px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-9 flex items-center justify-between px-3 border-b border-[#2A2C32]">
          <span className="text-xs uppercase tracking-wider text-[#FFC627]">Add Tile</span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center text-[#9097A0] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
          >×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {CATEGORIES.map((cat) => (
            <div key={cat} className="mb-3 last:mb-0">
              <div className="text-[10px] uppercase tracking-wider text-[#5A5F66] mb-1.5">{cat}</div>
              <div className="grid grid-cols-2 gap-2">
                {PALETTE.filter((e) => e.category === cat).map((entry) => (
                  <button
                    key={entry.type}
                    type="button"
                    onClick={() => {
                      if (addedRef.current) return;  // ignore double-add (rapid click / Enter-repeat)
                      addedRef.current = true;
                      const id = uniqueId(entry.type, existingIds);
                      onAdd({
                        id,
                        widgetType: entry.type,
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        config: entry.widget.defaultConfig as any,
                        defaultCellsW: entry.defaultCells.w,
                        defaultCellsH: entry.defaultCells.h,
                      });
                      onClose();
                    }}
                    className="group flex items-center gap-2.5 text-left bg-[#16171B] border border-[#2A2C32] hover:border-[#FFC627] rounded-sm p-2.5 cursor-pointer transition-colors"
                  >
                    <span className="w-8 h-8 flex-shrink-0 flex items-center justify-center bg-[#0E0E10] border border-[#2A2C32] rounded-sm text-[#9097A0] group-hover:text-[#FFC627] transition-colors">
                      <WidgetIcon type={entry.type} />
                    </span>
                    <span className="flex flex-col min-w-0">
                      <span className="text-xs text-[#FFC627] font-semibold truncate">{entry.widget.label}</span>
                      <span className="text-[10px] text-[#9097A0] truncate" title={entry.description}>
                        {entry.description}
                      </span>
                    </span>
                    <span className="ml-auto flex-shrink-0 text-[10px] text-[#5A5F66] font-mono-num">
                      {entry.defaultCells.w}×{entry.defaultCells.h}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-3 py-2 border-t border-[#2A2C32] text-[10px] text-[#9097A0]">
          New tiles drop into the next free slot. You can drag and resize them once placed.
        </div>
      </div>
    </div>
  );
}

/** Generate a deterministic unique id based on widget type, by appending a
 *  numeric suffix when needed. */
function uniqueId(type: WidgetType, existing: string[]): string {
  const base = type.replace("_", "-");
  if (!existing.includes(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
