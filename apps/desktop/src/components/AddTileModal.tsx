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

interface PaletteEntry {
  type: WidgetType;
  label: string;
  description: string;
  defaultCells: { w: number; h: number }; // in grid cells
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  widget: Widget<any>;
}

// Exported so tests can assert the palette covers every registered widget
// type — lap_delta and sector_table once shipped registered-but-unaddable
// because this list drifted from the registry.
export const PALETTE: PaletteEntry[] = [
  { type: "strip_chart",     label: "Strip Chart",     description: "Time-series line chart",         defaultCells: { w: 12, h: 5 }, widget: stripChartWidget },
  { type: "round_gauge",     label: "Round Gauge",     description: "Arc-style needle gauge",         defaultCells: { w: 4,  h: 5 }, widget: roundGaugeWidget },
  { type: "bar_gauge",       label: "Bar Gauge",       description: "Vertical or horizontal bar",     defaultCells: { w: 3,  h: 5 }, widget: barGaugeWidget },
  { type: "numeric_readout", label: "Numeric Readout", description: "Big-number value display",       defaultCells: { w: 4,  h: 3 }, widget: numericReadoutWidget },
  { type: "engine_bar",      label: "Engine Bar",      description: "RPM segments + gear indicator",  defaultCells: { w: 24, h: 2 }, widget: engineBarWidget },
  { type: "gps_track",       label: "GPS Track",       description: "Lap path on lat/lon plane",      defaultCells: { w: 8,  h: 6 }, widget: gpsTrackWidget },
  { type: "xy_plot",         label: "XY Plot",         description: "Two channels as a scatter",      defaultCells: { w: 8,  h: 6 }, widget: xyPlotWidget },
  { type: "histogram",       label: "Histogram",       description: "Value distribution",             defaultCells: { w: 8,  h: 5 }, widget: histogramWidget },
  { type: "tire_grid",       label: "Tire Grid",       description: "Per-corner temp + pressure",     defaultCells: { w: 8,  h: 6 }, widget: tireGridWidget },
  { type: "lap_panel",       label: "Lap Panel",       description: "List of laps with times",        defaultCells: { w: 6,  h: 5 }, widget: lapPanelWidget },
  { type: "alarm_panel",     label: "Alarm Panel",     description: "List of alarm events",           defaultCells: { w: 6,  h: 5 }, widget: alarmPanelWidget },
  { type: "steering_wheel",  label: "Steering Wheel",  description: "Animated wheel + degree readout", defaultCells: { w: 4,  h: 5 }, widget: steeringWheelWidget },
  { type: "channel_report",  label: "Channel Report",  description: "Per-lap stats × per-channel",     defaultCells: { w: 12, h: 6 }, widget: channelReportWidget },
  { type: "time_report",     label: "Time Report",     description: "Lap times w/ rolling minimum",    defaultCells: { w: 8,  h: 6 }, widget: timeReportWidget },
  { type: "zone_stats",      label: "Zone Stats",      description: "Stats between two datums",        defaultCells: { w: 10, h: 5 }, widget: zoneStatsWidget },
  { type: "fft",             label: "FFT / Spectrum",  description: "Frequency-domain magnitude",      defaultCells: { w: 10, h: 6 }, widget: fftWidget },
  { type: "lap_delta",       label: "Lap Δt",          description: "Main − Ref time delta by distance", defaultCells: { w: 12, h: 5 }, widget: lapDeltaWidget },
  { type: "sector_table",    label: "Sector Splits",   description: "Per-lap sector times w/ optimal",   defaultCells: { w: 10, h: 6 }, widget: sectorTableWidget },
  { type: "values_table",    label: "Values",          description: "Live channel values at the cursor", defaultCells: { w: 7,  h: 6 }, widget: valuesTableWidget },
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
        <div className="flex-1 overflow-y-auto grid grid-cols-2 gap-2 p-3">
          {PALETTE.map((entry) => (
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
              className="flex flex-col items-start text-left bg-[#16171B] border border-[#2A2C32] hover:border-[#FFC627] rounded-sm p-3 cursor-pointer transition-colors"
            >
              <span className="text-xs text-[#FFC627] font-semibold">{entry.label}</span>
              <span className="text-[10px] text-[#9097A0] mt-1">{entry.description}</span>
              <span className="text-[10px] text-[#5A5F66] mt-2 font-mono-num">
                {entry.defaultCells.w} × {entry.defaultCells.h} cells
              </span>
            </button>
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
