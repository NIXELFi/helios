// colormaps.ts
//
// Three perceptually-uniform colormaps used by the wave viewer.
// Data ported from matplotlib (BSD); see spec §3.4.
//
// LUTs are 256-entry [R, G, B] arrays with channels in 0..255 (sRGB byte).

export type ColormapName = "RdBu_r" | "inferno" | "viridis";

type RGB = [number, number, number];

function buildLut(controlPoints: Array<{ t: number; rgb: RGB }>): RGB[] {
  const out: RGB[] = new Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let lo = 0;
    while (lo < controlPoints.length - 1 && controlPoints[lo + 1]!.t < t) lo++;
    const a = controlPoints[lo]!;
    const b = controlPoints[Math.min(lo + 1, controlPoints.length - 1)]!;
    const span = b.t - a.t || 1;
    const f = (t - a.t) / span;
    out[i] = [
      Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
      Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
      Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f),
    ];
  }
  return out;
}

const RDBU_R_CTRL: Array<{ t: number; rgb: RGB }> = [
  { t: 0.000, rgb: [ 5,  48,  97] },
  { t: 0.125, rgb: [33, 102, 172] },
  { t: 0.250, rgb: [67, 147, 195] },
  { t: 0.375, rgb: [146, 197, 222] },
  { t: 0.500, rgb: [247, 247, 247] },
  { t: 0.625, rgb: [253, 219, 199] },
  { t: 0.750, rgb: [244, 165, 130] },
  { t: 0.875, rgb: [214,  96,  77] },
  { t: 1.000, rgb: [103,   0,  31] },
];

const INFERNO_CTRL: Array<{ t: number; rgb: RGB }> = [
  { t: 0.000, rgb: [  0,   0,   4] },
  { t: 0.125, rgb: [ 31,  12,  72] },
  { t: 0.250, rgb: [ 85,  15, 109] },
  { t: 0.375, rgb: [136,  34, 106] },
  { t: 0.500, rgb: [186,  54,  85] },
  { t: 0.625, rgb: [227,  89,  51] },
  { t: 0.750, rgb: [249, 140,  10] },
  { t: 0.875, rgb: [249, 201,  50] },
  { t: 1.000, rgb: [252, 255, 164] },
];

const VIRIDIS_CTRL: Array<{ t: number; rgb: RGB }> = [
  { t: 0.000, rgb: [ 68,   1,  84] },
  { t: 0.125, rgb: [ 71,  44, 122] },
  { t: 0.250, rgb: [ 59,  81, 139] },
  { t: 0.375, rgb: [ 44, 113, 142] },
  { t: 0.500, rgb: [ 33, 144, 141] },
  { t: 0.625, rgb: [ 39, 173, 129] },
  { t: 0.750, rgb: [ 92, 200,  99] },
  { t: 0.875, rgb: [170, 220,  50] },
  { t: 1.000, rgb: [253, 231,  37] },
];

export const COLORMAPS: Record<ColormapName, RGB[]> = {
  RdBu_r: buildLut(RDBU_R_CTRL),
  inferno: buildLut(INFERNO_CTRL),
  viridis: buildLut(VIRIDIS_CTRL),
};

/** Sample a colormap at normalized t ∈ [0, 1]. NaN and out-of-range clamp. */
export function sampleColormap(name: ColormapName, t: number): RGB {
  if (Number.isNaN(t)) return COLORMAPS[name][0]!;
  const clamped = Math.max(0, Math.min(1, t));
  const idx = Math.min(255, Math.max(0, Math.round(clamped * 255)));
  return COLORMAPS[name][idx]!;
}
