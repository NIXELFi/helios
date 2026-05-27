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
  const [cylField, setCylField] = useState<WaveCylField>("p");
  const [speed, setSpeed] = useState<number>(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [frameIdx, setFrameIdx] = useState(0);

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
        <header className="flex flex-shrink-0 items-center gap-3 border-b border-helios-line bg-helios-base px-4 py-2">
          <div className="min-w-0">
            <div id="wave-viewer-title" className="text-[11px] uppercase tracking-wider text-asu-gold">
              Wave viewer
            </div>
            <div className="mt-0.5 text-[10px] text-[#5A5F66]">{headerInfo}</div>
          </div>
          <div className="ml-auto" />
          <button
            type="button"
            aria-label="Close"
            className="rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5 text-[11px] text-helios-text hover:border-asu-gold"
            onClick={onClose}
          >Close ✕</button>
        </header>

        <div className="flex flex-wrap items-center gap-2 border-b border-helios-line px-4 py-2 text-[11px] text-helios-dim">
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

          <span className="mx-1 h-4 w-px self-center bg-helios-line" aria-hidden />

          {studyKind === "sweep" && sweepCapturedRpms && (
            <SelectField
              label="RPM"
              value={String(rpmInt)}
              onChange={(v) => setRpmInt(parseInt(v, 10))}
              options={sweepCapturedRpms.map((r) => ({ value: String(r), label: String(r) }))}
            />
          )}

          <SelectField
            label="field"
            value={field}
            onChange={(v) => setField(v as WaveField)}
            options={[
              { value: "p", label: "pressure" },
              { value: "u", label: "velocity" },
              { value: "T", label: "temperature" },
              { value: "rho", label: "density" },
              { value: "Mach", label: "Mach" },
            ]}
          />

          {view === "schematic" && (
            <>
              <SelectField
                label="size"
                value={sizeField}
                onChange={(v) => setSizeField(v as WaveSizeField)}
                options={[
                  { value: "p", label: "pressure" },
                  { value: "u", label: "velocity" },
                  { value: "T", label: "temperature" },
                  { value: "rho", label: "density" },
                ]}
              />
              <SelectField
                label="cyl"
                value={cylField}
                onChange={(v) => setCylField(v as WaveCylField)}
                options={[
                  { value: "x_b", label: "x_b" },
                  { value: "p", label: "pressure" },
                  { value: "T", label: "temperature" },
                ]}
              />
            </>
          )}

          <span className="ml-auto" />

          <SelectField
            label="speed"
            value={String(speed)}
            onChange={(v) => setSpeed(parseFloat(v))}
            options={SPEED_OPTIONS.map((s) => ({ value: String(s), label: `${s}×` }))}
          />

          <div className="flex items-center gap-1">
            <button
              type="button"
              className={transportBtnClass}
              onClick={() => setFrameIdx((f) => Math.max(0, f - 1))}
              aria-label="Step back"
              title="Step back one frame"
            >◀◀</button>
            <button
              type="button"
              className={
                "rounded-sm border px-2.5 py-0.5 text-[11px] cursor-pointer transition-colors " +
                (isPlaying
                  ? "border-asu-gold bg-asu-gold text-helios-base font-semibold"
                  : "border-helios-line bg-helios-panel text-helios-text hover:border-asu-gold")
              }
              onClick={() => setIsPlaying((p) => !p)}
              aria-label={isPlaying ? "Pause" : "Play"}
              title={isPlaying ? "Pause" : "Play"}
            >{isPlaying ? "⏸" : "⏵"}</button>
            <button
              type="button"
              className={transportBtnClass}
              onClick={() => setFrameIdx((f) => data ? Math.min(data.manifest.frameCount - 1, f + 1) : f)}
              aria-label="Step forward"
              title="Step forward one frame"
            >▶▶</button>
          </div>
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
              field={field}
            />
          )}
        </div>

        {state === "ready" && data && (
          <div className="flex items-center gap-3 border-t border-helios-line bg-helios-base px-4 py-2 text-[11px] text-helios-dim">
            <span className="font-mono-num tabular-nums text-helios-text">
              θ {(data.theta[frameInt] ?? 0).toFixed(0).padStart(4, " ")}°
            </span>
            <input
              type="range"
              min={0}
              max={data.manifest.frameCount - 1}
              value={frameInt}
              onChange={(e) => setFrameIdx(parseInt(e.target.value, 10))}
              className="wave-scrubber flex-1"
              aria-label="Frame scrubber"
            />
            <span className="font-mono-num tabular-nums">
              frame {(frameInt + 1).toString().padStart(4, " ")} / {data.manifest.frameCount}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function tabClass(active: boolean): string {
  // Mirrors the workspace-tab and NavRail pill language: dark panel with a
  // helios-line border at rest, asu-gold border on hover, solid gold fill +
  // black text + bold when selected. Keeps every "pick one of N" control in
  // the app reading as one family.
  return (
    "rounded-sm border px-2.5 py-0.5 text-[11px] cursor-pointer transition-colors " +
    (active
      ? "border-asu-gold bg-asu-gold text-helios-base font-semibold"
      : "border-helios-line bg-helios-panel text-helios-text hover:border-asu-gold")
  );
}

// Shared button class for the transport step-back / step-forward chrome.
// The play/pause button has its own variant because it carries the "playing"
// state and shows up filled gold while running.
const transportBtnClass =
  "rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5 text-[11px] text-helios-text " +
  "cursor-pointer transition-colors hover:border-asu-gold";

/** Tiny labeled-select. Replaces the inline `<label>...<select>...</label>`
 *  blocks scattered through the transport bar so each control reads as one
 *  pill with a consistent dim label + dark dropdown, matching Helios's
 *  workspace-tab chrome. */
function SelectField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  const { label, value, onChange, options } = props;
  return (
    <label className="flex items-center gap-1 rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5">
      <span className="text-[10px] uppercase tracking-wider text-helios-dim">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-[11px] text-helios-text outline-none [&>option]:bg-helios-panel [&>option]:text-helios-text"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function CenterText({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div className={`flex h-full items-center justify-center text-sm ${tone === "error" ? "text-red-300" : "text-helios-dim"}`}>
      {children}
    </div>
  );
}
