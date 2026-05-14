import type { ReactNode } from "react";
import { percentile } from "@helios/lib";
import type { OverlayModule, FrictionCircleConfig } from "../types";
import { register } from "./registry";

interface Ring {
  percentile: number;     // 0..100
  radius: number;         // data-space, sqrt(x² + y²)
}

interface FrictionCircleArtifact {
  rings: Ring[];
  /** Total finite samples that fed the computation; surfaced in the
   *  legend so the user can see how many points the envelope rests on. */
  sampleCount: number;
}

const SAMPLE_COUNT = 96;

export const frictionCircleOverlay: OverlayModule<FrictionCircleConfig, FrictionCircleArtifact> = {
  kind: "friction-circle",
  availability: ["advanced"],
  defaultConfig() {
    return {
      percentiles: [100, 99],   // peak + 99th — the standard pair
      color: "#26A69A",
      lineWidth: 1.5,
      dashed: true,
      showLabels: true,
    };
  },
  compute(groups, cfg) {
    // Defensive default: configs saved before this schema (when the field
    // was `radii: number[]`) won't have `percentiles`. Fall back to the
    // factory default so they don't crash the whole app.
    const requestedPercentiles = cfg.percentiles ?? [100, 99];
    // Pool magnitudes across every group. Filter / group-by / zoom were
    // already applied by the data pipeline, so this is exactly the set
    // of samples currently visible.
    const mags: number[] = [];
    let peak = 0;
    for (const g of groups) {
      for (let i = 0; i < g.n; i++) {
        const x = g.xs[i]!, y = g.ys[i]!;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const m = Math.sqrt(x * x + y * y);
        mags.push(m);
        if (m > peak) peak = m;
      }
    }
    const rings: Ring[] = [];
    for (const p of requestedPercentiles) {
      if (!Number.isFinite(p) || p < 0 || p > 100) continue;
      const radius = mags.length === 0 ? 0 : (p === 100 ? peak : percentile(mags, p));
      if (radius > 0) rings.push({ percentile: p, radius });
    }
    return { rings, sampleCount: mags.length };
  },
  draw(ctx, layout, artifacts, cfg) {
    if (artifacts.rings.length === 0) return;
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = cfg.lineWidth;
    ctx.setLineDash(cfg.dashed ? [4, 3] : []);
    for (const ring of artifacts.rings) {
      ctx.beginPath();
      for (let i = 0; i <= SAMPLE_COUNT; i++) {
        const theta = (i / SAMPLE_COUNT) * Math.PI * 2;
        const dx = ring.radius * Math.cos(theta);
        const dy = ring.radius * Math.sin(theta);
        const { px, py } = layout.project(dx, dy);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      if (cfg.showLabels) {
        // Label on the +x axis side of the ring.
        const { px, py } = layout.project(ring.radius, 0);
        ctx.fillStyle = cfg.color;
        ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const tag = ring.percentile === 100 ? "peak" : `p${ring.percentile}`;
        ctx.fillText(`${tag}: ${ring.radius.toFixed(3)}`, px + 4, py - 6);
      }
    }
    ctx.setLineDash([]);
  },
  legendEntries(cfg, artifacts) {
    if (artifacts.rings.length === 0) return [{ color: cfg.color, label: "friction circle (no data)" }];
    const summary = artifacts.rings.map((r) => {
      const tag = r.percentile === 100 ? "peak" : `p${r.percentile}`;
      return `${tag}=${r.radius.toFixed(3)}`;
    }).join(", ");
    return [{ color: cfg.color, label: `friction circle (${summary})` }];
  },
  Editor: ({ config, onChange }) => {
    // Defensive read: legacy configs (pre-percentile schema) won't have
    // this field. Use the default so the editor renders something the
    // user can interact with rather than crashing.
    const percentiles = config.percentiles ?? [100, 99];
    const updatePercentile = (idx: number, val: number) => {
      const next = [...percentiles];
      next[idx] = val;
      onChange({ ...config, percentiles: next });
    };
    const removePercentile = (idx: number) => {
      onChange({ ...config, percentiles: percentiles.filter((_, i) => i !== idx) });
    };
    const addPercentile = () => {
      const last = percentiles[percentiles.length - 1] ?? 100;
      const next = Math.max(0, Math.min(100, last - 5));
      onChange({ ...config, percentiles: [...percentiles, next] });
    };
    return (
      <>
        <div className="flex flex-col gap-0.5">
          <span className="text-[#9097A0] text-[11px]">percentile rings (100 = peak)</span>
          {percentiles.map((p, i) => (
            <div key={i} className="flex items-center gap-1 text-[11px]">
              <input type="number" min={0} max={100} step={1} value={p}
                onChange={(e) => updatePercentile(i, Number(e.target.value))}
                className="w-20 bg-[#0E0E10] border border-[#2A2C32] px-1" />
              <button onClick={() => removePercentile(i)}
                disabled={percentiles.length <= 1}
                className="px-1 text-[#EF5350] disabled:opacity-30">✕</button>
            </div>
          ))}
          <button onClick={addPercentile}
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
      <span className="text-[#9097A0]">{label}</span>
      {children}
    </label>
  );
}
