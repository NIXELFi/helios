import { useEffect, useMemo, useRef, useState } from "react";
import type { KbVault } from "../types";

interface GNode {
  id: string;
  title: string;
  subteam: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  deg: number;
}
interface GEdge {
  a: number;
  b: number;
}

const PALETTE = [
  "#FFC627", "#8C1D40", "#3C6E8F", "#5B8A72", "#C1666B", "#8E7C93",
  "#D9A566", "#4F6367", "#A26769", "#7A9E9F", "#6B8CBE", "#B0885B",
];

function colorFor(subteam: string, map: Map<string, string>): string {
  let c = map.get(subteam);
  if (!c) {
    c = PALETTE[map.size % PALETTE.length] ?? "#9097A0";
    map.set(subteam, c);
  }
  return c;
}

export function GraphView({
  vault,
  activeId,
  onSelect,
}: {
  vault: KbVault;
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const colorMap = useRef<Map<string, string>>(new Map());

  // Build the graph model from the vault (undirected wikilink edges).
  const { nodes, edges, index } = useMemo(() => {
    const index = new Map<string, number>();
    const nodes: GNode[] = vault.notes.map((n, i) => {
      index.set(n.id, i);
      const st = typeof n.frontmatter.subteam === "string" ? n.frontmatter.subteam : "—";
      return { id: n.id, title: n.title, subteam: st, x: 0, y: 0, vx: 0, vy: 0, deg: 0 };
    });
    const seen = new Set<string>();
    const edges: GEdge[] = [];
    for (const n of vault.notes) {
      const a = index.get(n.id);
      if (a === undefined) continue;
      for (const target of n.links) {
        const b = index.get(target);
        if (b === undefined || b === a) continue;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ a, b });
        const na = nodes[a];
        const nb = nodes[b];
        if (na) na.deg++;
        if (nb) nb.deg++;
      }
    }
    // Deterministic spiral seed (no RNG — placement need not be random).
    const R = Math.max(200, nodes.length * 6);
    nodes.forEach((nd, i) => {
      const ang = i * 2.399963; // golden angle
      const rad = R * Math.sqrt(i / Math.max(1, nodes.length));
      nd.x = Math.cos(ang) * rad;
      nd.y = Math.sin(ang) * rad;
    });
    return { nodes, edges, index };
  }, [vault.notes]);

  const adjacency = useMemo(() => {
    const adj = new Map<number, Set<number>>();
    for (const e of edges) {
      (adj.get(e.a) ?? adj.set(e.a, new Set()).get(e.a)!).add(e.b);
      (adj.get(e.b) ?? adj.set(e.b, new Set()).get(e.b)!).add(e.a);
    }
    return adj;
  }, [edges]);

  // View transform (pan/zoom).
  const view = useRef({ scale: 1, tx: 0, ty: 0 });
  const drag = useRef<{ x: number; y: number; panning: boolean } | null>(null);

  // Force simulation + render loop. Cools to a stop (bounded CPU), then only
  // repaints on interaction.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let alpha = 1;
    let raf = 0;
    const dpr = window.devicePixelRatio || 1;

    function resize() {
      if (!canvas || !wrap) return;
      const r = wrap.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      if (view.current.tx === 0 && view.current.ty === 0) {
        view.current.tx = r.width / 2;
        view.current.ty = r.height / 2;
      }
    }
    resize();
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(wrap);

    const k = Math.max(30, 380 / Math.sqrt(Math.max(1, nodes.length)));

    function step() {
      // repulsion (O(n²) — fine for hundreds; sim cools & stops)
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]!;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = (i - j) * 0.1 + 0.1;
            dy = 0.1;
            d2 = dx * dx + dy * dy;
          }
          const f = (k * k) / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }
      // attraction along edges
      for (const e of edges) {
        const a = nodes[e.a]!;
        const b = nodes[e.b]!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d * d) / k;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
      // gravity toward origin + integrate
      for (const nd of nodes) {
        nd.vx -= nd.x * 0.012;
        nd.vy -= nd.y * 0.012;
        nd.x += nd.vx * alpha * 0.5;
        nd.y += nd.vy * alpha * 0.5;
        nd.vx *= 0.85;
        nd.vy *= 0.85;
      }
    }

    function draw() {
      if (!canvas || !ctx) return;
      const { scale, tx, ty } = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(tx, ty);
      ctx.scale(scale, scale);

      const hoverIdx = hover !== null ? index.get(hover) : undefined;
      const activeIdx = activeId !== null ? index.get(activeId) : undefined;
      const focus = hoverIdx ?? activeIdx;
      const neighbors = focus !== undefined ? adjacency.get(focus) : undefined;

      // edges
      ctx.lineWidth = 1 / scale;
      for (const e of edges) {
        const a = nodes[e.a]!;
        const b = nodes[e.b]!;
        const lit = focus !== undefined && (e.a === focus || e.b === focus);
        ctx.strokeStyle = lit ? "rgba(255,198,39,0.55)" : "rgba(120,124,132,0.14)";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // nodes
      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i]!;
        const r = 3 + Math.min(9, nd.deg * 0.9);
        const isFocus = i === focus;
        const isNeighbor = neighbors?.has(i);
        const dim = focus !== undefined && !isFocus && !isNeighbor;
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.fillStyle = colorFor(nd.subteam, colorMap.current);
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (i === activeIdx) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2 / scale;
          ctx.stroke();
        }
        // labels: only when zoomed in, or focused/neighbor
        if ((scale > 1.4 || isFocus || isNeighbor) && !dim) {
          ctx.globalAlpha = isFocus ? 1 : 0.75;
          ctx.fillStyle = "#C9CDD4";
          ctx.font = `${11 / scale}px Inter, sans-serif`;
          ctx.fillText(nd.title.slice(0, 28), nd.x + r + 2 / scale, nd.y + 3 / scale);
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    function frame() {
      if (alpha > 0.03) {
        step();
        alpha *= 0.98;
        draw();
        raf = requestAnimationFrame(frame);
      } else {
        draw();
      }
    }
    frame();

    // interaction
    function toWorld(clientX: number, clientY: number) {
      const r = canvas!.getBoundingClientRect();
      const { scale, tx, ty } = view.current;
      return { x: (clientX - r.left - tx) / scale, y: (clientY - r.top - ty) / scale };
    }
    function pick(clientX: number, clientY: number): number | null {
      const w = toWorld(clientX, clientY);
      let best: number | null = null;
      let bestD = 14 / view.current.scale;
      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i]!;
        const r = 3 + Math.min(9, nd.deg * 0.9) + 4 / view.current.scale;
        const d = Math.hypot(nd.x - w.x, nd.y - w.y);
        if (d < r && d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    }
    function onMove(e: MouseEvent) {
      if (drag.current?.panning) {
        view.current.tx += e.clientX - drag.current.x;
        view.current.ty += e.clientY - drag.current.y;
        drag.current.x = e.clientX;
        drag.current.y = e.clientY;
        draw();
        return;
      }
      const i = pick(e.clientX, e.clientY);
      const id = i !== null ? nodes[i]!.id : null;
      setHover(id);
      canvas!.style.cursor = id ? "pointer" : "grab";
    }
    function onDown(e: MouseEvent) {
      const i = pick(e.clientX, e.clientY);
      if (i !== null) {
        onSelect(nodes[i]!.id);
        return;
      }
      drag.current = { x: e.clientX, y: e.clientY, panning: true };
      canvas!.style.cursor = "grabbing";
    }
    function onUp() {
      drag.current = null;
      canvas!.style.cursor = "grab";
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const r = canvas!.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const v = view.current;
      const wx = (mx - v.tx) / v.scale;
      const wy = (my - v.ty) / v.scale;
      v.scale = Math.min(4, Math.max(0.15, v.scale * factor));
      v.tx = mx - wx * v.scale;
      v.ty = my - wy * v.scale;
      draw();
    }
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, index, adjacency, activeId, hover]);

  const legend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) counts.set(n.subteam, (counts.get(n.subteam) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [nodes]);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-helios-base">
      <canvas ref={canvasRef} className="block h-full w-full" style={{ cursor: "grab" }} />
      <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-helios-line bg-helios-panel/80 px-3 py-2 text-[11px] backdrop-blur">
        <div className="mb-1 font-semibold text-helios-text">
          {nodes.length} notes · {edges.length} links
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {legend.map(([st, c]) => (
            <div key={st} className="flex items-center gap-1.5 text-helios-dim">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: colorFor(st, colorMap.current) }} />
              <span className="truncate">{st}</span>
              <span className="text-helios-line">{c}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-3 right-3 text-[10px] text-helios-dim/70">
        scroll to zoom · drag to pan · click a node to open
      </div>
    </div>
  );
}
