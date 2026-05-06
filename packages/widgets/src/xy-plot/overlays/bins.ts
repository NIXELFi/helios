import { mean, percentile } from "@helios/lib";
import type { OverlayModule, BinsConfig, SessionGroup } from "../types";
import { register } from "./registry";

interface Bin {
  xCenter: number;
  yStat: number;
  yLow?: number;
  yHigh?: number;
  n: number;
}

interface BinsArtifact { bins: Bin[]; }

export const binsOverlay: OverlayModule<BinsConfig, BinsArtifact> = {
  kind: "bins",
  availability: ["advanced"],
  defaultConfig() {
    return { binCount: 20, statistic: "mean", color: "#42A5F5", showCount: false };
  },
  compute(groups, cfg, ctx) {
    const binCount = Math.max(1, Math.min(200, cfg.binCount));
    const lo = ctx.bounds.xmin, hi = ctx.bounds.xmax;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return { bins: [] };
    const width = (hi - lo) / binCount;
    const buckets: number[][] = Array.from({ length: binCount }, () => []);
    for (const g of groups) {
      for (let i = 0; i < g.n; i++) {
        const x = g.xs[i]!, y = g.ys[i]!;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const idx = Math.min(binCount - 1, Math.max(0, Math.floor((x - lo) / width)));
        buckets[idx]!.push(y);
      }
    }
    const bins: Bin[] = [];
    for (let i = 0; i < binCount; i++) {
      const ys = buckets[i]!;
      if (ys.length === 0) continue;
      const center = lo + (i + 0.5) * width;
      if (cfg.statistic === "mean") {
        bins.push({ xCenter: center, yStat: mean(ys), n: ys.length });
      } else if (cfg.statistic === "median") {
        bins.push({ xCenter: center, yStat: percentile(ys, 50), n: ys.length });
      } else {
        bins.push({
          xCenter: center,
          yStat: percentile(ys, 50),
          yLow: percentile(ys, 25),
          yHigh: percentile(ys, 75),
          n: ys.length,
        });
      }
    }
    return { bins };
  },
  draw(ctx, layout, artifacts, cfg) {
    if (artifacts.bins.length === 0) return;
    if (cfg.statistic === "p25-p75") {
      ctx.fillStyle = withAlpha(cfg.color, 0.18);
      ctx.beginPath();
      for (let i = 0; i < artifacts.bins.length; i++) {
        const b = artifacts.bins[i]!;
        const { px, py } = layout.project(b.xCenter, b.yHigh ?? b.yStat);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      for (let i = artifacts.bins.length - 1; i >= 0; i--) {
        const b = artifacts.bins[i]!;
        const { px, py } = layout.project(b.xCenter, b.yLow ?? b.yStat);
        ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = cfg.color; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < artifacts.bins.length; i++) {
      const b = artifacts.bins[i]!;
      const { px, py } = layout.project(b.xCenter, b.yStat);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    if (cfg.showCount) {
      ctx.fillStyle = cfg.color;
      for (const b of artifacts.bins) {
        const { px, py } = layout.project(b.xCenter, b.yStat);
        const r = Math.min(5, 1 + Math.log10(b.n + 1) * 1.5);
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  },
  legendEntries(cfg) {
    return [{ color: cfg.color, label: `bins (${cfg.statistic}, ${cfg.binCount})` }];
  },
  Editor: () => null,
};

register(binsOverlay);

function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith("#") || hex.length !== 7) return hex;
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 0xff},${(v >> 8) & 0xff},${v & 0xff},${alpha})`;
}

export type _ = SessionGroup;
