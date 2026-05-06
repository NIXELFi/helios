import type { ReactNode } from "react";
import { mean, stddev, correlation } from "@helios/lib";
import type { OverlayModule, StatsConfig } from "../types";
import { register } from "./registry";

interface StatsArtifact {
  count: number;
  meanX: number;
  meanY: number;
  stdX: number;
  stdY: number;
  correlation: number;
  fitRSquared: number | null;
  fitEquation: string | null;
  position: StatsConfig["position"];
  show: StatsConfig["show"];
}

interface ReferencedFitArtifact {
  fits: Array<{ rSquared: number; coefficients: number[] }>;
}

export const statsOverlay: OverlayModule<StatsConfig, StatsArtifact> = {
  kind: "stats",
  availability: ["advanced"],
  defaultConfig() {
    return {
      position: "top-right",
      show: { count: true, meanXY: true, stdXY: true,
              correlation: true, fitRSquared: false, fitEquation: false },
    };
  },
  compute(groups, cfg, ctx) {
    let totalN = 0;
    for (const g of groups) totalN += g.n;
    const xs = new Float64Array(totalN);
    const ys = new Float64Array(totalN);
    let off = 0;
    for (const g of groups) { xs.set(g.xs, off); ys.set(g.ys, off); off += g.n; }

    let fitRSquared: number | null = null;
    let fitEquation: string | null = null;
    if (cfg.fitOverlayId) {
      const fitArt = ctx.priorArtifacts.get(cfg.fitOverlayId) as ReferencedFitArtifact | undefined;
      if (fitArt && fitArt.fits.length > 0) {
        fitRSquared = fitArt.fits[0]!.rSquared;
        fitEquation = formatEquation(fitArt.fits[0]!.coefficients);
      }
    }

    return {
      count: totalN,
      meanX: mean(xs), meanY: mean(ys),
      stdX: stddev(xs), stdY: stddev(ys),
      correlation: correlation(xs, ys),
      fitRSquared, fitEquation,
      position: cfg.position,
      show: cfg.show,
    };
  },
  Component({ artifacts }) {
    const lines: string[] = [];
    if (artifacts.show.count) lines.push(`n = ${artifacts.count}`);
    if (artifacts.show.meanXY) lines.push(`x̄ = ${fmt(artifacts.meanX)}    ȳ = ${fmt(artifacts.meanY)}`);
    if (artifacts.show.stdXY) lines.push(`σx = ${fmt(artifacts.stdX)}   σy = ${fmt(artifacts.stdY)}`);
    if (artifacts.show.correlation) lines.push(`r = ${fmt(artifacts.correlation)}`);
    if (artifacts.show.fitRSquared) lines.push(`R² = ${artifacts.fitRSquared !== null ? fmt(artifacts.fitRSquared) : "—"}`);
    if (artifacts.show.fitEquation) lines.push(artifacts.fitEquation ?? "");
    const posClass = positionClass(artifacts.position);
    return (
      <div
        className={`absolute ${posClass} m-2 px-2 py-1 text-[10px] font-mono-num leading-tight bg-[#0E0E10cc] text-[#D8DCE2] border border-[#2A2C32] rounded-sm pointer-events-auto select-text`}
        style={{ whiteSpace: "pre" }}
      >
        {lines.join("\n")}
      </div>
    );
  },
  Editor: ({ config, onChange }) => (
    <>
      <Row label="position">
        <select value={config.position}
          onChange={(e) => onChange({ ...config, position: e.target.value as typeof config.position })}
          className="bg-[#0E0E10] border border-[#2A2C32] px-1 text-[11px]">
          <option value="top-left">top left</option>
          <option value="top-right">top right</option>
          <option value="bottom-left">bottom left</option>
          <option value="bottom-right">bottom right</option>
        </select>
      </Row>
      {(["count", "meanXY", "stdXY", "correlation", "fitRSquared", "fitEquation"] as const).map((k) => (
        <Row key={k} label={`show ${k}`}>
          <input type="checkbox" checked={config.show[k]}
            onChange={(e) => onChange({ ...config, show: { ...config.show, [k]: e.target.checked } })} />
        </Row>
      ))}
      <Row label="fit overlay id">
        <input type="text" value={config.fitOverlayId ?? ""}
          onChange={(e) => onChange({ ...config, fitOverlayId: e.target.value || undefined })}
          placeholder="(none)"
          className="w-32 bg-[#0E0E10] border border-[#2A2C32] px-1 font-mono text-[11px]" />
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

register(statsOverlay);

function fmt(v: number): string { return Number.isFinite(v) ? v.toFixed(3) : "—"; }

function positionClass(pos: StatsConfig["position"]): string {
  switch (pos) {
    case "top-left":     return "top-0 left-0";
    case "top-right":    return "top-0 right-0";
    case "bottom-left":  return "bottom-0 left-0";
    case "bottom-right": return "bottom-0 right-0";
  }
}

function formatEquation(coefficients: number[]): string {
  if (coefficients.length === 0) return "";
  if (coefficients.length === 2) return `y = ${fmt(coefficients[0]!)} + ${fmt(coefficients[1]!)}·x`;
  return `y = ${coefficients.map((c, i) => `${fmt(c)}·x^${i}`).join(" + ")}`;
}
