import type { ChannelMeta, ChannelStore } from "@helios/store";
import { parseExpr, evalAst, type Ast } from "@helios/lib";
import {
  derivative, integral, shift, smooth, lowpass,
  VECTOR_OPS, LAP_OPS,
} from "./vector-ops";

/** A user-defined channel computed from existing channels via an expression.
 *  Persisted globally — the same set is applied to every session loaded. */
export interface MathChannel {
  id: string;          // canonical id, e.g. "math.power"
  display_name: string;
  units: string;
  decimals: number;
  color: string;
  group: string;       // e.g. "Math"
  expression: string;  // e.g. "engine.rpm * imu.lat_g / 9549"
  min?: number;
  max?: number;
  warn?: number;
  alarm?: number;
}

const STORAGE_KEY = "helios.math-channels.v1";

interface StoredState {
  version: 1;
  channels: MathChannel[];
}

export function loadMathChannels(): MathChannel[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as StoredState;
    if (parsed?.version === 1 && Array.isArray(parsed.channels)) return parsed.channels;
  } catch { /* fall through */ }
  return [];
}

export function saveMathChannels(channels: MathChannel[]): void {
  if (typeof localStorage === "undefined") return;
  const state: StoredState = { version: 1, channels };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export interface ApplyResult {
  /** Math-channel id → first error encountered while compiling/applying it. */
  errors: Map<string, string>;
}

/** Compile every math channel and add it to the store as a real channel.
 *  Math channels are evaluated in declaration order, so a math channel may
 *  reference an earlier math channel if needed. */
export function applyMathChannels(
  store: ChannelStore,
  channels: MathChannel[],
): ApplyResult {
  const errors = new Map<string, string>();
  for (const mc of channels) {
    try {
      compileAndApplyOne(store, mc);
    } catch (e) {
      errors.set(mc.id, e instanceof Error ? e.message : String(e));
    }
  }
  return { errors };
}

interface PreprocessCtx {
  baseTime: BigInt64Array;
  baseRateHz: number;
  /** Same-rate-group dependency arrays (one entry per sample, indexed by `i`). */
  sameGroupCols: Map<string, Float64Array>;
  /** Cross-rate-group dependencies; sampled per-base-time-index via binary search. */
  crossGroupCols: Array<{ name: string; times: BigInt64Array; values: Float64Array }>;
  /** Synthetic Float64Arrays produced by the vector pre-pass; later evaluator
   *  calls treat these as same-rate-group dependencies. */
  synthetics: Map<string, Float64Array>;
  synthCounter: { n: number };
}

function compileAndApplyOne(store: ChannelStore, mc: MathChannel): void {
  const parsed = parseExpr(mc.expression);
  if (!parsed.ast) throw new Error(parsed.error ?? "parse error");

  // Identifier set excludes vector-op function names (those are calls, not idents).
  const refs = parsed.refs;

  // No external refs → constant expression. Pin to first rate group.
  if (refs.length === 0 && !astContainsVectorOp(parsed.ast)) {
    const groups = store.groups();
    if (groups.length === 0) throw new Error("no rate groups loaded");
    const base = groups[0]!;
    const value = evalAst(parsed.ast, () => undefined);
    const values = new Float64Array(base.time.length).fill(value);
    store.addChannel(base.id, makeMeta(mc, base.nominalRateHz), values);
    return;
  }

  // Resolve which rate group each referenced channel lives in.
  const refGroups = new Map<string, ReturnType<typeof store.groupOf>>();
  for (const ref of refs) {
    const g = store.groupOf(ref);
    if (!g) throw new Error(`unknown channel "${ref}"`);
    refGroups.set(ref, g);
  }

  // Pick the base — highest-rate dep wins so we don't lose information.
  let base: NonNullable<ReturnType<typeof store.groupOf>> | undefined;
  for (const g of refGroups.values()) {
    if (!g) continue;
    if (!base || g.time.length > base.time.length) base = g;
  }
  // No real refs but vector-op (e.g. constant arg) — fall back to first group.
  if (!base) {
    const groups = store.groups();
    if (groups.length === 0) throw new Error("no rate groups loaded");
    base = groups[0]!;
  }

  // Bucket dependencies by same-group / cross-group.
  const sameGroupCols = new Map<string, Float64Array>();
  const crossGroupCols: PreprocessCtx["crossGroupCols"] = [];
  for (const ref of refs) {
    const g = refGroups.get(ref)!;
    const col = g.columns.get(ref);
    if (!col) throw new Error(`channel "${ref}" missing data`);
    if (g.id === base.id) sameGroupCols.set(ref, col);
    else crossGroupCols.push({ name: ref, times: g.time, values: col });
  }

  // Pre-pass vector ops: rewrite the AST so each derivative/integral/smooth/…
  // call becomes a reference to a precomputed synthetic Float64Array.
  const ctx: PreprocessCtx = {
    baseTime: base.time,
    baseRateHz: base.nominalRateHz,
    sameGroupCols,
    crossGroupCols,
    synthetics: new Map(),
    synthCounter: { n: 0 },
  };
  const ast = preprocessVectorOps(parsed.ast, ctx);

  // Per-sample evaluation against the rewritten AST.
  const out = evaluateVector(ast, ctx);
  store.addChannel(base.id, makeMeta(mc, base.nominalRateHz), out);
}

/** Walk an AST and return a copy with every vector-op call replaced by an
 *  ident referencing a stashed synthetic Float64Array. Throws on `lap_*`. */
function preprocessVectorOps(ast: Ast, ctx: PreprocessCtx): Ast {
  switch (ast.kind) {
    case "num":
    case "ident":
      return ast;
    case "neg": return { kind: "neg", arg: preprocessVectorOps(ast.arg, ctx) };
    case "not": return { kind: "not", arg: preprocessVectorOps(ast.arg, ctx) };
    case "binop":
      return {
        kind: "binop", op: ast.op,
        lhs: preprocessVectorOps(ast.lhs, ctx),
        rhs: preprocessVectorOps(ast.rhs, ctx),
      };
    case "ternary":
      return {
        kind: "ternary",
        cond: preprocessVectorOps(ast.cond, ctx),
        then: preprocessVectorOps(ast.then, ctx),
        else: preprocessVectorOps(ast.else, ctx),
      };
    case "call": {
      if (LAP_OPS.has(ast.name)) {
        throw new Error(`${ast.name}() needs lap detection, which is not implemented yet`);
      }
      if (VECTOR_OPS.has(ast.name)) {
        return computeVectorOp(ast, ctx);
      }
      return {
        kind: "call", name: ast.name,
        args: ast.args.map((a) => preprocessVectorOps(a, ctx)),
      };
    }
  }
}

/** Extract a single Float64Array from an AST that no longer contains vector
 *  ops, by evaluating it once per sample over the base time array. */
function evaluateVector(ast: Ast, ctx: PreprocessCtx): Float64Array {
  const N = ctx.baseTime.length;
  const out = new Float64Array(N);
  const sampleVals: Record<string, number | undefined> = Object.create(null);
  // Synthetic channels stay constant across the loop body, so prebind their
  // arrays once.
  for (let i = 0; i < N; i++) {
    for (const [name, col] of ctx.sameGroupCols) sampleVals[name] = col[i]!;
    for (const [name, col] of ctx.synthetics) sampleVals[name] = col[i]!;
    if (ctx.crossGroupCols.length > 0) {
      const t = ctx.baseTime[i]!;
      for (const cg of ctx.crossGroupCols) {
        sampleVals[cg.name] = sampleAtBigTime(cg.times, cg.values, t);
      }
    }
    out[i] = evalAst(ast, (n) => sampleVals[n]);
  }
  return out;
}

function computeVectorOp(call: Ast & { kind: "call" }, ctx: PreprocessCtx): Ast {
  // First arg is the input expression; recursively preprocess so nested
  // vector ops (e.g. `derivative(smooth(x, 5))`) are handled.
  const inner = call.args[0];
  if (!inner) throw new Error(`${call.name}() needs an argument`);
  const innerProcessed = preprocessVectorOps(inner, ctx);
  const innerValues = evaluateVector(innerProcessed, ctx);

  let result: Float64Array;
  switch (call.name) {
    case "derivative":
      result = derivative(innerValues, ctx.baseTime);
      break;
    case "integral":
      result = integral(innerValues, ctx.baseTime);
      break;
    case "shift": {
      const dt = constNumberArg(call, 1, "dt_seconds");
      result = shift(innerValues, ctx.baseTime, dt);
      break;
    }
    case "smooth": {
      const win = constNumberArg(call, 1, "window_samples");
      result = smooth(innerValues, win);
      break;
    }
    case "lowpass": {
      const fc = constNumberArg(call, 1, "fc_hz");
      result = lowpass(innerValues, fc, ctx.baseRateHz);
      break;
    }
    default:
      throw new Error(`vector op ${call.name}() not implemented`);
  }

  const name = `__v${ctx.synthCounter.n++}`;
  ctx.synthetics.set(name, result);
  return { kind: "ident", name };
}

/** Evaluate a single AST argument as a constant number. The arg must not
 *  reference any channel (it's not sample-dependent). Useful for scalar
 *  parameters like `smooth(x, 5)` or `shift(x, 0.25)`. */
function constNumberArg(call: Ast & { kind: "call" }, index: number, paramName: string): number {
  const arg = call.args[index];
  if (!arg) throw new Error(`${call.name}() needs ${paramName}`);
  // No resolver — any ident becomes NaN, which we'll catch.
  const v = evalAst(arg, () => undefined);
  if (!Number.isFinite(v)) {
    throw new Error(`${call.name}() ${paramName} must be a finite constant, got ${v}`);
  }
  return v;
}

/** Quick AST check used to short-circuit constant-only expressions before
 *  the rate-group resolution path. */
function astContainsVectorOp(ast: Ast): boolean {
  switch (ast.kind) {
    case "num": case "ident": return false;
    case "neg": case "not": return astContainsVectorOp(ast.arg);
    case "binop": return astContainsVectorOp(ast.lhs) || astContainsVectorOp(ast.rhs);
    case "ternary":
      return astContainsVectorOp(ast.cond)
          || astContainsVectorOp(ast.then)
          || astContainsVectorOp(ast.else);
    case "call":
      if (VECTOR_OPS.has(ast.name) || LAP_OPS.has(ast.name)) return true;
      return ast.args.some(astContainsVectorOp);
  }
}

function makeMeta(mc: MathChannel, sampleRateHz: number): ChannelMeta {
  return {
    id: mc.id,
    display_name: mc.display_name,
    units: mc.units,
    group: mc.group || "Math",
    color: mc.color,
    decimals: mc.decimals,
    data_type: "f64",
    source: "math",
    sample_rate_hz: sampleRateHz,
    min: mc.min,
    max: mc.max,
    warn: mc.warn,
    alarm: mc.alarm,
  };
}

function sampleAtBigTime(times: BigInt64Array, values: Float64Array, t: bigint): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! <= t) lo = mid + 1; else hi = mid;
  }
  const idx = Math.max(0, lo - 1);
  return values[idx]!;
}

export function defaultMathChannel(existingIds: string[]): MathChannel {
  let id = "math.new";
  for (let i = 1; existingIds.includes(id); i++) id = `math.new-${i}`;
  return {
    id,
    display_name: "New math channel",
    units: "",
    decimals: 2,
    color: "#FFC627",
    group: "Math",
    expression: "0",
  };
}

export function isValidMathChannelId(id: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(id);
}

export function checkExpression(src: string): { ok: true; refs: string[]; ast: Ast } | { ok: false; error: string } {
  const r = parseExpr(src);
  if (!r.ast) return { ok: false, error: r.error ?? "parse error" };
  return { ok: true, refs: r.refs, ast: r.ast };
}
