import type { XyPlotConfig } from "./types";

interface LegacyConfig {
  xChannelId: string;
  yChannelId: string;
  xMin?: number; xMax?: number;
  yMin?: number; yMax?: number;
  color?: string;
  trail?: boolean;
}

/** Turn a v1 (legacy) config into a v2 with a single scatter overlay
 *  preserving the old visual. v2 inputs pass through unchanged so this
 *  is safe to call unconditionally on every config read. */
export function migrateConfig(input: XyPlotConfig | LegacyConfig): XyPlotConfig {
  if ((input as XyPlotConfig).version === 2) return input as XyPlotConfig;
  const legacy = input as LegacyConfig;
  return {
    version: 2,
    mode: "simple",
    xChannelId: legacy.xChannelId,
    yChannelId: legacy.yChannelId,
    xMin: legacy.xMin,
    xMax: legacy.xMax,
    yMin: legacy.yMin,
    yMax: legacy.yMax,
    overlays: [{
      id: "migrated-scatter",
      kind: "scatter",
      config: {
        color: legacy.color ?? "#FFC627",
        pointSize: 2,
        alpha: 1,
        trail: legacy.trail ?? false,
      },
    }],
  };
}
