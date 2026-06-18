import type { ReactNode } from "react";
import { parseExpr, evalAst, linspace, type Ast } from "@helios/lib";
import type { OverlayModule, FormulaConfig } from "../types";
import { register } from "./registry";

interface FormulaArtifact {
  sampleX: Float64Array;
  sampleY: Float64Array;
  /** Compile-error message; null = OK. */
  error: string | null;
}

const SAMPLE_COUNT = 200;
// Keyed by raw expression text, so cap + LRU-evict to stop the cache growing
// unbounded as the user types the formula out character by character.
const CACHE_MAX = 64;
const cache = new Map<string, { ast: Ast | null; error: string | null }>();
function compile(expr: string): { ast: Ast | null; error: string | null } {
  const cached = cache.get(expr);
  if (cached) {
    // Refresh recency: delete + re-set moves the key to the end (newest).
    cache.delete(expr);
    cache.set(expr, cached);
    return cached;
  }
  const result = parseExpr(expr);
  const entry = { ast: result.ast ?? null, error: result.error ?? null };
  cache.set(expr, entry);
  if (cache.size > CACHE_MAX) {
    // Evict the oldest (first-inserted) entry — Map preserves insertion order.
    cache.delete(cache.keys().next().value!);
  }
  return entry;
}

export const formulaOverlay: OverlayModule<FormulaConfig, FormulaArtifact> = {
  kind: "formula",
  availability: ["advanced"],
  defaultConfig() {
    return { expression: "x", color: "#26A69A", lineWidth: 1.5, dashed: true };
  },
  compute(_groups, cfg, ctx) {
    const compiled = compile(cfg.expression || "");
    if (!compiled.ast) {
      return { sampleX: new Float64Array(0), sampleY: new Float64Array(0), error: compiled.error ?? "empty expression" };
    }
    const sampleX = linspace(ctx.bounds.xmin, ctx.bounds.xmax, SAMPLE_COUNT);
    const sampleY = new Float64Array(SAMPLE_COUNT);
    let xVal = 0;
    const resolve = (name: string): number | undefined => name === "x" ? xVal : undefined;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      xVal = sampleX[i]!;
      try { sampleY[i] = Number(evalAst(compiled.ast, resolve)); }
      catch { sampleY[i] = NaN; }
    }
    return { sampleX, sampleY, error: null };
  },
  draw(ctx, layout, artifacts, cfg) {
    if (artifacts.error) {
      ctx.fillStyle = "rgba(239, 83, 80, 0.85)";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(`formula: ${artifacts.error}`, layout.padL + 4, layout.padT + 4);
      return;
    }
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = cfg.lineWidth;
    ctx.setLineDash(cfg.dashed ? [4, 3] : []);
    ctx.beginPath();
    let drawing = false;
    for (let i = 0; i < artifacts.sampleX.length; i++) {
      const y = artifacts.sampleY[i]!;
      if (!Number.isFinite(y)) { drawing = false; continue; }
      const { px, py } = layout.project(artifacts.sampleX[i]!, y);
      if (!drawing) { ctx.moveTo(px, py); drawing = true; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  },
  legendEntries(cfg) {
    return [{ color: cfg.color, label: `y = ${cfg.expression}` }];
  },
  Editor: ({ config, onChange }) => (
    <>
      <Row label="expression (y = …)">
        <input type="text" value={config.expression}
          onChange={(e) => onChange({ ...config, expression: e.target.value })}
          placeholder="x"
          className="w-44 bg-[#0E0E10] border border-[#2A2C32] px-1 font-mono text-[11px]" />
      </Row>
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

register(formulaOverlay);
