import type { OverlaySession } from "../types";

/** Well-known speed channels, in fallback preference order. The unit is a
 *  system-level hint — gps.speed is m/s in MoTeC and most ECU exports, the
 *  rest are km/h; speedToMs (the lib boundary) is tolerant of unknown units.
 *  Hosts that slice for `requiresSpeed` widgets include every one of these
 *  that a session's store carries, so findSpeed can resolve against the
 *  slice alone. */
export const SPEED_CHANNEL_CANDIDATES: ReadonlyArray<{ id: string; unit: string }> = [
  { id: "gps.speed", unit: "m/s" },
  { id: "vehicle.speed", unit: "km/h" },
  { id: "wheel.speed_avg", unit: "km/h" },
  { id: "engine.wheel_speed_avg", unit: "km/h" },
];

/** Resolve the speed trace for a session from its slice. The host-provided
 *  lap-config pick (session.speedChannelId) wins when present — the user
 *  chose it explicitly in Lap Config, so it must beat the built-in candidate
 *  order — then falls back through SPEED_CHANNEL_CANDIDATES. Returns null
 *  when the slice carries no recognizable speed channel. */
export function findSpeed(session: OverlaySession): { values: Float64Array; unit: string } | null {
  if (session.speedChannelId) {
    const v = session.slice.data.get(session.speedChannelId);
    if (v) return { values: v, unit: session.speedChannelUnit ?? "m/s" };
  }
  for (const { id, unit } of SPEED_CHANNEL_CANDIDATES) {
    const v = session.slice.data.get(id);
    if (v) return { values: v, unit };
  }
  return null;
}
