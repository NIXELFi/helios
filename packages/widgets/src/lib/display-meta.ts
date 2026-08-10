/* Channel display-metadata resolution shared by every widget that shows a
 * channel to the user (corner readouts, tile subtitles, table headers, axis
 * labels). One resolver so "what do we call this channel" has one answer
 * app-wide. Originally private to the Values table.
 */
import type { ChannelMeta } from "@helios/store";

export interface DisplayMeta {
  label: string;
  units: string;
  decimals: number;
}

/** Resolve a channel's display metadata from the host-supplied channel list.
 *  Falls back to the raw id / no unit / 2 decimals when the channel is
 *  unknown (workspace saved against a different CSV) or the host predates
 *  `availableChannels`. Decimals are sanitized to a non-negative integer so a
 *  malformed meta can never make toFixed throw. */
export function displayMeta(id: string, available?: ReadonlyArray<ChannelMeta>): DisplayMeta {
  const m = available?.find((c) => c.id === id);
  const decimals =
    m && Number.isInteger(m.decimals) && m.decimals >= 0 && m.decimals <= 20
      ? m.decimals
      : 2;
  return {
    label: m?.display_name || id,
    units: m?.units ?? "",
    decimals,
  };
}

/** "—" for missing/non-finite samples, fixed-point otherwise. */
export function formatValue(v: number | null, decimals: number): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toFixed(decimals);
}

/** Display name for one channel id — `displayMeta` when only the label is
 *  needed (tile subtitles, legend chips). */
export function channelLabel(id: string, available?: ReadonlyArray<ChannelMeta>): string {
  return displayMeta(id, available).label;
}

/** Comma-joined display names for a channel-id list, truncated with a "+N"
 *  tail so long configs don't overflow a tile header. Skips empty ids
 *  (unconfigured picker rows). */
export function channelListLabel(
  ids: ReadonlyArray<string>,
  available?: ReadonlyArray<ChannelMeta>,
  maxNames = 3,
): string | null {
  const named = ids.filter(Boolean).map((id) => channelLabel(id, available));
  if (named.length === 0) return null;
  const shown = named.slice(0, maxNames);
  const extra = named.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} +${extra}` : shown.join(", ");
}
