import { useEffect, useMemo, useState } from "react";

import { LinePlot } from "../components/charts/LinePlot";
import { PvLoopChart } from "../components/charts/PvLoopChart";
import { useCfd } from "../state/CfdContext";
import type { PvLoopArtifact } from "../state/types";

interface Props {
  jobId: string;
  studyKind: "single-rpm" | "sweep";
  rpmInt: number;
}

export function PvLoopView({ jobId, studyKind, rpmInt }: Props) {
  const { bridge } = useCfd();
  const [art, setArt] = useState<PvLoopArtifact | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cylIdx, setCylIdx] = useState<number>(0);
  const [logP, setLogP] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    setArt(null);
    setErr(null);
    bridge
      .loadCapture(jobId, studyKind, rpmInt, "pv.json")
      .then((v) => { if (!cancelled) setArt(v as PvLoopArtifact); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [bridge, jobId, studyKind, rpmInt]);

  // Samples are recorded in global-crank order. For cylinders with a
  // firing-order phase offset, local_theta wraps mid-recording — e.g. a
  // cyl with a 540° offset sees its local theta progress 540→720→0→540
  // across one global cycle. Plotting in record-order makes uPlot snap a
  // horizontal segment from (720°, peak) back to (0°, ambient) at the
  // wrap, which shows up as the spike at the right edge of p(θ)/T(θ) and
  // visually swallows part of the trace for cylinders with large offsets.
  // The chart is angle-domain (not time-domain), so re-sorting by
  // thetaLocalDeg gives the correct monotone left-to-right trace. The
  // P-V loop reads volume and pressure from the same sorted array — V is
  // a single-valued function of theta within one cycle, so the loop shape
  // is unchanged. (For 4-stroke engines V(θ) is periodic with period 720°,
  // so each θ in [0, 720) maps to one V, one direction-of-traverse.)
  const cylSamples = useMemo(() => {
    const raw = art?.cylinders[cylIdx] ?? [];
    return [...raw].sort((a, b) => a.thetaLocalDeg - b.thetaLocalDeg);
  }, [art, cylIdx]);
  const V = useMemo(() => cylSamples.map((s) => s.volume * 1e6), [cylSamples]); // cc
  const P = useMemo(() => cylSamples.map((s) => s.pressure / 1e5), [cylSamples]); // bar
  const T = useMemo(() => cylSamples.map((s) => s.temperature), [cylSamples]);
  const Xb = useMemo(() => cylSamples.map((s) => s.xB), [cylSamples]);
  const theta = useMemo(() => cylSamples.map((s) => s.thetaLocalDeg), [cylSamples]);

  if (err) return <Notice text={`Failed to load P-V: ${err}`} tone="error" />;
  if (!art) return <Notice text="Loading P-V…" tone="info" />;
  if (art.cylinders.length === 0) return <Notice text="No cylinders captured." tone="info" />;

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-[#5A5F66]">
        <span>cylinder</span>
        {art.cylinders.map((_, i) => (
          <button key={i} type="button"
            onClick={() => setCylIdx(i)}
            className={
              "rounded-sm border px-2 py-0.5 " +
              (i === cylIdx
                ? "border-[#FFC627] bg-[#FFC627]/10 text-[#FFC627]"
                : "border-[#2A2C32] text-[#9097A0] hover:border-[#FFC627]")
            }>
            {i + 1}
          </button>
        ))}
        <label className="ml-3 flex items-center gap-1 text-[11px] text-[#D8DCE2]">
          <input type="checkbox" checked={logP} onChange={(e) => setLogP(e.target.checked)} />
          log P
        </label>
        <span className="ml-2 text-[10px] text-[#5A5F66]">{cylSamples.length} samples · rpm {rpmInt}</span>
      </div>
      <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
        <div className="flex flex-col rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
          <PvLoopChart
            title={`P-V loop · cyl ${cylIdx + 1}`}
            V={V} P={P}
            vUnits="cc" pUnits={logP ? "bar (log)" : "bar"}
            logP={logP} color="#FFC627" height={260}
          />
        </div>
        <div className="flex flex-col rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
          <LinePlot
            title="p(θ) / T(θ) / x_b(θ)"
            xs={theta}
            series={[
              { label: "p (bar)", y: P, color: "#FFC627", showPoints: false },
              { label: "T (K)", y: T, color: "#F48FB1", showPoints: false, axis: "y2" },
              { label: "x_b", y: Xb, color: "#4FC3F7", showPoints: false },
            ]}
            xLabel="θ (deg)" yLabel="bar / -" y2Label="K"
            height={260}
          />
        </div>
      </div>
    </div>
  );
}

function Notice({ text, tone }: { text: string; tone: "info" | "error" }) {
  return (
    <div className={"rounded-sm border px-3 py-2 text-[11px] " + (
      tone === "error"
        ? "border-red-500/40 bg-red-500/10 text-red-200"
        : "border-[#2A2C32] bg-[#0E0E10] text-[#9097A0]"
    )}>
      {text}
    </div>
  );
}
