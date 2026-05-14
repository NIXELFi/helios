import type { ReactNode } from "react";
import { fitLinear, fitPolynomial, fitExponential, fitLogarithmic, fitPower, linspace, type FitResult } from "@helios/lib";
import type { OverlayModule, QuadrantFitConfig, SessionGroup, FitKind } from "../types";
import { register } from "./registry";

interface PerQuadrant {
  label: "Q1" | "Q2" | "Q3" | "Q4";
  xSign: 1 | -1;
  ySign: 1 | -1;
  coefficients: number[];
  rSquared: number;
  residualStd: number;
  sampleX: Float64Array;
  sampleY: Float64Array;
}

interface QuadrantFitArtifact {
  quadrants: PerQuadrant[];
}

const SAMPLE_COUNT = 100;
const QUADRANTS: Array<{ label: PerQuadrant["label"]; xSign: 1 | -1; ySign: 1 | -1 }> = [
  { label: "Q1", xSign:  1, ySign:  1 },
  { label: "Q2", xSign: -1, ySign:  1 },
  { label: "Q3", xSign: -1, ySign: -1 },
  { label: "Q4", xSign:  1, ySign: -1 },
];

export const quadrantFitOverlay: OverlayModule<QuadrantFitConfig, QuadrantFitArtifact> = {
  kind: "quadrant-fit",
  availability: ["advanced"],
  defaultConfig() {
    return {
      kind: { type: "linear" }, color: "#FFC627", lineWidth: 1.5,
      showBand: false, showStatsOverlay: false,
    };
  },
  compute(groups, cfg, ctx) {
    const out: PerQuadrant[] = [];
    for (const q of QUADRANTS) {
      const xs: number[] = [], ys: number[] = [];
      for (const g of groups) {
        for (let i = 0; i < g.n; i++) {
          const x = g.xs[i]!, y = g.ys[i]!;
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (Math.sign(x) !== q.xSign || Math.sign(y) !== q.ySign) continue;
          xs.push(x); ys.push(y);
        }
      }
      if (xs.length < 2) continue;
      const result = runFit(cfg.kind, Float64Array.from(xs), Float64Array.from(ys));
      if (result.coefficients.length === 0) continue;
      const lo = q.xSign > 0 ? 0 : ctx.bounds.xmin;
      const hi = q.xSign > 0 ? ctx.bounds.xmax : 0;
      const sampleX = linspace(lo, hi, SAMPLE_COUNT);
      const sampleY = new Float64Array(SAMPLE_COUNT);
      for (let i = 0; i < SAMPLE_COUNT; i++) sampleY[i] = result.predict(sampleX[i]!);
      out.push({
        label: q.label, xSign: q.xSign, ySign: q.ySign,
        coefficients: result.coefficients, rSquared: result.rSquared,
        residualStd: result.residualStd, sampleX, sampleY,
      });
    }
    return { quadrants: out };
  },
  draw(ctx, layout, artifacts, cfg) {
    for (const q of artifacts.quadrants) {
      if (cfg.showBand && q.residualStd > 0) {
        ctx.fillStyle = withAlpha(cfg.color, 0.10);
        ctx.beginPath();
        for (let i = 0; i < q.sampleX.length; i++) {
          const { px, py } = layout.project(q.sampleX[i]!, q.sampleY[i]! + q.residualStd);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        for (let i = q.sampleX.length - 1; i >= 0; i--) {
          const { px, py } = layout.project(q.sampleX[i]!, q.sampleY[i]! - q.residualStd);
          ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = cfg.color; ctx.lineWidth = cfg.lineWidth;
      ctx.beginPath();
      for (let i = 0; i < q.sampleX.length; i++) {
        const { px, py } = layout.project(q.sampleX[i]!, q.sampleY[i]!);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      if (cfg.showStatsOverlay) {
        const cornerX = q.xSign > 0 ? layout.padL + layout.plotW - 6 : layout.padL + 6;
        const cornerY = q.ySign > 0 ? layout.padT + 14 : layout.padT + layout.plotH - 6;
        ctx.fillStyle = "#D8DCE2"; ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = q.xSign > 0 ? "right" : "left";
        ctx.textBaseline = q.ySign > 0 ? "top" : "bottom";
        ctx.fillText(`${q.label} R²=${q.rSquared.toFixed(3)}`, cornerX, cornerY);
      }
    }
  },
  legendEntries(cfg, artifacts) {
    return artifacts.quadrants.map((q) => ({
      color: cfg.color,
      label: `${q.label} R²=${q.rSquared.toFixed(3)}`,
    }));
  },
  Editor: ({ config, onChange }) => (
    <>
      <Row label="kind">
        <select value={config.kind.type}
          onChange={(e) => {
            const t = e.target.value as FitKind["type"];
            const k: FitKind = t === "polynomial" ? { type: "polynomial", degree: 2 } : { type: t } as FitKind;
            onChange({ ...config, kind: k });
          }}
          className="bg-[#0E0E10] border border-[#2A2C32] px-1 text-[11px]">
          <option value="linear">linear</option>
          <option value="polynomial">polynomial</option>
          <option value="exponential">exponential</option>
          <option value="logarithmic">logarithmic</option>
          <option value="power">power</option>
        </select>
      </Row>
      {config.kind.type === "polynomial" && (
        <Row label="degree">
          <input type="number" min={1} max={6} value={config.kind.degree}
            onChange={(e) => onChange({ ...config, kind: { type: "polynomial", degree: Number(e.target.value) } })}
            className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1" />
        </Row>
      )}
      <Row label="color">
        <input type="color" value={config.color}
          onChange={(e) => onChange({ ...config, color: e.target.value })} className="w-24" />
      </Row>
      <Row label="line width">
        <input type="number" min={1} max={5} step={0.5} value={config.lineWidth}
          onChange={(e) => onChange({ ...config, lineWidth: Number(e.target.value) })}
          className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1" />
      </Row>
      <Row label="±σ band">
        <input type="checkbox" checked={config.showBand}
          onChange={(e) => onChange({ ...config, showBand: e.target.checked })} />
      </Row>
      <Row label="per-quadrant stats">
        <input type="checkbox" checked={config.showStatsOverlay}
          onChange={(e) => onChange({ ...config, showStatsOverlay: e.target.checked })} />
      </Row>
    </>
  ),
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-[#D8DCE2] py-0.5">
      <span className="text-[#9097A0]">{label}</span>
      {children}
    </label>
  );
}

register(quadrantFitOverlay);

function runFit(kind: FitKind, xs: Float64Array, ys: Float64Array): FitResult {
  switch (kind.type) {
    case "linear":      return fitLinear(xs, ys);
    case "polynomial":  return fitPolynomial(xs, ys, kind.degree);
    case "exponential": return fitExponential(xs, ys);
    case "logarithmic": return fitLogarithmic(xs, ys);
    case "power":       return fitPower(xs, ys);
  }
}

function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith("#") || hex.length !== 7) return hex;
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 0xff},${(v >> 8) & 0xff},${v & 0xff},${alpha})`;
}

export type _ = SessionGroup;
