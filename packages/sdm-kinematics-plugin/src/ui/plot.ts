// Tiny dependency-free canvas line plots for sweep results, drawn in the
// panel theme. One plot per channel; L/R (or F/R) pairs share a plot when
// their keys differ only by corner suffix.

const CSS = {
  bg: "#1f242d",
  line: "#2a313c",
  text: "#93a0b4",
  series: ["#4ea1ff", "#3ddc84", "#ffb454", "#ff6b6b", "#c792ea", "#ffd866"],
};

export interface PlotSeries {
  label: string;
  data: number[];
}

export function drawPlot(
  canvas: HTMLCanvasElement,
  title: string,
  unit: string,
  xs: number[],
  xLabel: string,
  series: PlotSeries[],
): void {
  const cssW = canvas.clientWidth || 300;
  const cssH = 170;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 44, padR = 8, padT = 20, padB = 24;
  const pw = cssW - padL - padR;
  const ph = cssH - padT - padB;

  let ymin = Infinity, ymax = -Infinity;
  for (const s of series) for (const v of s.data) {
    if (Number.isFinite(v)) { ymin = Math.min(ymin, v); ymax = Math.max(ymax, v); }
  }
  if (!Number.isFinite(ymin)) { ymin = 0; ymax = 1; }
  if (ymax - ymin < 1e-9) { ymax += 0.5; ymin -= 0.5; }
  const yr = ymax - ymin;
  ymin -= yr * 0.08; ymax += yr * 0.08;

  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const X = (x: number) => padL + ((x - xmin) / (xmax - xmin || 1)) * pw;
  const Y = (y: number) => padT + (1 - (y - ymin) / (ymax - ymin)) * ph;

  // Grid + axes.
  ctx.strokeStyle = CSS.line;
  ctx.fillStyle = CSS.text;
  ctx.font = "10px ui-sans-serif, system-ui";
  ctx.lineWidth = 1;
  const yticks = 4;
  for (let i = 0; i <= yticks; i++) {
    const v = ymin + ((ymax - ymin) * i) / yticks;
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(v.toFixed(Math.abs(ymax - ymin) < 2 ? 2 : 1), padL - 4, y + 3);
  }
  const xticks = 4;
  for (let i = 0; i <= xticks; i++) {
    const v = xmin + ((xmax - xmin) * i) / xticks;
    const x = X(v);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, cssH - padB); ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillText(v.toFixed(2), x, cssH - padB + 12);
  }
  // Zero lines.
  ctx.strokeStyle = "#3a4350";
  if (ymin < 0 && ymax > 0) { const y = Y(0); ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke(); }
  if (xmin < 0 && xmax > 0) { const x = X(0); ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, cssH - padB); ctx.stroke(); }

  // Series.
  series.forEach((s, si) => {
    ctx.strokeStyle = CSS.series[si % CSS.series.length];
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < xs.length; i++) {
      const v = s.data[i];
      if (!Number.isFinite(v)) { started = false; continue; }
      const x = X(xs[i]), y = Y(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });

  // Title + legend.
  ctx.textAlign = "left";
  ctx.fillStyle = "#e6eaf0";
  ctx.font = "600 11px ui-sans-serif, system-ui";
  ctx.fillText(`${title} (${unit})`, padL, 12);
  ctx.font = "10px ui-sans-serif, system-ui";
  let lx = padL + ctx.measureText(`${title} (${unit})`).width + 60;
  series.forEach((s, si) => {
    ctx.fillStyle = CSS.series[si % CSS.series.length];
    ctx.fillRect(lx, 6, 12, 3);
    ctx.fillStyle = CSS.text;
    ctx.fillText(s.label, lx + 16, 12);
    lx += 16 + ctx.measureText(s.label).width + 14;
  });

  // X label bottom-right.
  ctx.textAlign = "right";
  ctx.fillStyle = CSS.text;
  ctx.fillText(xLabel, cssW - padR, cssH - 2);
}
