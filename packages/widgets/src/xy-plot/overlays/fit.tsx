import type { ReactNode } from "react";
import { fitLinear, fitPolynomial, fitExponential, fitLogarithmic, fitPower, linspace, type FitResult } from "@helios/lib";
import type { OverlayModule, SessionGroup, FitConfig, FitKind, OverlayContext } from "../types";
import { register } from "./registry";

interface PerGroupFit {
  groupKey: string;
  color: string;
  coefficients: number[];
  rSquared: number;
  residualStd: number;
  sampleX: Float64Array;
  sampleY: Float64Array;
}

interface FitArtifact {
  fits: PerGroupFit[];
  warnings: string[];
}

const SAMPLE_COUNT = 200;

export const fitOverlay: OverlayModule<FitConfig, FitArtifact> = {
  kind: "fit",
  availability: ["advanced"],
  defaultConfig() {
    return {
      kind: { type: "linear" },
      color: "#FFC627",
      lineWidth: 1.5,
      showBand: false,
      extrapolate: false,
      perGroup: false,
    };
  },
  compute(groups, cfg, ctx: OverlayContext) {
    const fits: PerGroupFit[] = [];
    const warnings: string[] = [];
    const buckets = cfg.perGroup ? groupBy(groups, (g) => g.groupKey) : [{ key: "", groups }];
    for (const { key, groups: bucketGroups } of buckets) {
      let totalN = 0;
      for (const g of bucketGroups) totalN += g.n;
      const xs = new Float64Array(totalN);
      const ys = new Float64Array(totalN);
      let off = 0;
      for (const g of bucketGroups) { xs.set(g.xs, off); ys.set(g.ys, off); off += g.n; }

      const result = runFit(cfg.kind, xs, ys);
      if (result.coefficients.length === 0) {
        warnings.push(`${key || "fit"}: no fit (${result.validSamples} samples)`);
        continue;
      }
      const lo = cfg.extrapolate ? ctx.bounds.xmin : minFinite(xs);
      const hi = cfg.extrapolate ? ctx.bounds.xmax : maxFinite(xs);
      const sampleX = linspace(lo, hi, SAMPLE_COUNT);
      const sampleY = new Float64Array(SAMPLE_COUNT);
      for (let i = 0; i < SAMPLE_COUNT; i++) sampleY[i] = result.predict(sampleX[i]!);
      fits.push({
        groupKey: key,
        color: bucketGroups[0]?.color ?? cfg.color,
        coefficients: result.coefficients,
        rSquared: result.rSquared,
        residualStd: result.residualStd,
        sampleX, sampleY,
      });
    }
    return { fits, warnings };
  },
  draw(ctx, layout, artifacts, cfg) {
    for (const f of artifacts.fits) {
      if (cfg.showBand && f.residualStd > 0) {
        ctx.fillStyle = withAlpha(cfg.color, 0.12);
        ctx.beginPath();
        for (let i = 0; i < f.sampleX.length; i++) {
          const { px, py } = layout.project(f.sampleX[i]!, f.sampleY[i]! + f.residualStd);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        for (let i = f.sampleX.length - 1; i >= 0; i--) {
          const { px, py } = layout.project(f.sampleX[i]!, f.sampleY[i]! - f.residualStd);
          ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = cfg.perGroup ? f.color : cfg.color;
      ctx.lineWidth = cfg.lineWidth;
      ctx.beginPath();
      for (let i = 0; i < f.sampleX.length; i++) {
        const { px, py } = layout.project(f.sampleX[i]!, f.sampleY[i]!);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  },
  legendEntries(cfg, artifacts) {
    return artifacts.fits.map((f) => ({
      color: cfg.perGroup ? f.color : cfg.color,
      label: `${describeFitKind(cfg.kind)}${f.groupKey ? " [" + f.groupKey + "]" : ""}  R²=${f.rSquared.toFixed(3)}`,
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
      <Row label="extrapolate to bounds">
        <input type="checkbox" checked={config.extrapolate}
          onChange={(e) => onChange({ ...config, extrapolate: e.target.checked })} />
      </Row>
      <Row label="per group-by group">
        <input type="checkbox" checked={config.perGroup}
          onChange={(e) => onChange({ ...config, perGroup: e.target.checked })} />
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

register(fitOverlay);

function runFit(kind: FitKind, xs: Float64Array, ys: Float64Array): FitResult {
  switch (kind.type) {
    case "linear":      return fitLinear(xs, ys);
    case "polynomial":  return fitPolynomial(xs, ys, kind.degree);
    case "exponential": return fitExponential(xs, ys);
    case "logarithmic": return fitLogarithmic(xs, ys);
    case "power":       return fitPower(xs, ys);
  }
}

function describeFitKind(k: FitKind): string {
  switch (k.type) {
    case "polynomial": return `poly d=${k.degree}`;
    default:           return k.type;
  }
}

function groupBy<T>(items: T[], keyFn: (t: T) => string): Array<{ key: string; groups: T[] }> {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    let bucket = m.get(key);
    if (!bucket) { bucket = []; m.set(key, bucket); }
    bucket.push(item);
  }
  return [...m.entries()].map(([key, groups]) => ({ key, groups }));
}

function minFinite(xs: Float64Array): number {
  let m = Infinity;
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i]!) && xs[i]! < m) m = xs[i]!;
  return Number.isFinite(m) ? m : 0;
}
function maxFinite(xs: Float64Array): number {
  let m = -Infinity;
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i]!) && xs[i]! > m) m = xs[i]!;
  return Number.isFinite(m) ? m : 0;
}

function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith("#") || hex.length !== 7) return hex;
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 0xff},${(v >> 8) & 0xff},${v & 0xff},${alpha})`;
}

export type _ = SessionGroup;
