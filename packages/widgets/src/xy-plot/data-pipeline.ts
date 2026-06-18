import { parseExpr, evalAst, type Ast } from "@helios/lib";
import type { OverlaySession } from "../types";
import type { SessionGroup } from "./types";

export interface PipelineInput {
  xChannelId: string;
  yChannelId: string;
  filter?: string;
  groupByChannelId?: string;
  zoomRange?: { startUs: number; endUs: number } | null;
}

const PALETTE = [
  "#FFC627", "#26A69A", "#EF5350", "#42A5F5",
  "#AB47BC", "#FFA726", "#66BB6A", "#EC407A",
];

/** Compile filter expressions on demand and cache. The cache lives at
 *  module scope so the same formula reused across renders is parsed
 *  once. Invalid formulas are cached as `null` so we don't reparse.
 *  Keyed by raw user text, so it's capped + LRU-evicted to stop it growing
 *  unbounded as the user edits the filter character by character. */
const EXPR_CACHE_MAX = 64;
const exprCache = new Map<string, Ast | null>();
function getCompiledFilter(text: string): Ast | null {
  const cached = exprCache.get(text);
  if (cached !== undefined || exprCache.has(text)) {
    // Refresh recency: delete + re-set moves the key to the end (newest).
    exprCache.delete(text);
    exprCache.set(text, cached ?? null);
    return cached ?? null;
  }
  const result = parseExpr(text);
  const ast = result.ast ?? null;
  exprCache.set(text, ast);
  if (exprCache.size > EXPR_CACHE_MAX) {
    // Evict the oldest (first-inserted) entry — Map preserves insertion order.
    exprCache.delete(exprCache.keys().next().value!);
  }
  return ast;
}

/** Run filter → group-by → zoom-clamp once over every visible session.
 *  Output is a flat list of (session × groupKey) buckets, each with
 *  packed Float64 arrays the overlays consume. */
export function buildSessionGroups(
  sessions: OverlaySession[],
  input: PipelineInput,
): SessionGroup[] {
  const out: SessionGroup[] = [];
  const filterAst = input.filter && input.filter.trim() ? getCompiledFilter(input.filter) : null;
  const groupChannel = input.groupByChannelId;

  // Deterministic palette assignment via first-seen ordering.
  const groupOrder: string[] = [];
  const groupIndex = new Map<string, number>();
  const ensureGroup = (key: string): number => {
    let idx = groupIndex.get(key);
    if (idx === undefined) { idx = groupOrder.length; groupOrder.push(key); groupIndex.set(key, idx); }
    return idx;
  };

  for (const session of sessions) {
    const xCol = session.slice.data.get(input.xChannelId);
    const yCol = session.slice.data.get(input.yChannelId);
    if (!xCol || !yCol) continue;
    const time = session.slice.time;
    const n = Math.min(xCol.length, yCol.length, time.length);
    const groupCol = groupChannel ? session.slice.data.get(groupChannel) : null;
    const dataMap = session.slice.data;

    const buffers = new Map<string, { time: number[]; xs: number[]; ys: number[] }>();
    let currentIdx = 0;
    const resolve = (name: string): number | undefined => {
      const col = dataMap.get(name);
      return col ? col[currentIdx] : undefined;
    };

    for (let i = 0; i < n; i++) {
      currentIdx = i;
      const tUs = Number(time[i]);
      if (input.zoomRange && (tUs < input.zoomRange.startUs || tUs > input.zoomRange.endUs)) continue;
      if (filterAst) {
        let v: number;
        try { v = evalAst(filterAst, resolve); }
        catch { continue; }
        if (!v || Number.isNaN(v)) continue;
      }
      const groupKey = groupChannel && groupCol ? String(groupCol[i] ?? "") : "";
      let buf = buffers.get(groupKey);
      if (!buf) { buf = { time: [], xs: [], ys: [] }; buffers.set(groupKey, buf); ensureGroup(groupKey); }
      buf.time.push(tUs);
      buf.xs.push(xCol[i]!);
      buf.ys.push(yCol[i]!);
    }

    for (const [groupKey, buf] of buffers) {
      const palIdx = groupChannel ? groupIndex.get(groupKey)! : -1;
      const color = palIdx >= 0 ? PALETTE[palIdx % PALETTE.length]! : session.color;
      out.push({
        session,
        groupKey,
        color,
        time: Float64Array.from(buf.time),
        xs: Float64Array.from(buf.xs),
        ys: Float64Array.from(buf.ys),
        n: buf.xs.length,
      });
    }
  }
  return out;
}
