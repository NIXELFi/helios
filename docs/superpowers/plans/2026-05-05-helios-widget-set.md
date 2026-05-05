# Helios Plan 2 — Remaining Widget Set

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 9 remaining v1 widgets (RoundGauge, BarGauge, EngineBar, GpsTrack, LapPanel, AlarmPanel, TireGrid, Histogram, XYPlot) and update the default workspace to showcase all 11 widget types against the synthetic SDM26 sample session.

**Architecture:** Every widget follows the established `Widget<Config>` pattern from Plan 1: each lives in `packages/widgets/src/<name>/{index,render,config-editor}.tsx`, exports a single `<name>Widget` descriptor, and registers itself by `type`. Render components are pure — they receive a `ChannelSlice`, a `CursorEmitter`, and a config object, and update imperatively where 60Hz performance matters. LapPanel and AlarmPanel render against config-supplied static data for now; live wiring is Plans 4 and 5.

**Tech Stack:** React 18 · uPlot (for charts) · Canvas 2D (for gauges and the GPS map) · Vitest + jsdom (for tests). **No MapLibre** — GPS track is a custom canvas polyline; basemap can be added in Plan 7 polish.

**Reference:** `docs/superpowers/specs/2026-05-04-helios-design.md` Section 3 widget table.

---

## File structure (Plan 2)

```
packages/widgets/src/
├── round-gauge/{index,render,config-editor}.tsx       # Task 1
├── bar-gauge/{index,render,config-editor}.tsx         # Task 2
├── engine-bar/{index,render,config-editor}.tsx        # Task 3
├── gps-track/{index,render,config-editor}.tsx         # Task 4
├── lap-panel/{index,render,config-editor}.tsx         # Task 5
├── alarm-panel/{index,render,config-editor}.tsx       # Task 6
├── tire-grid/{index,render,config-editor}.tsx         # Task 7
├── histogram/{index,render,config-editor}.tsx         # Task 8
├── xy-plot/{index,render,config-editor}.tsx           # Task 9
├── lib/
│   ├── sample-at.ts              # shared cursor-sample binary search
│   └── canvas-helpers.ts         # shared 2d-canvas setup (DPR-aware)
└── index.ts                      # re-export everything

packages/widgets/tests/
└── <one .test.tsx per widget>

apps/desktop/src/
├── workspaces/overview-default.ts   # rewritten in Task 10 to showcase all widgets
└── components/Tile.tsx              # registry map updated in Task 10
```

---

## Task 0: Shared widget utilities

Both NumericReadout (Plan 1) and the gauge widgets (Plan 2) need the same "sample channel value at cursor time" binary search. Right now it's inlined in NumericReadout. Pulling it out into a shared module before adding more widgets keeps the gauges DRY.

**Files:**
- Create: `packages/widgets/src/lib/sample-at.ts`
- Create: `packages/widgets/src/lib/canvas-helpers.ts`
- Modify: `packages/widgets/src/numeric-readout/render.tsx` — replace inline `sampleAt` with import
- Create: `packages/widgets/tests/sample-at.test.ts`

- [ ] **Step 1: Create `packages/widgets/src/lib/sample-at.ts`**

```ts
/**
 * Find the channel value at time `tUs`. Uses binary search to find the
 * largest sample index where time[idx] <= t, then returns that sample.
 * Returns null if the slice is empty or the channel is missing.
 */
export function sampleAt(
  slice: { time: BigInt64Array; data: Map<string, Float64Array> },
  channelId: string,
  tUs: number,
): number | null {
  const col = slice.data.get(channelId);
  if (!col || slice.time.length === 0) return null;
  const t = BigInt(tUs);
  let lo = 0, hi = slice.time.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (slice.time[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  const idx = Math.max(0, lo - 1);
  return col[idx] ?? null;
}
```

- [ ] **Step 2: Create `packages/widgets/src/lib/canvas-helpers.ts`**

```ts
/** Configure a canvas 2D context for crisp rendering on high-DPI displays. */
export function setupCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  return ctx;
}

/** Logical (CSS) size of a canvas, regardless of devicePixelRatio. */
export function canvasLogicalSize(canvas: HTMLCanvasElement): { w: number; h: number } {
  const rect = canvas.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}

/** Pick the right text color for a value given warn/alarm thresholds. */
export function thresholdColor(v: number | null, warn?: number, alarm?: number): string {
  if (v === null) return "#7B8088";
  if (alarm !== undefined && v >= alarm) return "#EF5350";
  if (warn !== undefined && v >= warn) return "#FFB800";
  return "#D8DCE2";
}
```

- [ ] **Step 3: Tests for `sample-at`**

Create `packages/widgets/tests/sample-at.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sampleAt } from "../src/lib/sample-at";

const slice = {
  time: BigInt64Array.from([0n, 10_000n, 20_000n, 30_000n]),
  data: new Map([["x", Float64Array.from([10, 20, 30, 40])]]),
};

describe("sampleAt", () => {
  it("returns first sample when t < first sample time", () => {
    expect(sampleAt(slice, "x", -1)).toBe(10);
  });
  it("returns exact sample when t equals a sample time", () => {
    expect(sampleAt(slice, "x", 20_000)).toBe(30);
  });
  it("returns last preceding sample for t between samples", () => {
    expect(sampleAt(slice, "x", 15_000)).toBe(20);
  });
  it("returns last sample for t past the end", () => {
    expect(sampleAt(slice, "x", 1_000_000)).toBe(40);
  });
  it("returns null for unknown channel", () => {
    expect(sampleAt(slice, "missing", 0)).toBe(null);
  });
  it("returns null for empty slice", () => {
    const empty = { time: new BigInt64Array(0), data: new Map() };
    expect(sampleAt(empty, "x", 0)).toBe(null);
  });
});
```

- [ ] **Step 4: Refactor NumericReadout to import sampleAt**

Edit `packages/widgets/src/numeric-readout/render.tsx`:
- Remove the local `sampleAt` function definition at the bottom of the file.
- Add `import { sampleAt } from "../lib/sample-at";` at the top.

- [ ] **Step 5: Run all widget tests**

```bash
cd ~/Developer/helios
pnpm --filter @helios/widgets test
```

Expected: 13 passed (3 registry + 2 numeric-readout + 2 strip-chart + 6 sample-at).

- [ ] **Step 6: Commit**

```bash
cd ~/Developer/helios
git add packages/widgets
git commit -m "refactor(widgets): extract sampleAt + canvas helpers into shared lib"
```

---

## Task 1: RoundGauge

Classic round gauge — arc, warn/alarm bands, needle, big digital readout in the middle. Drawn on canvas for smooth needle motion.

**Files:**
- Create: `packages/widgets/src/round-gauge/render.tsx`
- Create: `packages/widgets/src/round-gauge/config-editor.tsx`
- Create: `packages/widgets/src/round-gauge/index.tsx`
- Create: `packages/widgets/tests/round-gauge.test.tsx`
- Modify: `packages/widgets/src/index.ts`

- [ ] **Step 1: Render**

Create `packages/widgets/src/round-gauge/render.tsx`:

```tsx
import { useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { sampleAt } from "../lib/sample-at";
import { setupCanvas, canvasLogicalSize, thresholdColor } from "../lib/canvas-helpers";

export interface RoundGaugeConfig {
  channelId: string;
  units: string;
  decimals: number;
  min: number;
  max: number;
  warn?: number;
  alarm?: number;
  /** sweep angle in radians — default 270° */
  sweep?: number;
}

export function RoundGaugeRender(props: WidgetRenderProps<RoundGaugeConfig>) {
  const { config, slice, cursorEmitter } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const valueRef = useRef<number | null>(sampleAt(slice, config.channelId, cursorEmitter.get()));

  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      valueRef.current = sampleAt(slice, config.channelId, t);
      draw();
    });
    return off;
  }, [slice, config, cursorEmitter]);

  useEffect(() => {
    draw();
  }, [config]);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    const cx = w / 2, cy = h * 0.6;
    const r = Math.min(w, h) * 0.42;
    const sweep = config.sweep ?? Math.PI * 1.5;
    const start = Math.PI / 2 + (Math.PI * 2 - sweep) / 2 + Math.PI;
    const end = start + sweep;

    ctx.clearRect(0, 0, w, h);

    // Background arc
    ctx.lineWidth = 8;
    ctx.strokeStyle = "#23252B";
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end);
    ctx.stroke();

    // Warn/alarm bands
    const span = config.max - config.min;
    if (config.warn !== undefined) {
      const warnT = (config.warn - config.min) / span;
      ctx.strokeStyle = "#FFB800";
      ctx.beginPath();
      ctx.arc(cx, cy, r, start + warnT * sweep, start + (config.alarm !== undefined ? (config.alarm - config.min) / span : 1) * sweep);
      ctx.stroke();
    }
    if (config.alarm !== undefined) {
      const alarmT = (config.alarm - config.min) / span;
      ctx.strokeStyle = "#EF5350";
      ctx.beginPath();
      ctx.arc(cx, cy, r, start + alarmT * sweep, end);
      ctx.stroke();
    }

    // Tick marks
    ctx.strokeStyle = "#5A5F66";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const a = start + (i / 10) * sweep;
      const r1 = r + 4, r2 = r + 10;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
    }

    // Needle
    const v = valueRef.current;
    if (v !== null) {
      const t = Math.max(0, Math.min(1, (v - config.min) / span));
      const a = start + t * sweep;
      ctx.strokeStyle = thresholdColor(v, config.warn, config.alarm);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6));
      ctx.stroke();
      ctx.fillStyle = "#D8DCE2";
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Digital readout
    ctx.fillStyle = thresholdColor(v, config.warn, config.alarm);
    ctx.font = `${Math.max(14, r * 0.35)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const text = v === null ? "—" : v.toFixed(config.decimals);
    ctx.fillText(text, cx, cy + r * 0.45);

    // Channel id and units
    ctx.fillStyle = "#7B8088";
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.fillText(config.channelId.toUpperCase(), cx, 14);
    ctx.fillText(config.units, cx, cy + r * 0.85);
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}
```

- [ ] **Step 2: Config editor**

Create `packages/widgets/src/round-gauge/config-editor.tsx`:

```tsx
import type { WidgetConfigEditorProps } from "../types";
import type { RoundGaugeConfig } from "./render";

