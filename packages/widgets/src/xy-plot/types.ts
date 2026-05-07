/* Public surface for the XY-plot widget's overlay system. Every overlay
 * module imports the types from here; nothing imports across overlays. */
import type { FC } from "react";
import type { ChannelMeta } from "@helios/store";
import type { OverlaySession } from "../types";

/* ─── Plot-level config ──────────────────────────────────────────────── */

export type Mode = "simple" | "advanced";

export interface XyPlotConfig {
  /** Schema version. v1 = legacy (no overlays array); migrations.ts
   *  rewrites v1 into v2 on load. */
  version: 2;
  mode: Mode;

  xChannelId: string;
  yChannelId: string;
  xMin?: number; xMax?: number;
  yMin?: number; yMax?: number;

  /** Optional math-expr formula. Samples where the result is falsy are
   *  excluded from every overlay. Empty string == no filter. */
  filter?: string;

  /** Optional channel id. When set, distinct values become groups; each
   *  group gets a palette color and (where the overlay supports it) its
   *  own fit. */
  groupByChannelId?: string;

  /** Ordered overlay list. Drawn in array order (later = on top). */
  overlays: Overlay[];
}

/* ─── Overlay union ──────────────────────────────────────────────────── */

export type Overlay =
  | { id: string; kind: "scatter";       config: ScatterConfig }
  | { id: string; kind: "fit";           config: FitConfig }
  | { id: string; kind: "formula";       config: FormulaConfig }
  | { id: string; kind: "bins";          config: BinsConfig }
  | { id: string; kind: "stats";         config: StatsConfig }
  | { id: string; kind: "quadrant-fit";  config: QuadrantFitConfig };

export interface ScatterConfig {
  color: string;
  pointSize: number;
  alpha: number;
  trail: boolean;
  /** When trail is on, the gradient ramps from `trailFromColor` (oldest
   *  sample) to `trailToColor` (newest). Both optional with defaults so
   *  configs from before this field existed render unchanged. */
  trailFromColor?: string;
  trailToColor?: string;
}

export type FitKind =
  | { type: "linear" }
  | { type: "polynomial"; degree: number }
  | { type: "exponential" }
  | { type: "logarithmic" }
  | { type: "power" };

export interface FitConfig {
  kind: FitKind;
  color: string;
  lineWidth: number;
  showBand: boolean;
  extrapolate: boolean;
  perGroup: boolean;
}

export interface FormulaConfig {
  expression: string;
  color: string;
  lineWidth: number;
  dashed: boolean;
}

export interface BinsConfig {
  binCount: number;
  statistic: "mean" | "median" | "p25-p75";
  color: string;
  showCount: boolean;
}

export interface StatsConfig {
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  show: {
    count: boolean;
    meanXY: boolean;
    stdXY: boolean;
    correlation: boolean;
    fitRSquared: boolean;
    fitEquation: boolean;
  };
  fitOverlayId?: string;
}

export interface QuadrantFitConfig {
  kind: FitKind;
  color: string;
  lineWidth: number;
  showBand: boolean;
  showStatsOverlay: boolean;
}

/* ─── Pipeline + render contracts ────────────────────────────────────── */

/** One bucket of samples after filter + group-by + zoom. One per
 *  (session × group-by-value) combination. */
export interface SessionGroup {
  session: OverlaySession;
  /** Group-by value as a string ("" when no group-by is configured). */
  groupKey: string;
  /** Color the scatter overlay should use. Palette-cycled per groupKey
   *  when group-by is active; otherwise the overlay's configured color. */
  color: string;
  time: Float64Array;
  xs: Float64Array;
  ys: Float64Array;
  n: number;
}

export interface PlotLayout {
  xmin: number; xmax: number; ymin: number; ymax: number;
  padL: number; padT: number; plotW: number; plotH: number;
  project(x: number, y: number): { px: number; py: number };
}

export interface OverlayContext {
  bounds: { xmin: number; xmax: number; ymin: number; ymax: number };
  /** Artifacts produced by overlays earlier in the array. Used by stats
   *  to read a fit's R² + equation by id. */
  priorArtifacts: ReadonlyMap<string, unknown>;
  availableChannels: ChannelMeta[];
}

export interface LegendEntry {
  color: string;
  label: string;
}

export interface OverlayEditorProps<C> {
  config: C;
  onChange: (next: C) => void;
  availableChannels: ChannelMeta[];
}

export interface OverlayModule<C, A> {
  readonly kind: string;
  defaultConfig(): C;
  compute(groups: SessionGroup[], cfg: C, ctx: OverlayContext): A;
  draw?(ctx: CanvasRenderingContext2D, layout: PlotLayout, artifacts: A, cfg: C): void;
  Component?: FC<{ artifacts: A; cfg: C; layout: PlotLayout }>;
  Editor: FC<OverlayEditorProps<C>>;
  legendEntries?(cfg: C, artifacts: A): LegendEntry[];
  availability: ReadonlyArray<Mode>;
}
