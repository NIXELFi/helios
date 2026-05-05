import type { ChannelStore } from "@helios/store";

export interface LoadedSession {
  id: string;
  label: string;
  store: ChannelStore;
  color: string;
  visible: boolean;
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
