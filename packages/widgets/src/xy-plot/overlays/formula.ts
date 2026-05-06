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
const cache = new Map<string, { ast: Ast | null; error: string | null }>();
function compile(expr: string): { ast: Ast | null; error: string | null } {
  if (cache.has(expr)) return cache.get(expr)!;
  const result = parseExpr(expr);
  const entry = { ast: result.ast ?? null, error: result.error ?? null };
  cache.set(expr, entry);
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
  Editor: () => null,
};

register(formulaOverlay);
