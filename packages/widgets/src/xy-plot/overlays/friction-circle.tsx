import type { ReactNode } from "react";
import type { OverlayModule, FrictionCircleConfig } from "../types";
import { register } from "./registry";

interface FrictionCircleArtifact {
  radii: number[];
}

const SAMPLE_COUNT = 96;

export const frictionCircleOverlay: OverlayModule<FrictionCircleConfig, FrictionCircleArtifact> = {
  kind: "friction-circle",
  availability: ["advanced"],
  defaultConfig() {
    return {
      radii: [1],         // 1g — the canonical g-g circle
      color: "#26A69A",
      lineWidth: 1.5,
      dashed: true,
      showLabels: true,
    };
  },
  compute(_groups, cfg) {
    return { radii: cfg.radii.filter((r) => Number.isFinite(r) && r > 0) };
  },
  draw(ctx, layout, artifacts, cfg) {
    if (artifacts.radii.length === 0) return;
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = cfg.lineWidth;
    ctx.setLineDash(cfg.dashed ? [4, 3] : []);
    for (const r of artifacts.radii) {
      ctx.beginPath();
      for (let i = 0; i <= SAMPLE_COUNT; i++) {
        const theta = (i / SAMPLE_COUNT) * Math.PI * 2;
        const dx = r * Math.cos(theta);
        const dy = r * Math.sin(theta);
        const { px, py } = layout.project(dx, dy);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      if (cfg.showLabels) {
        // Label on the +x axis side of the ring.
        const { px, py } = layout.project(r, 0);
        ctx.fillStyle = cfg.color;
        ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(`${r}`, px + 4, py - 6);
      }
    }
    ctx.setLineDash([]);
  },
  legendEntries(cfg) {
    return [{ color: cfg.color, label: `friction circle (${cfg.radii.join(", ")})` }];
  },
  Editor: ({ config, onChange }) => {
    const updateRadius = (idx: number, val: number) => {
      const next = [...config.radii];
      next[idx] = val;
      onChange({ ...config, radii: next });
    };
    const removeRadius = (idx: number) => {
      onChange({ ...config, radii: config.radii.filter((_, i) => i !== idx) });
    };
    const addRadius = () => {
      const last = config.radii[config.radii.length - 1] ?? 1;
      onChange({ ...config, radii: [...config.radii, last + 0.5] });
    };
    return (
      <>
        <div className="flex flex-col gap-0.5">
          <span className="text-[#7B8088] text-[11px]">radii (data units)</span>
          {config.radii.map((r, i) => (
            <div key={i} className="flex items-center gap-1 text-[11px]">
              <input type="number" step={0.1} value={r}
                onChange={(e) => updateRadius(i, Number(e.target.value))}
                className="w-20 bg-[#0E0E10] border border-[#2A2C32] px-1" />
              <button onClick={() => removeRadius(i)}
                disabled={config.radii.length <= 1}
                className="px-1 text-[#EF5350] disabled:opacity-30">✕</button>
            </div>
          ))}
          <button onClick={addRadius}
            className="self-start px-2 py-0.5 text-[10px] border border-[#2A2C32] bg-[#16171B] text-[#FFC627] hover:border-[#FFC627] rounded-sm cursor-pointer">
            + Add ring
          </button>
        </div>
        <Row label="color">
          <input type="color" value={config.color}
            onChange={(e) => onChange({ ...config, color: e.target.value })} className="w-24" />
        </Row>
        <Row label="line width">
          <input type="number" min={1} max={5} step={0.5} value={config.lineWidth}
            onChange={(e) => onChange({ ...config, lineWidth: Number(e.target.value) })}
            className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1" />
        </Row>
        <Row label="dashed">
          <input type="checkbox" checked={config.dashed}
            onChange={(e) => onChange({ ...config, dashed: e.target.checked })} />
        </Row>
        <Row label="show labels">
          <input type="checkbox" checked={config.showLabels}
            onChange={(e) => onChange({ ...config, showLabels: e.target.checked })} />
        </Row>
      </>
    );
  },
};

register(frictionCircleOverlay);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-[#D8DCE2] py-0.5">
      <span className="text-[#7B8088]">{label}</span>
      {children}
    </label>
  );
}
