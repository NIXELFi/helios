// WaveViewerModal.tsx

import { useEffect, useRef, useState } from "react";

import { SchematicView } from "./SchematicView";
import { WaterfallView } from "./WaterfallView";
import { useWaveCapture } from "./useWaveCapture";
import type {
  WaveCylField,
  WaveField,
  WaveSizeField,
} from "../../state/types";

interface Bridge {
  loadWaves(
    jobId: string,
    studyKind: "single-rpm" | "sweep",
    rpmInt: number,
  ): Promise<unknown>;
}

interface Props {
  open: boolean;
  bridge: Bridge;
  jobId: string;
  studyKind: "single-rpm" | "sweep";
  rpmInt: number;
  sweepCapturedRpms?: number[];
  onClose(): void;
}

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4, 8] as const;

export function WaveViewerModal(props: Props) {
  if (!props.open) return null;
  return <WaveViewerModalBody {...props} />;
}

function WaveViewerModalBody(props: Props) {
  const { bridge, jobId, studyKind, sweepCapturedRpms, onClose } = props;
  const [rpmInt, setRpmInt] = useState(props.rpmInt);

  useEffect(() => {
    setRpmInt(props.rpmInt);
  }, [props.rpmInt]);

  const { state, data, error } = useWaveCapture(bridge, jobId, studyKind, rpmInt);

  const [view, setView] = useState<"schematic" | "waterfall">("schematic");
  const [field, setField] = useState<WaveField>("p");
  const [sizeField, setSizeField] = useState<WaveSizeField>("p");
  const [cylField, setCylField] = useState<WaveCylField>("x_b");
  const [speed, setSpeed] = useState<number>(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [frameIdx, setFrameIdx] = useState(0);
  const [waterfallPipeIdx, setWaterfallPipeIdx] = useState(0);

  useEffect(() => { setFrameIdx(0); setIsPlaying(false); }, [rpmInt]);

  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  useEffect(() => {
    if (!isPlaying || !data) return;
    const nFrames = data.manifest.frameCount;
    // 1× = cycle plays in VISUAL_CYCLE_SECONDS of real wall-clock time.
    // (Real engine time would be ~15 ms at 8000 rpm — unfollowable. The
    // viewer is for visualization, not playback timing.)
    const VISUAL_CYCLE_SECONDS = 3.0;
    const cycleSeconds = VISUAL_CYCLE_SECONDS;
    lastTickRef.current = performance.now();

    const tick = (now: number) => {
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;
      setFrameIdx((prev) => {
        const next = prev + (dt * speed * nFrames) / cycleSeconds;
        if (next >= nFrames) return next - nFrames;
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, speed, data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const frameInt = Math.max(0, Math.min(data ? data.manifest.frameCount - 1 : 0, Math.floor(frameIdx)));
  const headerInfo = data ? (
    <>
      RPM <span className="text-[#D8DCE2]">{data.manifest.rpm.toFixed(0)}</span>
      &nbsp;· cycle <span className="text-[#D8DCE2]">{data.manifest.capturedCycle}</span>
      &nbsp;· {data.manifest.frameCount} frames
      &nbsp;· θ {data.manifest.thetaStartDeg.toFixed(0)}°→{data.manifest.thetaEndDeg.toFixed(0)}°
      &nbsp;· stride {data.manifest.stepStride}
      {data.manifest.incomplete && <span className="ml-3 text-amber-400">INCOMPLETE</span>}
    </>
  ) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="wave-viewer-title"
      className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-full w-full flex-col rounded-md border border-helios-line bg-helios-panel text-helios-text">
        <div className="flex items-center justify-between border-b border-helios-line px-4 py-2">
          <h2 id="wave-viewer-title" className="text-sm font-semibold">Wave viewer</h2>
          <div className="text-[11px] text-helios-dim">{headerInfo}</div>
          <button
            type="button"
            aria-label="Close"
            className="rounded border border-helios-line px-2 py-0.5 text-xs hover:border-asu-gold"
            onClick={onClose}
          >Close ✕</button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-helios-line px-4 py-2 text-[11px] text-helios-dim">
          <div className="flex gap-1">
            <button
              type="button"
              aria-label="Schematic"
              aria-pressed={view === "schematic"}
              className={tabClass(view === "schematic")}
              onClick={() => setView("schematic")}
            >Schematic</button>
            <button
              type="button"
              aria-label="Waterfall"
              aria-pressed={view === "waterfall"}
              className={tabClass(view === "waterfall")}
              onClick={() => setView("waterfall")}
            >Waterfall</button>
          </div>

          {studyKind === "sweep" && sweepCapturedRpms && (
            <label className="flex items-center gap-1">
              RPM:
              <select
                value={rpmInt}
                onChange={(e) => setRpmInt(parseInt(e.target.value, 10))}
                className="rounded border border-helios-line bg-helios-base px-1 py-0.5"
              >
                {sweepCapturedRpms.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          )}

          <label className="flex items-center gap-1">
            field:
            <select value={field} onChange={(e) => setField(e.target.value as WaveField)} className="rounded border border-helios-line bg-helios-base px-1 py-0.5">
              <option value="p">pressure</option>
              <option value="u">velocity</option>
              <option value="T">temperature</option>
              <option value="rho">density</option>
              <option value="Mach">Mach</option>
            </select>
          </label>

          {view === "schematic" && (
            <>
              <label className="flex items-center gap-1">
                size:
                <select value={sizeField} onChange={(e) => setSizeField(e.target.value as WaveSizeField)} className="rounded border border-helios-line bg-helios-base px-1 py-0.5">
                  <option value="p">pressure</option>
                  <option value="u">velocity</option>
                  <option value="T">temperature</option>
                  <option value="rho">density</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                cyl:
                <select value={cylField} onChange={(e) => setCylField(e.target.value as WaveCylField)} className="rounded border border-helios-line bg-helios-base px-1 py-0.5">
                  <option value="x_b">x_b</option>
                  <option value="p">pressure</option>
                  <option value="T">temperature</option>
                </select>
              </label>
            </>
          )}

          {view === "waterfall" && data && (
            <label className="flex items-center gap-1">
              pipe:
              <select value={waterfallPipeIdx} onChange={(e) => setWaterfallPipeIdx(parseInt(e.target.value, 10))} className="rounded border border-helios-line bg-helios-base px-1 py-0.5">
                {data.manifest.pipes.map((p, i) => (
                  <option key={p.index} value={i}>{p.label}</option>
                ))}
              </select>
            </label>
          )}

          <label className="ml-auto flex items-center gap-1">
            speed:
            <select value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))} className="rounded border border-helios-line bg-helios-base px-1 py-0.5">
              {SPEED_OPTIONS.map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
          </label>
          <button
            type="button"
            className="rounded border border-helios-line px-2 py-0.5 hover:border-asu-gold"
            onClick={() => setFrameIdx((f) => Math.max(0, f - 1))}
            aria-label="Step back"
          >◀◀</button>
          <button
            type="button"
            className="rounded border border-helios-line px-2 py-0.5 hover:border-asu-gold"
            onClick={() => setIsPlaying((p) => !p)}
            aria-label={isPlaying ? "Pause" : "Play"}
          >{isPlaying ? "⏸" : "⏵"}</button>
          <button
            type="button"
            className="rounded border border-helios-line px-2 py-0.5 hover:border-asu-gold"
            onClick={() => setFrameIdx((f) => data ? Math.min(data.manifest.frameCount - 1, f + 1) : f)}
            aria-label="Step forward"
          >▶▶</button>
        </div>

        <div className="flex-1 overflow-hidden">
          {state === "loading" && <CenterText>Loading wave frames…</CenterText>}
          {state === "error" && <CenterText tone="error">Failed to load: {error}</CenterText>}
          {state === "ready" && data && view === "schematic" && (
            <SchematicView
              packed={data}
              frameIdx={frameInt}
              field={field}
              sizeField={sizeField}
              cylField={cylField}
            />
          )}
          {state === "ready" && data && view === "waterfall" && (
            <WaterfallView
              packed={data}
              pipeIdx={waterfallPipeIdx}
              field={field}
              frameIdx={frameInt}
              onScrub={(idx) => { setIsPlaying(false); setFrameIdx(idx); }}
            />
          )}
        </div>

        {state === "ready" && data && (
          <div className="flex items-center gap-2 border-t border-helios-line px-4 py-2 text-[11px] text-helios-dim">
            <span>θ {data.theta[frameInt]?.toFixed(0)}°</span>
            <input
              type="range"
              min={0}
              max={data.manifest.frameCount - 1}
              value={frameInt}
              onChange={(e) => setFrameIdx(parseInt(e.target.value, 10))}
              className="flex-1"
            />
            <span>frame {frameInt + 1}/{data.manifest.frameCount}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function tabClass(active: boolean): string {
  return `rounded border px-2 py-0.5 ${active ? "border-asu-gold bg-asu-gold/10 text-asu-gold" : "border-helios-line hover:border-asu-gold"}`;
}

function CenterText({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div className={`flex h-full items-center justify-center text-sm ${tone === "error" ? "text-red-300" : "text-helios-dim"}`}>
      {children}
    </div>
  );
}