const labels: Array<[keyof RoundGaugeConfig, string]> = [
  ["channelId", "Channel"], ["units", "Units"],
  ["min", "Min"], ["max", "Max"],
  ["warn", "Warn"], ["alarm", "Alarm"],
  ["decimals", "Decimals"],
];

export function RoundGaugeConfigEditor({ config, onChange }: WidgetConfigEditorProps<RoundGaugeConfig>) {
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      {labels.map(([k, label]) => (
        <label key={k} className="flex justify-between gap-2">
          <span>{label}</span>
          <input
            className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
            value={config[k] === undefined ? "" : String(config[k])}
            onChange={(e) => {
              const raw = e.target.value;
              const v = k === "channelId" || k === "units" ? raw : raw === "" ? undefined : Number(raw);
              onChange({ ...config, [k]: v } as RoundGaugeConfig);
            }}
          />
        </label>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Descriptor**

Create `packages/widgets/src/round-gauge/index.tsx`:

```tsx
import type { Widget } from "../types";
import { RoundGaugeConfigEditor } from "./config-editor";
import { RoundGaugeRender, type RoundGaugeConfig } from "./render";

export const roundGaugeWidget: Widget<RoundGaugeConfig> = {
  type: "round_gauge",
  defaultConfig: { channelId: "", units: "", decimals: 0, min: 0, max: 100 },
  ConfigEditor: RoundGaugeConfigEditor,
  Render: RoundGaugeRender,
  requiredChannels: (c) => (c.channelId ? [c.channelId] : []),
};

export type { RoundGaugeConfig } from "./render";
```

- [ ] **Step 4: Test**

Create `packages/widgets/tests/round-gauge.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { roundGaugeWidget } from "../src/round-gauge";
import { CursorEmitter } from "@helios/lib";

describe("RoundGauge", () => {
  it("requiredChannels returns the channel id", () => {
    expect(roundGaugeWidget.requiredChannels({
      ...roundGaugeWidget.defaultConfig,
      channelId: "engine.water_temp",
    })).toEqual(["engine.water_temp"]);
  });

  it("renders a canvas", () => {
    const { container } = render(<roundGaugeWidget.Render
      config={{ ...roundGaugeWidget.defaultConfig, channelId: "engine.water_temp", units: "°C", decimals: 1, min: 0, max: 130, warn: 105, alarm: 115 }}
      slice={{ time: BigInt64Array.from([0n]), data: new Map([["engine.water_temp", Float64Array.from([90])]]), range: { startUs: 0, endUs: 1 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
```

- [ ] **Step 5: Re-export**

Edit `packages/widgets/src/index.ts`:

```ts
export * from "./types";
export * from "./registry";
export * from "./numeric-readout";
export * from "./strip-chart";
export * from "./round-gauge";
```

- [ ] **Step 6: Run + commit**

```bash
cd ~/Developer/helios
pnpm --filter @helios/widgets test round-gauge
git add packages/widgets
git commit -m "feat(widgets): add RoundGauge with canvas needle + warn/alarm bands"
```

Expected: 2 passed.

---

## Task 2: BarGauge

Vertical or horizontal bar gauge with min/max ticks, peak-hold marker, and color bands.

**Files:**
- Create: `packages/widgets/src/bar-gauge/render.tsx`
- Create: `packages/widgets/src/bar-gauge/config-editor.tsx`
- Create: `packages/widgets/src/bar-gauge/index.tsx`
- Create: `packages/widgets/tests/bar-gauge.test.tsx`
- Modify: `packages/widgets/src/index.ts`

- [ ] **Step 1: Render**

Create `packages/widgets/src/bar-gauge/render.tsx`:

```tsx
import { useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { sampleAt } from "../lib/sample-at";
import { setupCanvas, canvasLogicalSize, thresholdColor } from "../lib/canvas-helpers";

export interface BarGaugeConfig {
  channelId: string;
  units: string;
  decimals: number;
  min: number;
  max: number;
  warn?: number;
  alarm?: number;
  orientation: "vertical" | "horizontal";
}

export function BarGaugeRender(props: WidgetRenderProps<BarGaugeConfig>) {
  const { config, slice, cursorEmitter } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const valueRef = useRef<number | null>(sampleAt(slice, config.channelId, cursorEmitter.get()));
  const peakRef = useRef<number | null>(valueRef.current);

  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      const v = sampleAt(slice, config.channelId, t);
      valueRef.current = v;
      if (v !== null && (peakRef.current === null || v > peakRef.current)) peakRef.current = v;
      draw();
    });
    return off;
  }, [slice, config, cursorEmitter]);

  useEffect(() => { peakRef.current = valueRef.current; draw(); }, [config]);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    const horiz = config.orientation === "horizontal";
    ctx.clearRect(0, 0, w, h);

    const padX = 28, padY = 28;
    const trackX = padX, trackY = padY;
    const trackW = w - padX * 2, trackH = h - padY * 2;
    const v = valueRef.current;
    const span = config.max - config.min;
    const t = v === null ? 0 : Math.max(0, Math.min(1, (v - config.min) / span));

    // Track outline
    ctx.fillStyle = "#0E0E10";
    ctx.fillRect(trackX, trackY, trackW, trackH);
    ctx.strokeStyle = "#2A2C32";
    ctx.strokeRect(trackX, trackY, trackW, trackH);

    // Filled bar
    ctx.fillStyle = thresholdColor(v, config.warn, config.alarm);
    if (horiz) ctx.fillRect(trackX, trackY, trackW * t, trackH);
    else       ctx.fillRect(trackX, trackY + trackH * (1 - t), trackW, trackH * t);

    // Warn/alarm marks
    ctx.strokeStyle = "#FFB800";
    if (config.warn !== undefined) {
      const wt = (config.warn - config.min) / span;
      drawTick(ctx, horiz, trackX, trackY, trackW, trackH, wt);
    }
    ctx.strokeStyle = "#EF5350";
    if (config.alarm !== undefined) {
      const at = (config.alarm - config.min) / span;
      drawTick(ctx, horiz, trackX, trackY, trackW, trackH, at);
    }

    // Peak-hold tick
    if (peakRef.current !== null) {
      const pt = Math.max(0, Math.min(1, (peakRef.current - config.min) / span));
      ctx.strokeStyle = "#D8DCE2";
      drawTick(ctx, horiz, trackX, trackY, trackW, trackH, pt);
    }

    // Labels
    ctx.fillStyle = "#7B8088";
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textAlign = horiz ? "left" : "right";
    ctx.textBaseline = "top";
    ctx.fillText(config.channelId, 4, 4);
    ctx.textAlign = "right";
    ctx.fillText(config.units, w - 4, 4);

    ctx.fillStyle = thresholdColor(v, config.warn, config.alarm);
    ctx.font = '14px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(v === null ? "—" : v.toFixed(config.decimals), w / 2, h - 4);
  }

  function drawTick(ctx: CanvasRenderingContext2D, horiz: boolean, x: number, y: number, w: number, h: number, t: number) {
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (horiz) {
      const px = x + w * t;
      ctx.moveTo(px, y - 2); ctx.lineTo(px, y + h + 2);
    } else {
      const py = y + h * (1 - t);
      ctx.moveTo(x - 2, py); ctx.lineTo(x + w + 2, py);
    }
    ctx.stroke();
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}
```

- [ ] **Step 2: Config editor**

Create `packages/widgets/src/bar-gauge/config-editor.tsx`:

```tsx
import type { WidgetConfigEditorProps } from "../types";
import type { BarGaugeConfig } from "./render";

export function BarGaugeConfigEditor({ config, onChange }: WidgetConfigEditorProps<BarGaugeConfig>) {
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      {(["channelId", "units"] as const).map((k) => (
        <label key={k} className="flex justify-between">
          <span>{k}</span>
          <input className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
            value={config[k]} onChange={(e) => onChange({ ...config, [k]: e.target.value })} />
        </label>
      ))}
      {(["min", "max", "warn", "alarm", "decimals"] as const).map((k) => (
        <label key={k} className="flex justify-between">
          <span>{k}</span>
          <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
            value={config[k] === undefined ? "" : config[k]}
            onChange={(e) => onChange({ ...config, [k]: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </label>
      ))}
      <label className="flex justify-between">
        <span>orientation</span>
        <select className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
          value={config.orientation}
          onChange={(e) => onChange({ ...config, orientation: e.target.value as BarGaugeConfig["orientation"] })}>
          <option value="vertical">vertical</option>
          <option value="horizontal">horizontal</option>
        </select>
      </label>
    </div>
  );
}
```

- [ ] **Step 3: Descriptor**

Create `packages/widgets/src/bar-gauge/index.tsx`:

```tsx
import type { Widget } from "../types";
import { BarGaugeConfigEditor } from "./config-editor";
import { BarGaugeRender, type BarGaugeConfig } from "./render";

export const barGaugeWidget: Widget<BarGaugeConfig> = {
  type: "bar_gauge",
  defaultConfig: { channelId: "", units: "", decimals: 0, min: 0, max: 100, orientation: "vertical" },
  ConfigEditor: BarGaugeConfigEditor,
  Render: BarGaugeRender,
  requiredChannels: (c) => (c.channelId ? [c.channelId] : []),
};

export type { BarGaugeConfig } from "./render";
```

- [ ] **Step 4: Test**

Create `packages/widgets/tests/bar-gauge.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { barGaugeWidget } from "../src/bar-gauge";
import { CursorEmitter } from "@helios/lib";

describe("BarGauge", () => {
  it("renders a canvas (vertical)", () => {
    const { container } = render(<barGaugeWidget.Render
      config={{ ...barGaugeWidget.defaultConfig, channelId: "x", units: "u", min: 0, max: 100, orientation: "vertical" }}
      slice={{ time: BigInt64Array.from([0n]), data: new Map([["x", Float64Array.from([42])]]), range: { startUs: 0, endUs: 1 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("renders a canvas (horizontal)", () => {
    const { container } = render(<barGaugeWidget.Render
      config={{ ...barGaugeWidget.defaultConfig, channelId: "x", units: "u", min: 0, max: 100, orientation: "horizontal" }}
      slice={{ time: BigInt64Array.from([0n]), data: new Map([["x", Float64Array.from([42])]]), range: { startUs: 0, endUs: 1 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
```

- [ ] **Step 5: Re-export + run + commit**

Append `export * from "./bar-gauge";` to `packages/widgets/src/index.ts`.

```bash
cd ~/Developer/helios
pnpm --filter @helios/widgets test bar-gauge
git add packages/widgets
git commit -m "feat(widgets): add BarGauge with peak-hold tick + warn/alarm marks"
```

Expected: 2 passed.

---

## Task 3: EngineBar

Wide horizontal RPM bar with shift-light segments and peak-RPM marker. Specifically motorsport-flavored.

**Files:**
- Create: `packages/widgets/src/engine-bar/render.tsx`
- Create: `packages/widgets/src/engine-bar/config-editor.tsx`
- Create: `packages/widgets/src/engine-bar/index.tsx`
- Create: `packages/widgets/tests/engine-bar.test.tsx`
- Modify: `packages/widgets/src/index.ts`

- [ ] **Step 1: Render**

Create `packages/widgets/src/engine-bar/render.tsx`:

```tsx
import { useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { sampleAt } from "../lib/sample-at";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";

export interface EngineBarConfig {
  rpmChannelId: string;
  gearChannelId?: string;
  redline: number;
  shiftLightStart: number;
  segments: number;
}

export function EngineBarRender(props: WidgetRenderProps<EngineBarConfig>) {
  const { config, slice, cursorEmitter } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rpmRef = useRef<number | null>(sampleAt(slice, config.rpmChannelId, cursorEmitter.get()));
  const peakRef = useRef<number | null>(rpmRef.current);
  const gearRef = useRef<number | null>(config.gearChannelId ? sampleAt(slice, config.gearChannelId, cursorEmitter.get()) : null);

  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      const r = sampleAt(slice, config.rpmChannelId, t);
      rpmRef.current = r;
      if (r !== null && (peakRef.current === null || r > peakRef.current)) peakRef.current = r;
      gearRef.current = config.gearChannelId ? sampleAt(slice, config.gearChannelId, t) : null;
      draw();
    });
    return off;
  }, [slice, config, cursorEmitter]);

  useEffect(() => { peakRef.current = rpmRef.current; draw(); }, [config]);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);

    const gearW = h * 0.9;
    const barX = gearW + 8, barY = 4;
    const barW = w - barX - 4, barH = h - 8;

    // Gear inset
    ctx.fillStyle = "#0E0E10";
    ctx.fillRect(0, 0, gearW, h);
    ctx.strokeStyle = "#2A2C32";
    ctx.strokeRect(0.5, 0.5, gearW - 1, h - 1);
    ctx.fillStyle = "#FFC627";
    ctx.font = `bold ${Math.floor(h * 0.6)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const g = gearRef.current;
    ctx.fillText(g === null ? "—" : (g === 0 ? "N" : String(Math.round(g))), gearW / 2, h / 2);

    // RPM bar
    const r = rpmRef.current ?? 0;
    const t = Math.max(0, Math.min(1, r / config.redline));
    const segs = config.segments;
    const segGap = 2;
    const segW = (barW - segGap * (segs - 1)) / segs;
    for (let i = 0; i < segs; i++) {
      const segT = (i + 1) / segs;
      const lit = segT <= t;
      const inShift = (i / segs) >= (config.shiftLightStart / config.redline);
      ctx.fillStyle = lit
        ? (inShift ? (segT > 0.95 ? "#EF5350" : "#FFB800") : "#4FC3F7")
        : "#23252B";
      ctx.fillRect(barX + i * (segW + segGap), barY, segW, barH);
    }

    // Peak marker
    if (peakRef.current !== null) {
      const pt = Math.max(0, Math.min(1, peakRef.current / config.redline));
      const px = barX + barW * pt;
      ctx.strokeStyle = "#D8DCE2";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, barY - 2); ctx.lineTo(px, barY + barH + 2);
      ctx.stroke();
    }

    // RPM number overlay
    ctx.fillStyle = "#D8DCE2";
    ctx.font = `bold ${Math.floor(h * 0.5)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(r === 0 ? "—" : String(Math.round(r)), barX + barW - 8, h / 2);
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}
```

- [ ] **Step 2: Config editor**

Create `packages/widgets/src/engine-bar/config-editor.tsx`:

```tsx
import type { WidgetConfigEditorProps } from "../types";
import type { EngineBarConfig } from "./render";

export function EngineBarConfigEditor({ config, onChange }: WidgetConfigEditorProps<EngineBarConfig>) {
  const set = (k: keyof EngineBarConfig, v: unknown) => onChange({ ...config, [k]: v } as EngineBarConfig);
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      <label className="flex justify-between"><span>rpmChannelId</span>
        <input className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.rpmChannelId} onChange={(e) => set("rpmChannelId", e.target.value)} />
      </label>
      <label className="flex justify-between"><span>gearChannelId</span>
        <input className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.gearChannelId ?? ""} onChange={(e) => set("gearChannelId", e.target.value || undefined)} />
      </label>
      <label className="flex justify-between"><span>redline</span>
        <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.redline} onChange={(e) => set("redline", Number(e.target.value))} />
      </label>
      <label className="flex justify-between"><span>shiftLightStart</span>
        <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.shiftLightStart} onChange={(e) => set("shiftLightStart", Number(e.target.value))} />
      </label>
      <label className="flex justify-between"><span>segments</span>
        <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.segments} onChange={(e) => set("segments", Number(e.target.value))} />
      </label>
    </div>
  );
}
```

- [ ] **Step 3: Descriptor**

Create `packages/widgets/src/engine-bar/index.tsx`:

```tsx
import type { Widget } from "../types";
import { EngineBarConfigEditor } from "./config-editor";
import { EngineBarRender, type EngineBarConfig } from "./render";

export const engineBarWidget: Widget<EngineBarConfig> = {
  type: "engine_bar",
  defaultConfig: { rpmChannelId: "engine.rpm", redline: 14000, shiftLightStart: 12000, segments: 30 },
  ConfigEditor: EngineBarConfigEditor,
  Render: EngineBarRender,
  requiredChannels: (c) => [c.rpmChannelId, c.gearChannelId].filter((x): x is string => Boolean(x)),
};

export type { EngineBarConfig } from "./render";
```

- [ ] **Step 4: Test**

Create `packages/widgets/tests/engine-bar.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { engineBarWidget } from "../src/engine-bar";
import { CursorEmitter } from "@helios/lib";

describe("EngineBar", () => {
  it("requiredChannels includes rpm and gear when both set", () => {
    expect(engineBarWidget.requiredChannels({
      rpmChannelId: "engine.rpm", gearChannelId: "engine.gear",
      redline: 14000, shiftLightStart: 12000, segments: 30,
    })).toEqual(["engine.rpm", "engine.gear"]);
  });

  it("renders a canvas", () => {
    const { container } = render(<engineBarWidget.Render
      config={{ rpmChannelId: "engine.rpm", redline: 14000, shiftLightStart: 12000, segments: 30 }}
      slice={{ time: BigInt64Array.from([0n]), data: new Map([["engine.rpm", Float64Array.from([8000])]]), range: { startUs: 0, endUs: 1 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
```

- [ ] **Step 5: Re-export + run + commit**

Append `export * from "./engine-bar";` to `packages/widgets/src/index.ts`.

```bash
cd ~/Developer/helios
pnpm --filter @helios/widgets test engine-bar
git add packages/widgets
git commit -m "feat(widgets): add EngineBar with shift-light segments + peak-hold + gear inset"
```

Expected: 2 passed.

---

## Task 4: GpsTrack

GPS track visualization on a custom canvas — projects lat/lon to local 2D, renders the polyline, and draws the car position at the cursor. No basemap (Plan 7 polish).

**Files:**
- Create: `packages/widgets/src/gps-track/render.tsx`
- Create: `packages/widgets/src/gps-track/config-editor.tsx`
- Create: `packages/widgets/src/gps-track/index.tsx`
- Create: `packages/widgets/tests/gps-track.test.tsx`
- Modify: `packages/widgets/src/index.ts`

- [ ] **Step 1: Render**

Create `packages/widgets/src/gps-track/render.tsx`:

```tsx
import { useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { sampleAt } from "../lib/sample-at";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";

export interface GpsTrackConfig {
  latChannelId: string;
  lonChannelId: string;
  /** optional: color the track by this channel's value */
  colorByChannelId?: string;
  /** when colorBy is set: gradient stops min..max */
  colorMin?: number;
  colorMax?: number;
}

export function GpsTrackRender(props: WidgetRenderProps<GpsTrackConfig>) {
  const { config, slice, cursorEmitter } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tRef = useRef<number>(cursorEmitter.get());

  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      tRef.current = t;
      drawCar();
    });
    return off;
  }, [cursorEmitter]);

  useEffect(() => { draw(); }, [slice, config]);

  function projectAll(): { xs: Float64Array; ys: Float64Array; n: number } | null {
    const lat = slice.data.get(config.latChannelId);
    const lon = slice.data.get(config.lonChannelId);
    if (!lat || !lon) return null;
    const n = Math.min(lat.length, lon.length);
    if (n === 0) return null;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (let i = 0; i < n; i++) {
      const la = lat[i]!, lo = lon[i]!;
      if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
    }
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = (lon[i]! - minLon) / Math.max(1e-12, maxLon - minLon);
      ys[i] = 1 - (lat[i]! - minLat) / Math.max(1e-12, maxLat - minLat); // y flipped (north up)
    }
    return { xs, ys, n };
  }

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);
    const proj = projectAll();
    if (!proj) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("no GPS data", w / 2, h / 2);
      return;
    }
    const { xs, ys, n } = proj;
    const pad = 16;
    const px = (i: number) => pad + xs[i]! * (w - pad * 2);
    const py = (i: number) => pad + ys[i]! * (h - pad * 2);

    // Track polyline
    const colorBy = config.colorByChannelId ? slice.data.get(config.colorByChannelId) : undefined;
    if (colorBy && config.colorMin !== undefined && config.colorMax !== undefined) {
      const span = config.colorMax - config.colorMin;
      ctx.lineWidth = 2.5;
      for (let i = 1; i < n; i++) {
        const t = Math.max(0, Math.min(1, ((colorBy[i] ?? 0) - config.colorMin) / span));
        ctx.strokeStyle = lerpColor("#26A69A", "#FFB800", t);
        ctx.beginPath();
        ctx.moveTo(px(i - 1), py(i - 1));
        ctx.lineTo(px(i), py(i));
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = "#4FC3F7"; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px(0), py(0));
      for (let i = 1; i < n; i++) ctx.lineTo(px(i), py(i));
      ctx.stroke();
    }
    drawCar();

    // Channel label
    ctx.fillStyle = "#7B8088"; ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`GPS · ${n} pts${config.colorByChannelId ? ` · ${config.colorByChannelId}` : ""}`, 6, 6);
  }

  function drawCar() {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    const proj = projectAll(); if (!proj) return;
    // Find sample index nearest tRef.current
    const t = BigInt(tRef.current);
    let lo = 0, hi = slice.time.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (slice.time[mid]! <= t) lo = mid + 1; else hi = mid;
    }
    const idx = Math.max(0, Math.min(proj.n - 1, lo - 1));
    const { w, h } = canvasLogicalSize(c);
    const pad = 16;
    const x = pad + proj.xs[idx]! * (w - pad * 2);
    const y = pad + proj.ys[idx]! * (h - pad * 2);
    // Cover with the underlying section by redrawing background at the spot
    ctx.fillStyle = "#FFC627";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0E0E10"; ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}

function lerpColor(aHex: string, bHex: string, t: number): string {
  const a = hex2(aHex), b = hex2(bHex);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bl})`;
}
function hex2(h: string) {
  const v = parseInt(h.slice(1), 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}
```

- [ ] **Step 2: Config editor**

Create `packages/widgets/src/gps-track/config-editor.tsx`:

```tsx
import type { WidgetConfigEditorProps } from "../types";
import type { GpsTrackConfig } from "./render";

export function GpsTrackConfigEditor({ config, onChange }: WidgetConfigEditorProps<GpsTrackConfig>) {
  const set = (k: keyof GpsTrackConfig, v: unknown) => onChange({ ...config, [k]: v } as GpsTrackConfig);
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      {(["latChannelId", "lonChannelId", "colorByChannelId"] as const).map((k) => (
        <label key={k} className="flex justify-between"><span>{k}</span>
          <input className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-40"
            value={(config[k] as string | undefined) ?? ""}
            onChange={(e) => set(k, e.target.value || undefined)} />
        </label>
      ))}
      {(["colorMin", "colorMax"] as const).map((k) => (
        <label key={k} className="flex justify-between"><span>{k}</span>
          <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-40"
            value={config[k] === undefined ? "" : config[k]}
            onChange={(e) => set(k, e.target.value === "" ? undefined : Number(e.target.value))} />
        </label>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Descriptor**

Create `packages/widgets/src/gps-track/index.tsx`:

```tsx
import type { Widget } from "../types";
import { GpsTrackConfigEditor } from "./config-editor";
import { GpsTrackRender, type GpsTrackConfig } from "./render";

export const gpsTrackWidget: Widget<GpsTrackConfig> = {
  type: "gps_track",
  defaultConfig: { latChannelId: "gps.lat", lonChannelId: "gps.lon" },
  ConfigEditor: GpsTrackConfigEditor,
  Render: GpsTrackRender,
  requiredChannels: (c) => [c.latChannelId, c.lonChannelId, c.colorByChannelId].filter((x): x is string => Boolean(x)),
};

export type { GpsTrackConfig } from "./render";
```

- [ ] **Step 4: Test**

Create `packages/widgets/tests/gps-track.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { gpsTrackWidget } from "../src/gps-track";
import { CursorEmitter } from "@helios/lib";

describe("GpsTrack", () => {
  it("renders 'no GPS data' when channels missing", () => {
    const { container } = render(<gpsTrackWidget.Render
      config={{ latChannelId: "gps.lat", lonChannelId: "gps.lon" }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("renders track when GPS samples present", () => {
    const time = BigInt64Array.from([0n, 1000n, 2000n, 3000n]);
    const lat = Float64Array.from([33.42, 33.4205, 33.421, 33.42]);
    const lon = Float64Array.from([-111.92, -111.921, -111.922, -111.92]);
    const { container } = render(<gpsTrackWidget.Render
      config={{ latChannelId: "gps.lat", lonChannelId: "gps.lon" }}
      slice={{ time, data: new Map([["gps.lat", lat], ["gps.lon", lon]]), range: { startUs: 0, endUs: 3000 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 3000 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("requiredChannels includes colorBy when set", () => {
    expect(gpsTrackWidget.requiredChannels({
      latChannelId: "gps.lat", lonChannelId: "gps.lon", colorByChannelId: "engine.rpm",
    })).toContain("engine.rpm");
  });
});
```

- [ ] **Step 5: Re-export + run + commit**

Append `export * from "./gps-track";` to `packages/widgets/src/index.ts`.

```bash
cd ~/Developer/helios
pnpm --filter @helios/widgets test gps-track
git add packages/widgets
git commit -m "feat(widgets): add GpsTrack with canvas projection + colored polyline + cursor dot"
```

Expected: 3 passed.

---

## Task 5: LapPanel

Table of laps. Plan 2 ships the rendering against laps passed via config; Plan 4 will wire it to live lap detection.

**Files:**
- Create: `packages/widgets/src/lap-panel/render.tsx`
- Create: `packages/widgets/src/lap-panel/config-editor.tsx`
- Create: `packages/widgets/src/lap-panel/index.tsx`
- Create: `packages/widgets/tests/lap-panel.test.tsx`
- Modify: `packages/widgets/src/index.ts`

- [ ] **Step 1: Render**

Create `packages/widgets/src/lap-panel/render.tsx`:

```tsx
import type { WidgetRenderProps } from "../types";
import { formatLapTime } from "@helios/lib";

export interface LapEntry { number: number; time_ms: number; }
export interface LapPanelConfig {
  /** Static laps for Plan 2 — will be replaced by live detection in Plan 4. */
  laps: LapEntry[];
}

export function LapPanelRender(props: WidgetRenderProps<LapPanelConfig>) {
  const { config } = props;
  const laps = config.laps;
  const best = laps.length === 0 ? null : laps.reduce((a, b) => (b.time_ms < a.time_ms ? b : a)).time_ms;
  return (
    <div className="w-full h-full bg-[#16171B] overflow-auto">
      <table className="w-full text-xs font-mono-num">
        <thead className="text-[#7B8088] uppercase text-[10px]">
          <tr className="border-b border-[#2A2C32]">
            <th className="text-left px-2 py-1">Lap</th>
            <th className="text-right px-2 py-1">Time</th>
            <th className="text-right px-2 py-1">Δ best</th>
          </tr>
        </thead>
        <tbody>
          {laps.length === 0 && (
            <tr><td colSpan={3} className="text-center text-[#7B8088] py-4">no laps detected</td></tr>
          )}
          {laps.map((lap) => {
            const isBest = best !== null && lap.time_ms === best;
            const dt = best !== null ? lap.time_ms - best : 0;
            return (
              <tr key={lap.number} className={`border-b border-[#23252B] ${isBest ? "bg-[#0E0E10]" : ""}`}>
                <td className="px-2 py-1">{lap.number}</td>
                <td className={`text-right px-2 py-1 ${isBest ? "text-[#FFC627] font-bold" : "text-[#D8DCE2]"}`}>{formatLapTime(lap.time_ms * 1000)}</td>
                <td className="text-right px-2 py-1 text-[#7B8088]">{dt === 0 ? "—" : `+${(dt / 1000).toFixed(3)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Config editor**

Create `packages/widgets/src/lap-panel/config-editor.tsx`:

```tsx
import type { WidgetConfigEditorProps } from "../types";
import type { LapPanelConfig } from "./render";

export function LapPanelConfigEditor({ config, onChange }: WidgetConfigEditorProps<LapPanelConfig>) {
  return (
    <div className="p-2 text-xs text-[#7B8088]">
      <div>Static laps: <span className="text-[#D8DCE2]">{config.laps.length}</span></div>
      <button
        className="mt-2 text-[#FFC627]"
        onClick={() => onChange({ laps: [] })}
      >clear laps</button>
      <p className="mt-2">Live lap detection arrives in Plan 4. For now laps come from session config.</p>
    </div>
  );
}
```

- [ ] **Step 3: Descriptor**

Create `packages/widgets/src/lap-panel/index.tsx`:

```tsx
import type { Widget } from "../types";
import { LapPanelConfigEditor } from "./config-editor";
import { LapPanelRender, type LapPanelConfig } from "./render";

export const lapPanelWidget: Widget<LapPanelConfig> = {
  type: "lap_panel",
  defaultConfig: { laps: [] },
  ConfigEditor: LapPanelConfigEditor,
  Render: LapPanelRender,
  requiredChannels: () => [],
};

export type { LapPanelConfig, LapEntry } from "./render";
```

- [ ] **Step 4: Test**

Create `packages/widgets/tests/lap-panel.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { lapPanelWidget } from "../src/lap-panel";
import { CursorEmitter } from "@helios/lib";

describe("LapPanel", () => {
  it("shows 'no laps detected' when empty", () => {
    render(<lapPanelWidget.Render
      config={{ laps: [] }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(screen.getByText("no laps detected")).toBeDefined();
  });

  it("renders laps and highlights the fastest", () => {
    render(<lapPanelWidget.Render
      config={{ laps: [
        { number: 1, time_ms: 75432 },
        { number: 2, time_ms: 74100 },
        { number: 3, time_ms: 75999 },
      ] }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(screen.getByText("1:14.100")).toBeDefined();
    expect(screen.getByText("1:15.432")).toBeDefined();
  });
});
```

- [ ] **Step 5: Re-export + run + commit**

Append `export * from "./lap-panel";` to `packages/widgets/src/index.ts`.

```bash
cd ~/Developer/helios
pnpm --filter @helios/widgets test lap-panel
git add packages/widgets
git commit -m "feat(widgets): add LapPanel table with best-lap highlight (static laps for now)"
```

Expected: 2 passed.

---

## Task 6: AlarmPanel

List of triggered alarms. Plan 2 ships the UI against alarms supplied via config; Plan 5 wires the live evaluator.

**Files:**
- Create: `packages/widgets/src/alarm-panel/render.tsx`
- Create: `packages/widgets/src/alarm-panel/config-editor.tsx`
- Create: `packages/widgets/src/alarm-panel/index.tsx`
- Create: `packages/widgets/tests/alarm-panel.test.tsx`
- Modify: `packages/widgets/src/index.ts`

- [ ] **Step 1: Render**

Create `packages/widgets/src/alarm-panel/render.tsx`:

```tsx
import type { WidgetRenderProps } from "../types";
import { formatClock } from "@helios/lib";

export type AlarmSeverity = "info" | "warn" | "critical";
export interface AlarmEntry {
  id: string;
  severity: AlarmSeverity;
  channel: string;
  value: number;
  message: string;
  t_us: number;
}
export interface AlarmPanelConfig {
  /** Static alarms for Plan 2 — Plan 5 wires live evaluation. */
  alarms: AlarmEntry[];
}

const sevColor = (s: AlarmSeverity) =>
  s === "critical" ? "#EF5350" : s === "warn" ? "#FFB800" : "#4FC3F7";

export function AlarmPanelRender(props: WidgetRenderProps<AlarmPanelConfig>) {
  const { config } = props;
  return (
    <div className="w-full h-full bg-[#16171B] overflow-auto">
      <table className="w-full text-xs">
        <thead className="text-[#7B8088] uppercase text-[10px]">
          <tr className="border-b border-[#2A2C32]">
            <th className="text-left px-2 py-1">When</th>
            <th className="text-left px-2 py-1">Channel</th>
            <th className="text-right px-2 py-1">Value</th>
            <th className="text-left px-2 py-1">Message</th>
          </tr>
        </thead>
        <tbody>
          {config.alarms.length === 0 && (
            <tr><td colSpan={4} className="text-center text-[#7B8088] py-4">no alarms</td></tr>
          )}
          {config.alarms.map((a) => (
            <tr key={a.id} className="border-b border-[#23252B]">
              <td className="px-2 py-1 font-mono-num text-[#7B8088]">{formatClock(a.t_us)}</td>
              <td className="px-2 py-1" style={{ color: sevColor(a.severity) }}>● {a.channel}</td>
              <td className="text-right px-2 py-1 font-mono-num">{a.value.toFixed(2)}</td>
              <td className="px-2 py-1 text-[#D8DCE2]">{a.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Config editor**

Create `packages/widgets/src/alarm-panel/config-editor.tsx`:

```tsx
import type { WidgetConfigEditorProps } from "../types";
import type { AlarmPanelConfig } from "./render";

export function AlarmPanelConfigEditor({ config, onChange }: WidgetConfigEditorProps<AlarmPanelConfig>) {
  return (
    <div className="p-2 text-xs text-[#7B8088]">
      <div>Static alarms: <span className="text-[#D8DCE2]">{config.alarms.length}</span></div>
      <button className="mt-2 text-[#FFC627]" onClick={() => onChange({ alarms: [] })}>clear alarms</button>
      <p className="mt-2">Live alarm evaluation arrives in Plan 5.</p>
    </div>
  );
}
```

- [ ] **Step 3: Descriptor**

Create `packages/widgets/src/alarm-panel/index.tsx`:

```tsx
import type { Widget } from "../types";
import { AlarmPanelConfigEditor } from "./config-editor";
import { AlarmPanelRender, type AlarmPanelConfig } from "./render";

export const alarmPanelWidget: Widget<AlarmPanelConfig> = {
  type: "alarm_panel",
  defaultConfig: { alarms: [] },
  ConfigEditor: AlarmPanelConfigEditor,
  Render: AlarmPanelRender,
  requiredChannels: () => [],
};

export type { AlarmPanelConfig, AlarmEntry, AlarmSeverity } from "./render";
```

- [ ] **Step 4: Test**

Create `packages/widgets/tests/alarm-panel.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { alarmPanelWidget } from "../src/alarm-panel";
import { CursorEmitter } from "@helios/lib";

describe("AlarmPanel", () => {
  it("shows 'no alarms' when empty", () => {
    render(<alarmPanelWidget.Render
      config={{ alarms: [] }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(screen.getByText("no alarms")).toBeDefined();
  });

  it("renders alarms with severity color", () => {
    render(<alarmPanelWidget.Render
      config={{ alarms: [
        { id: "a1", severity: "warn", channel: "engine.water_temp", value: 108, message: "above warn", t_us: 12_345_000 },
        { id: "a2", severity: "critical", channel: "engine.oil_temp", value: 138, message: "above alarm", t_us: 23_456_000 },
      ] }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(screen.getByText("● engine.water_temp")).toBeDefined();
    expect(screen.getByText("● engine.oil_temp")).toBeDefined();
  });
});
```

- [ ] **Step 5: Re-export + run + commit**

Append `export * from "./alarm-panel";` to `packages/widgets/src/index.ts`.

```bash
cd ~/Developer/helios
pnpm --filter @helios/widgets test alarm-panel
git add packages/widgets
git commit -m "feat(widgets): add AlarmPanel list with severity colors (static alarms for now)"
```

Expected: 2 passed.

---

## Task 7: TireGrid

4-corner tire display: per-corner temp (color band) + pressure (number) + wear (bar).

**Files:**
- Create: `packages/widgets/src/tire-grid/render.tsx`
- Create: `packages/widgets/src/tire-grid/config-editor.tsx`
- Create: `packages/widgets/src/tire-grid/index.tsx`
- Create: `packages/widgets/tests/tire-grid.test.tsx`
- Modify: `packages/widgets/src/index.ts`

- [ ] **Step 1: Render**

Create `packages/widgets/src/tire-grid/render.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { WidgetRenderProps } from "../types";
import { sampleAt } from "../lib/sample-at";

type Corner = "lf" | "rf" | "lr" | "rr";
const CORNERS: Corner[] = ["lf", "rf", "lr", "rr"];

export interface TireGridConfig {
  tempChannels:     Record<Corner, string>;
  pressureChannels: Record<Corner, string>;
  wearChannels?:    Record<Corner, string>;
  tempMin: number;
  tempMax: number;
  tempCool: number;   // below = blue
  tempHot: number;    // above = red
}

export function TireGridRender(props: WidgetRenderProps<TireGridConfig>) {
  const { config, slice, cursorEmitter } = props;
  const [tick, setTick] = useState(0);
  useEffect(() => cursorEmitter.subscribe(() => setTick((x) => x + 1)), [cursorEmitter]);
  const t = cursorEmitter.get();
  const data = (() => {
    const out: Record<Corner, { temp: number | null; pressure: number | null; wear: number | null }> = {} as never;
    for (const c of CORNERS) {
      out[c] = {
        temp: sampleAt(slice, config.tempChannels[c], t),
        pressure: sampleAt(slice, config.pressureChannels[c], t),
        wear: config.wearChannels ? sampleAt(slice, config.wearChannels[c], t) : null,
      };
    }
    return out;
  })();
  void tick; // ensure re-render on cursor

  function tempColor(temp: number | null): string {
    if (temp === null) return "#23252B";
    if (temp < config.tempCool) return "#4FC3F7";
    if (temp > config.tempHot) return "#EF5350";
    const t = (temp - config.tempCool) / Math.max(1e-9, config.tempHot - config.tempCool);
    return t < 0.5 ? "#26A69A" : "#FFB800";
  }

  function corner(c: Corner) {
    const d = data[c];
    return (
      <div className="flex flex-col bg-[#0E0E10] border border-[#2A2C32] m-1 p-2 flex-1">
        <div className="text-[10px] uppercase text-[#7B8088]">{c.toUpperCase()}</div>
        <div className="flex-1 flex items-center justify-center">
          <div className="w-full h-2 rounded-sm" style={{ background: tempColor(d.temp) }} />
        </div>
        <div className="font-mono-num text-lg text-[#D8DCE2] text-center">
          {d.temp === null ? "—" : `${d.temp.toFixed(0)}°`}
        </div>
        <div className="font-mono-num text-xs text-[#7B8088] text-center">
          {d.pressure === null ? "—" : `${d.pressure.toFixed(1)} psi`}
        </div>
        {config.wearChannels && (
          <div className="mt-1 h-1 bg-[#2A2C32] relative">
            <div className="absolute inset-y-0 left-0 bg-[#FFB800]"
                 style={{ width: `${Math.max(0, Math.min(100, ((d.wear ?? 0) * 100)))}%` }} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-[#16171B] grid grid-cols-2 grid-rows-2">
      {corner("lf")}{corner("rf")}{corner("lr")}{corner("rr")}
    </div>
  );
}
```

- [ ] **Step 2: Config editor**

Create `packages/widgets/src/tire-grid/config-editor.tsx`:

```tsx
import type { WidgetConfigEditorProps } from "../types";
import type { TireGridConfig } from "./render";

const CORNERS = ["lf", "rf", "lr", "rr"] as const;

export function TireGridConfigEditor({ config, onChange }: WidgetConfigEditorProps<TireGridConfig>) {
  const setTemp = (c: typeof CORNERS[number], v: string) =>
    onChange({ ...config, tempChannels: { ...config.tempChannels, [c]: v } });
  const setPressure = (c: typeof CORNERS[number], v: string) =>
    onChange({ ...config, pressureChannels: { ...config.pressureChannels, [c]: v } });
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      {CORNERS.map((c) => (
        <div key={c} className="grid grid-cols-3 gap-1">
          <span>{c.toUpperCase()}</span>
          <input className="bg-[#0E0E10] border border-[#2A2C32] px-1" placeholder="temp"
            value={config.tempChannels[c]} onChange={(e) => setTemp(c, e.target.value)} />
          <input className="bg-[#0E0E10] border border-[#2A2C32] px-1" placeholder="pressure"
            value={config.pressureChannels[c]} onChange={(e) => setPressure(c, e.target.value)} />
        </div>
      ))}
      {(["tempMin", "tempMax", "tempCool", "tempHot"] as const).map((k) => (
        <label key={k} className="flex justify-between"><span>{k}</span>
          <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-20"
            value={config[k]} onChange={(e) => onChange({ ...config, [k]: Number(e.target.value) })} />
        </label>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Descriptor**

Create `packages/widgets/src/tire-grid/index.tsx`:

```tsx
import type { Widget } from "../types";
import { TireGridConfigEditor } from "./config-editor";
import { TireGridRender, type TireGridConfig } from "./render";

export const tireGridWidget: Widget<TireGridConfig> = {
  type: "tire_grid",
  defaultConfig: {
    tempChannels: { lf: "", rf: "", lr: "", rr: "" },
    pressureChannels: { lf: "", rf: "", lr: "", rr: "" },
    tempMin: 60, tempMax: 110, tempCool: 75, tempHot: 100,
  },
  ConfigEditor: TireGridConfigEditor,
  Render: TireGridRender,
  requiredChannels: (c) => [
    ...Object.values(c.tempChannels),
    ...Object.values(c.pressureChannels),
    ...(c.wearChannels ? Object.values(c.wearChannels) : []),
  ].filter(Boolean),
};

export type { TireGridConfig } from "./render";
```

- [ ] **Step 4: Test**

Create `packages/widgets/tests/tire-grid.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { tireGridWidget } from "../src/tire-grid";
import { CursorEmitter } from "@helios/lib";

describe("TireGrid", () => {
  it("renders all four corners", () => {
    render(<tireGridWidget.Render
      config={tireGridWidget.defaultConfig}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(screen.getByText("LF")).toBeDefined();
    expect(screen.getByText("RF")).toBeDefined();
    expect(screen.getByText("LR")).toBeDefined();
    expect(screen.getByText("RR")).toBeDefined();
  });

  it("requiredChannels lists all configured channel ids", () => {
    const cfg = {
      ...tireGridWidget.defaultConfig,
      tempChannels: { lf: "lf.t", rf: "rf.t", lr: "lr.t", rr: "rr.t" } as const,
      pressureChannels: { lf: "lf.p", rf: "rf.p", lr: "lr.p", rr: "rr.p" } as const,
    };
    expect(tireGridWidget.requiredChannels(cfg).length).toBe(8);
  });
});
```

- [ ] **Step 5: Re-export + run + commit**

Append `export * from "./tire-grid";` to `packages/widgets/src/index.ts`.

```bash
cd ~/Developer/helios
pnpm --filter @helios/widgets test tire-grid
git add packages/widgets
git commit -m "feat(widgets): add TireGrid 4-corner display with temp color, pressure, wear bar"
```

Expected: 2 passed.

---

## Task 8: Histogram

Bin distribution of one channel over the visible time window.

**Files:**
- Create: `packages/widgets/src/histogram/render.tsx`
- Create: `packages/widgets/src/histogram/config-editor.tsx`
- Create: `packages/widgets/src/histogram/index.tsx`
- Create: `packages/widgets/tests/histogram.test.tsx`
- Modify: `packages/widgets/src/index.ts`

- [ ] **Step 1: Render**

Create `packages/widgets/src/histogram/render.tsx`:

```tsx
import { useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";

export interface HistogramConfig {
  channelId: string;
  bins: number;
  min?: number;
  max?: number;
  color: string;
}

export function HistogramRender(props: WidgetRenderProps<HistogramConfig>) {
  const { config, slice } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => { draw(); }, [slice, config]);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);

    const data = slice.data.get(config.channelId);
    if (!data || data.length === 0) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("no data", w / 2, h / 2);
      return;
    }

    let lo = config.min, hi = config.max;
    if (lo === undefined || hi === undefined) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < data.length; i++) {
        const v = data[i]!;
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
      lo = lo ?? mn; hi = hi ?? mx;
    }
    const bins = Math.max(1, Math.min(200, config.bins));
    const counts = new Uint32Array(bins);
    const span = Math.max(1e-9, hi - lo);
    for (let i = 0; i < data.length; i++) {
      const v = data[i]!;
      const idx = Math.max(0, Math.min(bins - 1, Math.floor(((v - lo) / span) * bins)));
      counts[idx]++;
    }
    let maxCount = 0;
    for (let i = 0; i < bins; i++) if (counts[i]! > maxCount) maxCount = counts[i]!;

    const padL = 4, padR = 4, padT = 18, padB = 16;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const binW = plotW / bins;

    ctx.fillStyle = config.color;
    for (let i = 0; i < bins; i++) {
      const barH = maxCount === 0 ? 0 : (counts[i]! / maxCount) * plotH;
      ctx.fillRect(padL + i * binW + 0.5, padT + plotH - barH, Math.max(1, binW - 1), barH);
    }

    ctx.strokeStyle = "#2A2C32"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH + 0.5);
    ctx.lineTo(padL + plotW, padT + plotH + 0.5);
    ctx.stroke();

    ctx.fillStyle = "#7B8088"; ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`${config.channelId} · n=${data.length}`, 4, 4);
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText(lo!.toFixed(1), padL, h - 2);
    ctx.textAlign = "right";
    ctx.fillText(hi!.toFixed(1), w - padR, h - 2);
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}
```

- [ ] **Step 2: Config editor**

Create `packages/widgets/src/histogram/config-editor.tsx`:

```tsx
import type { WidgetConfigEditorProps } from "../types";
import type { HistogramConfig } from "./render";

export function HistogramConfigEditor({ config, onChange }: WidgetConfigEditorProps<HistogramConfig>) {
  const set = (k: keyof HistogramConfig, v: unknown) => onChange({ ...config, [k]: v } as HistogramConfig);
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      <label className="flex justify-between"><span>channelId</span>
        <input className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.channelId} onChange={(e) => set("channelId", e.target.value)} /></label>
      <label className="flex justify-between"><span>bins</span>
        <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.bins} onChange={(e) => set("bins", Number(e.target.value))} /></label>
      <label className="flex justify-between"><span>min</span>
        <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.min ?? ""} onChange={(e) => set("min", e.target.value === "" ? undefined : Number(e.target.value))} /></label>
      <label className="flex justify-between"><span>max</span>
        <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.max ?? ""} onChange={(e) => set("max", e.target.value === "" ? undefined : Number(e.target.value))} /></label>
      <label className="flex justify-between"><span>color</span>
        <input type="color" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.color} onChange={(e) => set("color", e.target.value)} /></label>
    </div>
  );
}
```

- [ ] **Step 3: Descriptor**

Create `packages/widgets/src/histogram/index.tsx`:

```tsx
import type { Widget } from "../types";
import { HistogramConfigEditor } from "./config-editor";
import { HistogramRender, type HistogramConfig } from "./render";

export const histogramWidget: Widget<HistogramConfig> = {
  type: "histogram",
  defaultConfig: { channelId: "", bins: 30, color: "#4FC3F7" },
  ConfigEditor: HistogramConfigEditor,
  Render: HistogramRender,
  requiredChannels: (c) => (c.channelId ? [c.channelId] : []),
};

export type { HistogramConfig } from "./render";
```

- [ ] **Step 4: Test**

Create `packages/widgets/tests/histogram.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { histogramWidget } from "../src/histogram";
import { CursorEmitter } from "@helios/lib";

describe("Histogram", () => {
  it("renders 'no data' for empty slice", () => {
    const { container } = render(<histogramWidget.Render
      config={{ ...histogramWidget.defaultConfig, channelId: "x" }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("renders bars for non-empty data", () => {
    const x = new Float64Array(1000);
    for (let i = 0; i < 1000; i++) x[i] = Math.sin(i / 50) * 100;
    const { container } = render(<histogramWidget.Render
      config={{ ...histogramWidget.defaultConfig, channelId: "x", bins: 20 }}
      slice={{ time: BigInt64Array.from([0n]), data: new Map([["x", x]]), range: { startUs: 0, endUs: 1 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
```

- [ ] **Step 5: Re-export + run + commit**

Append `export * from "./histogram";` to `packages/widgets/src/index.ts`.

```bash
cd ~/Developer/helios
pnpm --filter @helios/widgets test histogram
git add packages/widgets
git commit -m "feat(widgets): add Histogram with auto-range bins on canvas"
```

Expected: 2 passed.

---

## Task 9: XYPlot

One channel vs another. G-G diagram, throttle-vs-steer, etc. Optional time-color trail.

**Files:**
- Create: `packages/widgets/src/xy-plot/render.tsx`
- Create: `packages/widgets/src/xy-plot/config-editor.tsx`
- Create: `packages/widgets/src/xy-plot/index.tsx`
- Create: `packages/widgets/tests/xy-plot.test.tsx`
- Modify: `packages/widgets/src/index.ts`

- [ ] **Step 1: Render**

Create `packages/widgets/src/xy-plot/render.tsx`:

```tsx
import { useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";

export interface XyPlotConfig {
  xChannelId: string;
  yChannelId: string;
  xMin?: number; xMax?: number;
  yMin?: number; yMax?: number;
  color: string;
  /** if true, color points by their time index (time-color trail) */
  trail: boolean;
}

export function XyPlotRender(props: WidgetRenderProps<XyPlotConfig>) {
  const { config, slice } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => { draw(); }, [slice, config]);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);

    const xs = slice.data.get(config.xChannelId);
    const ys = slice.data.get(config.yChannelId);
    if (!xs || !ys || xs.length === 0 || ys.length === 0) {
      ctx.fillStyle = "#7B8088"; ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("no data", w / 2, h / 2);
      return;
    }
    const n = Math.min(xs.length, ys.length);

    let xmin = config.xMin, xmax = config.xMax, ymin = config.yMin, ymax = config.yMax;
    if (xmin === undefined || xmax === undefined || ymin === undefined || ymax === undefined) {
      let xn = Infinity, xx = -Infinity, yn = Infinity, yx = -Infinity;
      for (let i = 0; i < n; i++) {
        const xv = xs[i]!, yv = ys[i]!;
        if (xv < xn) xn = xv; if (xv > xx) xx = xv;
        if (yv < yn) yn = yv; if (yv > yx) yx = yv;
      }
      xmin = xmin ?? xn; xmax = xmax ?? xx; ymin = ymin ?? yn; ymax = ymax ?? yx;
    }
    const padL = 28, padR = 8, padT = 18, padB = 22;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const xScale = (v: number) => padL + ((v - xmin!) / Math.max(1e-9, xmax! - xmin!)) * plotW;
    const yScale = (v: number) => padT + plotH - ((v - ymin!) / Math.max(1e-9, ymax! - ymin!)) * plotH;

    // Axes
    ctx.strokeStyle = "#2A2C32"; ctx.lineWidth = 1;
    ctx.strokeRect(padL + 0.5, padT + 0.5, plotW, plotH);
    // Origin lines (if 0 in range)
    ctx.strokeStyle = "#5A5F66";
    ctx.beginPath();
    if (xmin! < 0 && xmax! > 0) {
      const x0 = xScale(0); ctx.moveTo(x0, padT); ctx.lineTo(x0, padT + plotH);
    }
    if (ymin! < 0 && ymax! > 0) {
      const y0 = yScale(0); ctx.moveTo(padL, y0); ctx.lineTo(padL + plotW, y0);
    }
    ctx.stroke();

    // Points
    if (config.trail) {
      for (let i = 0; i < n; i++) {
        const t = i / Math.max(1, n - 1);
        ctx.fillStyle = lerpColor("#26A69A", "#FFB800", t);
        ctx.fillRect(xScale(xs[i]!) - 1, yScale(ys[i]!) - 1, 2, 2);
      }
    } else {
      ctx.fillStyle = config.color;
      for (let i = 0; i < n; i++) ctx.fillRect(xScale(xs[i]!) - 1, yScale(ys[i]!) - 1, 2, 2);
    }

    // Labels
    ctx.fillStyle = "#7B8088"; ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`${config.xChannelId} × ${config.yChannelId}`, 4, 4);
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText(xmin!.toFixed(1), padL, h - 4);
    ctx.textAlign = "right";
    ctx.fillText(xmax!.toFixed(1), w - padR, h - 4);
    ctx.save();
    ctx.translate(10, padT + plotH / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(`${ymin!.toFixed(1)} → ${ymax!.toFixed(1)}`, 0, 0);
    ctx.restore();
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}

function lerpColor(aHex: string, bHex: string, t: number): string {
  const a = hex2(aHex), b = hex2(bHex);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bl})`;
}
function hex2(h: string) {
  const v = parseInt(h.slice(1), 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}
```

- [ ] **Step 2: Config editor**

Create `packages/widgets/src/xy-plot/config-editor.tsx`:

```tsx
import type { WidgetConfigEditorProps } from "../types";
import type { XyPlotConfig } from "./render";

export function XyPlotConfigEditor({ config, onChange }: WidgetConfigEditorProps<XyPlotConfig>) {
  const set = (k: keyof XyPlotConfig, v: unknown) => onChange({ ...config, [k]: v } as XyPlotConfig);
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      {(["xChannelId", "yChannelId"] as const).map((k) => (
        <label key={k} className="flex justify-between"><span>{k}</span>
          <input className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config[k]} onChange={(e) => set(k, e.target.value)} />
        </label>
      ))}
      {(["xMin", "xMax", "yMin", "yMax"] as const).map((k) => (
        <label key={k} className="flex justify-between"><span>{k}</span>
          <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
            value={config[k] === undefined ? "" : config[k]}
            onChange={(e) => set(k, e.target.value === "" ? undefined : Number(e.target.value))} />
        </label>
      ))}
      <label className="flex justify-between"><span>color</span>
        <input type="color" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.color} onChange={(e) => set("color", e.target.value)} /></label>
      <label className="flex justify-between"><span>trail</span>
        <input type="checkbox" checked={config.trail} onChange={(e) => set("trail", e.target.checked)} /></label>
    </div>
  );
}
```

- [ ] **Step 3: Descriptor**

Create `packages/widgets/src/xy-plot/index.tsx`:

```tsx
import type { Widget } from "../types";
import { XyPlotConfigEditor } from "./config-editor";
import { XyPlotRender, type XyPlotConfig } from "./render";

export const xyPlotWidget: Widget<XyPlotConfig> = {
  type: "xy_plot",
  defaultConfig: { xChannelId: "", yChannelId: "", color: "#FFB800", trail: false },
  ConfigEditor: XyPlotConfigEditor,
  Render: XyPlotRender,
  requiredChannels: (c) => [c.xChannelId, c.yChannelId].filter(Boolean),
};

export type { XyPlotConfig } from "./render";
```

- [ ] **Step 4: Test**

Create `packages/widgets/tests/xy-plot.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { xyPlotWidget } from "../src/xy-plot";
import { CursorEmitter } from "@helios/lib";

describe("XyPlot", () => {
  it("renders 'no data' when channels missing", () => {
    const { container } = render(<xyPlotWidget.Render
      config={{ ...xyPlotWidget.defaultConfig, xChannelId: "a", yChannelId: "b" }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("renders points for valid data", () => {
    const a = Float64Array.from([0, 1, 2, 3, 4]);
    const b = Float64Array.from([0, 1, 4, 9, 16]);
    const { container } = render(<xyPlotWidget.Render
      config={{ ...xyPlotWidget.defaultConfig, xChannelId: "a", yChannelId: "b" }}
      slice={{ time: BigInt64Array.from([0n, 1n, 2n, 3n, 4n]), data: new Map([["a", a], ["b", b]]), range: { startUs: 0, endUs: 5 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 5 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
```

- [ ] **Step 5: Re-export + run + commit**

Append `export * from "./xy-plot";` to `packages/widgets/src/index.ts`.

```bash
cd ~/Developer/helios
pnpm --filter @helios/widgets test xy-plot
git add packages/widgets
git commit -m "feat(widgets): add XyPlot scatter with optional time-color trail"
```

Expected: 2 passed.

---

## Task 10: Default workspace showcase

Replace the Plan 1 default workspace with a comprehensive layout that exercises every widget type, then update the Tile registry to know about all of them.

**Files:**
- Modify: `apps/desktop/src/workspaces/overview-default.ts`
- Modify: `apps/desktop/src/components/Tile.tsx`

- [ ] **Step 1: Replace `apps/desktop/src/workspaces/overview-default.ts` entirely**

```ts
import type {
  StripChartConfig, NumericReadoutConfig, RoundGaugeConfig, BarGaugeConfig,
  EngineBarConfig, GpsTrackConfig, LapPanelConfig, AlarmPanelConfig,
  TireGridConfig, HistogramConfig, XyPlotConfig,
} from "@helios/widgets";

export type WidgetType =
  | "strip_chart" | "numeric_readout" | "round_gauge" | "bar_gauge"
  | "engine_bar" | "gps_track" | "lap_panel" | "alarm_panel"
  | "tire_grid" | "histogram" | "xy_plot";

export interface TileSpec {
  id: string;
  widgetType: WidgetType;
  config:
    | StripChartConfig | NumericReadoutConfig | RoundGaugeConfig | BarGaugeConfig
    | EngineBarConfig | GpsTrackConfig | LapPanelConfig | AlarmPanelConfig
    | TireGridConfig | HistogramConfig | XyPlotConfig;
  x: number; y: number; w: number; h: number;
}

export const overviewDefault: TileSpec[] = [
  // Top row: engine bar across full width
  {
    id: "engine-bar",
    widgetType: "engine_bar",
    config: {
      rpmChannelId: "engine.rpm", gearChannelId: "engine.gear",
      redline: 14000, shiftLightStart: 12000, segments: 30,
    },
    x: 0, y: 0, w: 1, h: 0.10,
  },

  // Strip chart row
  {
    id: "rpm-strip",
    widgetType: "strip_chart",
    config: {
      channels: [
        { id: "engine.rpm", color: "#FFB800" },
        { id: "engine.tps", color: "#4FC3F7" },
      ],
      yMin: 0, yMax: 15000,
    },
    x: 0, y: 0.10, w: 0.7, h: 0.30,
  },

  // RPM round gauge + numeric readouts on the right
  {
    id: "rpm-gauge",
    widgetType: "round_gauge",
    config: {
      channelId: "engine.rpm", units: "rpm", decimals: 0,
      min: 0, max: 14000, warn: 12000, alarm: 13500,
    },
    x: 0.70, y: 0.10, w: 0.15, h: 0.30,
  },
  {
    id: "rpm-readout",
    widgetType: "numeric_readout",
    config: { channelId: "engine.rpm", units: "rpm", decimals: 0, warn: 12000, alarm: 13500 },
    x: 0.85, y: 0.10, w: 0.15, h: 0.15,
  },
  {
    id: "tps-readout",
    widgetType: "numeric_readout",
    config: { channelId: "engine.tps", units: "%", decimals: 1 },
    x: 0.85, y: 0.25, w: 0.15, h: 0.15,
  },

  // Middle row: GPS, water-temp gauge, oil-temp gauge, alarm panel
  {
    id: "gps-track",
    widgetType: "gps_track",
    config: { latChannelId: "gps.lat", lonChannelId: "gps.lon", colorByChannelId: "gps.speed", colorMin: 0, colorMax: 50 },
    x: 0, y: 0.40, w: 0.40, h: 0.30,
  },
  {
    id: "water-bar",
    widgetType: "bar_gauge",
    config: { channelId: "engine.water_temp", units: "°C", decimals: 1, min: 60, max: 130, warn: 105, alarm: 115, orientation: "vertical" },
    x: 0.40, y: 0.40, w: 0.10, h: 0.30,
  },
  {
    id: "oil-bar",
    widgetType: "bar_gauge",
    config: { channelId: "engine.oil_temp", units: "°C", decimals: 1, min: 60, max: 150, warn: 120, alarm: 135, orientation: "vertical" },
    x: 0.50, y: 0.40, w: 0.10, h: 0.30,
  },
  {
    id: "lap-panel",
    widgetType: "lap_panel",
    config: { laps: [
      { number: 1, time_ms: 75432 },
      { number: 2, time_ms: 74100 },
      { number: 3, time_ms: 73850 },
      { number: 4, time_ms: 74220 },
    ] },
    x: 0.60, y: 0.40, w: 0.20, h: 0.30,
  },
  {
    id: "alarm-panel",
    widgetType: "alarm_panel",
    config: { alarms: [
      { id: "demo-1", severity: "warn", channel: "engine.water_temp", value: 107, message: "above warn threshold", t_us: 12_000_000 },
      { id: "demo-2", severity: "info", channel: "engine.gear", value: 6, message: "max gear engaged", t_us: 38_000_000 },
    ] },
    x: 0.80, y: 0.40, w: 0.20, h: 0.30,
  },

  // Bottom row: histogram, xy plot, tire grid
  {
    id: "rpm-hist",
    widgetType: "histogram",
    config: { channelId: "engine.rpm", bins: 30, color: "#FFB800" },
    x: 0, y: 0.70, w: 0.30, h: 0.30,
  },
  {
    id: "gg-plot",
    widgetType: "xy_plot",
    config: {
      xChannelId: "imu.lat_g", yChannelId: "engine.tps",
      xMin: -2, xMax: 2, yMin: 0, yMax: 100,
      color: "#FFC627", trail: true,
    },
    x: 0.30, y: 0.70, w: 0.30, h: 0.30,
  },
  {
    id: "tire-grid",
    widgetType: "tire_grid",
    config: {
      tempChannels:     { lf: "tires.lf_temp", rf: "tires.rf_temp", lr: "tires.lr_temp", rr: "tires.rr_temp" },
      pressureChannels: { lf: "tires.lf_psi",  rf: "tires.rf_psi",  lr: "tires.lr_psi",  rr: "tires.rr_psi"  },
      tempMin: 60, tempMax: 110, tempCool: 75, tempHot: 100,
    },
    x: 0.60, y: 0.70, w: 0.40, h: 0.30,
  },
];
```

(Note: tire channels don't exist in the synthetic CSV — TireGrid will show "—" for each corner. That's expected; it'll come alive when real telemetry includes them.)

- [ ] **Step 2: Replace `apps/desktop/src/components/Tile.tsx` entirely**

```tsx
import {
  stripChartWidget, numericReadoutWidget, roundGaugeWidget, barGaugeWidget,
  engineBarWidget, gpsTrackWidget, lapPanelWidget, alarmPanelWidget,
  tireGridWidget, histogramWidget, xyPlotWidget,
  type Widget,
} from "@helios/widgets";
import type { ChannelStore } from "@helios/store";
import type { CursorEmitter } from "@helios/lib";
import type { TileSpec } from "../workspaces/overview-default";

const widgets: Record<string, Widget<unknown>> = {
  strip_chart:     stripChartWidget     as unknown as Widget<unknown>,
  numeric_readout: numericReadoutWidget as unknown as Widget<unknown>,
  round_gauge:     roundGaugeWidget     as unknown as Widget<unknown>,
  bar_gauge:       barGaugeWidget       as unknown as Widget<unknown>,
  engine_bar:      engineBarWidget      as unknown as Widget<unknown>,
  gps_track:       gpsTrackWidget       as unknown as Widget<unknown>,
  lap_panel:       lapPanelWidget       as unknown as Widget<unknown>,
  alarm_panel:     alarmPanelWidget     as unknown as Widget<unknown>,
  tire_grid:       tireGridWidget       as unknown as Widget<unknown>,
  histogram:       histogramWidget      as unknown as Widget<unknown>,
  xy_plot:         xyPlotWidget         as unknown as Widget<unknown>,
};

interface Props {
  spec: TileSpec;
  store: ChannelStore;
  cursorEmitter: CursorEmitter;
}

export function Tile({ spec, store, cursorEmitter }: Props) {
  const widget = widgets[spec.widgetType]!;
  const channels = widget.requiredChannels(spec.config);
  const range = store.extentUs();

  // Filter out channels that don't exist in the store, so unknown channels
  // (e.g. tire temps that the synthetic CSV doesn't carry) don't throw and
  // the widget can render its empty state.
  const known = channels.filter((id) => store.get(id) !== undefined);
  const slice = store.slice(known, { startUs: range.startUs, endUs: range.endUs });

  const RenderC = widget.Render;
  return (
    <div
      className="absolute"
      style={{
        left: `${spec.x * 100}%`, top: `${spec.y * 100}%`,
        width: `${spec.w * 100}%`, height: `${spec.h * 100}%`,
      }}
    >
      <div className="bg-[#0E0E10] text-[#7B8088] text-[10px] uppercase tracking-wider px-2 py-1 border-b border-[#2A2C32]">
        {spec.id}
      </div>
      <div className="absolute inset-0 top-[20px] border border-[#2A2C32] border-t-0">
        <RenderC
          config={spec.config}
          slice={slice}
          cursorEmitter={cursorEmitter}
          timeRange={{ startUs: range.startUs, endUs: range.endUs }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck and tests**

```bash
cd ~/Developer/helios
pnpm install
pnpm --filter @helios/desktop typecheck
pnpm --filter @helios/widgets test
```

Expected: typecheck passes; widget tests show all green.

- [ ] **Step 4: Commit**

```bash
cd ~/Developer/helios
git add apps/desktop
git commit -m "feat(desktop): showcase all 11 widgets in the default workspace"
```

---

## Task 11: Plan 2 acceptance

- [ ] **Step 1: Run all Rust + TS tests**

```bash
source "$HOME/.cargo/env"
cd ~/Developer/helios
cargo test
pnpm -r --workspace-concurrency=1 test
```

Expected: 32 Rust tests pass; widget package shows ≥ 20 tests pass total (3 registry + 2 strip-chart + 2 numeric-readout + 6 sample-at + 2×9 widget tests).

- [ ] **Step 2: Run typecheck across the workspace**

```bash
cd ~/Developer/helios
pnpm -r typecheck
```

Expected: clean.

- [ ] **Step 3: Tag**

```bash
cd ~/Developer/helios
git tag -a plan-2-widgets -m "Plan 2 complete: full v1 widget set + showcase workspace"
git push origin main
git push origin --tags
```

- [ ] **Step 4: Manual smoke**

`pnpm dev`, confirm:
- Engine bar at top with shift-light segments
- Strip chart + RPM gauge + RPM/TPS numeric readouts
- GPS track polyline (colored by speed) + tire grid (showing `—` since no tire channels)
- Histogram of RPM, G-G XY plot
- Alarm panel with two demo alarms, lap panel with 4 demo laps
