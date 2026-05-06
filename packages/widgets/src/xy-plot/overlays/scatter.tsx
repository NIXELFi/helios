import type { ReactNode } from "react";
import type { OverlayModule, SessionGroup, ScatterConfig } from "../types";
import { register } from "./registry";

interface ScatterArtifact {
  groups: SessionGroup[];
}

export const scatterOverlay: OverlayModule<ScatterConfig, ScatterArtifact> = {
  kind: "scatter",
  availability: ["simple", "advanced"],
  defaultConfig() {
    return { color: "#FFC627", pointSize: 2, alpha: 1, trail: false };
  },
  compute(groups) {
    return { groups };
  },
  draw(ctx, layout, artifacts, cfg) {
    const { project } = layout;
    const size = Math.max(1, cfg.pointSize);
    ctx.globalAlpha = Math.max(0, Math.min(1, cfg.alpha));
    if (cfg.trail && artifacts.groups.length === 1) {
      const g = artifacts.groups[0]!;
      for (let i = 0; i < g.n; i++) {
        const t = i / Math.max(1, g.n - 1);
        ctx.fillStyle = lerpColor("#26A69A", "#FFB800", t);
        const { px, py } = project(g.xs[i]!, g.ys[i]!);
        ctx.fillRect(px - size / 2, py - size / 2, size, size);
      }
    } else {
      for (const g of artifacts.groups) {
        ctx.fillStyle = g.color || cfg.color;
        for (let i = 0; i < g.n; i++) {
          const x = g.xs[i]!, y = g.ys[i]!;
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          const { px, py } = project(x, y);
          ctx.fillRect(px - size / 2, py - size / 2, size, size);
        }
      }
    }
    ctx.globalAlpha = 1;
  },
  legendEntries(_cfg, artifacts) {
    if (artifacts.groups.length <= 1) return [];
    return artifacts.groups.map((g) => ({ color: g.color, label: g.groupKey || "(default)" }));
  },
  Editor: ({ config, onChange }) => (
    <>
      <Row label="color">
        <input type="color" value={config.color}
          onChange={(e) => onChange({ ...config, color: e.target.value })} className="w-24" />
      </Row>
      <Row label="point size">
        <input type="number" min={1} max={6} step={1} value={config.pointSize}
          onChange={(e) => onChange({ ...config, pointSize: Number(e.target.value) })}
          className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1" />
      </Row>
      <Row label="alpha">
        <input type="number" min={0} max={1} step={0.1} value={config.alpha}
          onChange={(e) => onChange({ ...config, alpha: Number(e.target.value) })}
          className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1" />
      </Row>
      <Row label="trail (time-color)">
        <input type="checkbox" checked={config.trail}
          onChange={(e) => onChange({ ...config, trail: e.target.checked })} />
      </Row>
    </>
  ),
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-[#D8DCE2] py-0.5">
      <span className="text-[#7B8088]">{label}</span>
      {children}
    </label>
  );
}

register(scatterOverlay);

function lerpColor(aHex: string, bHex: string, t: number): string {
  const a = parseInt(aHex.slice(1), 16), b = parseInt(bHex.slice(1), 16);
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${bl})`;
}
