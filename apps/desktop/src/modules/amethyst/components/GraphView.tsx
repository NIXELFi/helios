import { useEffect, useMemo, useRef } from "react";
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
  "#FFC627", "#4E86B0", "#5B8A72", "#C1666B", "#8E7C93", "#D9A566",
  "#6B8CBE", "#B0885B", "#7A9E9F", "#A26769", "#9C8AC7", "#68A0A6",
];

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
  const hoverRef = useRef<number | null>(null);
  const activeRef = useRef<string | null>(activeId);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const colorMap = useMemo(() => {
    const m = new Map<string, string>();
    const subteams = new Set<string>();
    for (const n of vault.notes)
      subteams.add(typeof n.frontmatter.subteam === "string" ? n.frontmatter.subteam : "—");
    [...subteams].sort().forEach((st, i) => m.set(st, PALETTE[i % PALETTE.length] ?? "#9097A0"));
    return m;
  }, [vault.notes]);

  const model = useMemo(() => {
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
        nodes[a]!.deg++;
        nodes[b]!.deg++;
      }
    }
    const adjacency = new Map<number, Set<number>>();
    for (const e of edges) {
      (adjacency.get(e.a) ?? adjacency.set(e.a, new Set()).get(e.a)!).add(e.b);
      (adjacency.get(e.b) ?? adjacency.set(e.b, new Set()).get(e.b)!).add(e.a);
    }
    const R = Math.max(220, Math.sqrt(nodes.length) * 70);
    nodes.forEach((nd, i) => {
      const ang = i * 2.399963;
      const rad = R * Math.sqrt((i + 0.5) / Math.max(1, nodes.length));
      nd.x = Math.cos(ang) * rad;
      nd.y = Math.sin(ang) * rad;
    });
    return { nodes, edges, index, adjacency };
  }, [vault.notes]);

  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { nodes, edges, index, adjacency } = model;
    const dpr = window.devicePixelRatio || 1;
    const view = { scale: 0.55, tx: 0, ty: 0 };
    const target = { scale: 0.55, tx: 0, ty: 0 };
    const drag = { x: 0, y: 0, panning: false };
    let raf = 0;
    let alpha = 1;
    let reveal = 0;
    let focusT = 0;
    const k = Math.max(74, 1150 / Math.sqrt(Math.max(1, nodes.length)));
    const nodeRad = (nd: GNode) => 2.4 + Math.min(6.5, Math.sqrt(nd.deg) * 1.5);

    function sizeCanvas() {
      const r = wrap!.getBoundingClientRect();
      canvas!.width = Math.max(1, Math.floor(r.width * dpr));
      canvas!.height = Math.max(1, Math.floor(r.height * dpr));
      canvas!.style.width = `${r.width}px`;
      canvas!.style.height = `${r.height}px`;
    }

    function fitTarget() {
      if (!nodes.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const nd of nodes) {
        minX = Math.min(minX, nd.x); minY = Math.min(minY, nd.y);
        maxX = Math.max(maxX, nd.x); maxY = Math.max(maxY, nd.y);
      }
      const gw = Math.max(1, maxX - minX);
      const gh = Math.max(1, maxY - minY);
      const r = wrap!.getBoundingClientRect();
      const pad = 90;
      target.scale = Math.min(1.6, Math.max(0.12, Math.min((r.width - pad) / gw, (r.height - pad) / gh)));
      target.tx = r.width / 2 - ((minX + maxX) / 2) * target.scale;
      target.ty = r.height / 2 - ((minY + maxY) / 2) * target.scale;
    }

    function step() {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]!;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 > (8 * k) * (8 * k)) continue;
          d2 += 50;
          const d = Math.sqrt(d2);
          let f = (k * k) / d2;
          if (f > 55) f = 55;
          a.vx += (dx / d) * f; a.vy += (dy / d) * f;
          b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
        }
      }
      for (const e of edges) {
        const a = nodes[e.a]!;
        const b = nodes[e.b]!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d * d) / k / 110;
        a.vx -= (dx / d) * f; a.vy -= (dy / d) * f;
        b.vx += (dx / d) * f; b.vy += (dy / d) * f;
      }
      for (const nd of nodes) {
        nd.vx -= nd.x * 0.012; nd.vy -= nd.y * 0.012;
        const vmag = Math.hypot(nd.vx, nd.vy);
        if (vmag > 26) { nd.vx = (nd.vx / vmag) * 26; nd.vy = (nd.vy / vmag) * 26; }
        nd.x += nd.vx * alpha; nd.y += nd.vy * alpha;
        nd.vx *= 0.8; nd.vy *= 0.8;
      }
    }

    function roundedLabel(text: string, x: number, y: number, s: number) {
      ctx!.font = `600 ${10 / s}px Inter, system-ui, sans-serif`;
      const w = ctx!.measureText(text).width;
      const padX = 5 / s;
      const h = 15 / s;
      const bx = x;
      const by = y - h / 2;
      ctx!.fillStyle = "rgba(14,14,16,0.82)";
      const rr = 4 / s;
      ctx!.beginPath();
      ctx!.moveTo(bx + rr, by);
      ctx!.arcTo(bx + w + padX * 2, by, bx + w + padX * 2, by + h, rr);
      ctx!.arcTo(bx + w + padX * 2, by + h, bx, by + h, rr);
      ctx!.arcTo(bx, by + h, bx, by, rr);
      ctx!.arcTo(bx, by, bx + w + padX * 2, by, rr);
      ctx!.fill();
      ctx!.fillStyle = "#DDE1E7";
      ctx!.fillText(text, bx + padX, y + 4 / s);
    }

    function draw() {
      const r = canvas!.getBoundingClientRect();
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, r.width, r.height);
      ctx!.save();
      ctx!.globalAlpha = reveal;
      ctx!.translate(view.tx, view.ty);
      ctx!.scale(view.scale, view.scale);

      const hoverIdx = hoverRef.current ?? undefined;
      const activeIdx = activeRef.current !== null ? index.get(activeRef.current) : undefined;
      const focus = hoverIdx ?? activeIdx;
      const neighbors = focus !== undefined ? adjacency.get(focus) : undefined;
      const fade = focusT; // 0..1 how strongly to dim the un-focused

      // edges
      ctx!.lineWidth = 1 / view.scale;
      for (const e of edges) {
        const a = nodes[e.a]!;
        const b = nodes[e.b]!;
        const lit = focus !== undefined && (e.a === focus || e.b === focus);
        ctx!.strokeStyle = lit
          ? `rgba(255,198,39,${0.55 * fade + 0.18})`
          : `rgba(130,134,142,${0.16 - 0.1 * fade})`;
        ctx!.beginPath();
        ctx!.moveTo(a.x, a.y);
        ctx!.lineTo(b.x, b.y);
        ctx!.stroke();
      }
      // nodes
      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i]!;
        const rad = nodeRad(nd);
        const isFocus = i === focus;
        const isNeighbor = neighbors?.has(i) ?? false;
        const off = focus !== undefined && !isFocus && !isNeighbor;
        ctx!.globalAlpha = reveal * (off ? 1 - 0.78 * fade : 1);
        if (isFocus) {
          ctx!.shadowColor = "rgba(255,198,39,0.9)";
          ctx!.shadowBlur = 16;
        }
        ctx!.fillStyle = colorMap.get(nd.subteam) ?? "#9097A0";
        ctx!.beginPath();
        ctx!.arc(nd.x, nd.y, isFocus ? rad * 1.35 : rad, 0, Math.PI * 2);
        ctx!.fill();
        ctx!.shadowBlur = 0;
        ctx!.lineWidth = 1.2 / view.scale;
        ctx!.strokeStyle = i === activeIdx ? "#fff" : "rgba(0,0,0,0.35)";
        ctx!.stroke();
      }
      // labels last (focus + neighbors + active), on top
      ctx!.globalAlpha = reveal;
      const labelSet = new Set<number>();
      if (focus !== undefined) {
        labelSet.add(focus);
        // Only label neighbors for small clusters — hubs (MOCs, meetings) would
        // otherwise draw dozens of overlapping labels.
        if (neighbors && neighbors.size <= 8) neighbors.forEach((n) => labelSet.add(n));
      }
      if (activeIdx !== undefined) labelSet.add(activeIdx);
      for (const i of labelSet) {
        const nd = nodes[i]!;
        roundedLabel(nd.title.slice(0, 34), nd.x + nodeRad(nd) + 4 / view.scale, nd.y, view.scale);
      }
      ctx!.restore();
    }

    function tick() {
      if (alpha > 0.05) {
        step();
        alpha *= 0.985;
        fitTarget();
      }
      reveal += (1 - reveal) * 0.08;
      const targetFocus = hoverRef.current !== null || activeRef.current !== null ? 1 : 0;
      focusT += (targetFocus - focusT) * 0.18;
      view.scale += (target.scale - view.scale) * 0.14;
      view.tx += (target.tx - view.tx) * 0.14;
      view.ty += (target.ty - view.ty) * 0.14;
      draw();
      raf = requestAnimationFrame(tick);
    }

    sizeCanvas();
    fitTarget();
    view.tx = target.tx; view.ty = target.ty; // start centered (scale eases in)
    tick();

    const ro = new ResizeObserver(() => {
      sizeCanvas();
      fitTarget();
    });
    ro.observe(wrap);

    function toWorld(cx: number, cy: number) {
      const r = canvas!.getBoundingClientRect();
      return { x: (cx - r.left - view.tx) / view.scale, y: (cy - r.top - view.ty) / view.scale };
    }
    function pick(cx: number, cy: number): number | null {
      const w = toWorld(cx, cy);
      let best: number | null = null;
      let bestD = 18 / view.scale;
      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i]!;
        const rr = nodeRad(nd) + 5 / view.scale;
        const d = Math.hypot(nd.x - w.x, nd.y - w.y);
        if (d < rr && d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    function onMove(e: MouseEvent) {
      if (drag.panning) {
        target.tx += e.clientX - drag.x;
        target.ty += e.clientY - drag.y;
        view.tx += e.clientX - drag.x;
        view.ty += e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        return;
      }
      const i = pick(e.clientX, e.clientY);
      hoverRef.current = i;
      canvas!.style.cursor = i !== null ? "pointer" : "grab";
    }
    function onDown(e: MouseEvent) {
      const i = pick(e.clientX, e.clientY);
      if (i !== null) { onSelectRef.current(nodes[i]!.id); return; }
      drag.panning = true; drag.x = e.clientX; drag.y = e.clientY;
      canvas!.style.cursor = "grabbing";
    }
    function onUp() { drag.panning = false; canvas!.style.cursor = "grab"; }
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const r = canvas!.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const factor = e.deltaY < 0 ? 1.14 : 1 / 1.14;
      const wx = (mx - view.tx) / view.scale;
      const wy = (my - view.ty) / view.scale;
      const ns = Math.min(4, Math.max(0.1, view.scale * factor));
      target.scale = ns;
      target.tx = mx - wx * ns;
      target.ty = my - wy * ns;
    }
    function onDbl() { fitTarget(); }
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("dblclick", onDbl);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("dblclick", onDbl);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [model, colorMap]);

  const legend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of model.nodes) counts.set(n.subteam, (counts.get(n.subteam) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [model.nodes]);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-helios-base">
      <canvas ref={canvasRef} className="block h-full w-full" style={{ cursor: "grab" }} />
      <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-helios-line bg-helios-panel/80 px-3 py-2 text-[11px] backdrop-blur">
        <div className="mb-1.5 font-semibold text-helios-text">
          {model.nodes.length} notes · {model.edges.length} links
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {legend.map(([st, c]) => (
            <div key={st} className="flex items-center gap-1.5 text-helios-dim">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: colorMap.get(st) ?? "#9097A0" }} />
              <span className="max-w-[8rem] truncate">{st}</span>
              <span className="text-helios-line">{c}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-3 right-3 text-[10px] text-helios-dim/70">
        scroll to zoom · drag to pan · double-click to fit · click a node to open
      </div>
    </div>
  );
}
