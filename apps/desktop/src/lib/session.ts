import type { ChannelStore } from "@helios/store";
import type { LapDetectionConfig, LapSet } from "@helios/lib";

export interface LoadedSession {
  id: string;
  label: string;
  store: ChannelStore;
  color: string;
  visible: boolean;
  /** Lap detection config — persisted per-session in localStorage. Null when
   *  the session has no detectable structure (e.g. straight-line accel runs). */
  lapConfig: LapDetectionConfig;
  /** Cached LapSet computed from lapConfig + this session's data. Null when
   *  detection hasn't been run yet, or when lapConfig.mode === "none". */
  laps: LapSet | null;
  /** Canonical-id → source_header overrides. Mirrors what's set on the
   *  store. Persisted per-session in localStorage (channel-overrides.ts).
   *  Empty when the session is on full auto-resolution. */
  channelOverrides: Record<string, string>;
}

/** Distinct colors for overlay traces; first session gets first color, etc. */
export const SESSION_PALETTE = [
  "#FFC627", // brand yellow
  "#4FC3F7", // cyan
  "#66BB6A", // green
  "#EF5350", // red
  "#BA68C8", // purple
  "#FFB800", // orange
  "#9CCC65", // light green
  "#26A69A", // teal
];

export function colorForIndex(i: number): string {
  return SESSION_PALETTE[i % SESSION_PALETTE.length]!;
}
