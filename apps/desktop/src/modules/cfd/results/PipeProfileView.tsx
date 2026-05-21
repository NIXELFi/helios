import { useEffect, useMemo, useState } from "react";

import { LinePlot } from "../components/charts/LinePlot";
import { useCfd } from "../state/CfdContext";
import type { PipeProfileArtifact, PipeRole } from "../state/types";

interface Props {
  jobId: string;
  studyKind: "single-rpm" | "sweep";
  rpmInt: number;
}

type Field = "p" | "u" | "t" | "rho";

const ROLE_COLOR: Record<PipeRole, string> = {
  plenum: "#4FC3F7",
  runner: "#FFC627",
  primary: "#FF8A65",
  secondary: "#CE93D8",
  collector: "#F48FB1",
};

const FIELD_META: Record<Field, { label: string; units: string; pick: (p: PipeProfileArtifact["profiles"][number]) => number[] }> = {
  p:   { label: "p (kPa)",      units: "kPa",      pick: (p) => p.p.map((v) => v / 1000) },
  u:   { label: "u (m/s)",      units: "m/s",      pick: (p) => p.u },
  t:   { label: "T (K)",        units: "K",        pick: (p) => p.t },
  rho: { label: "ρ (kg/m³)",    units: "kg/m³",    pick: (p) => p.rho },
};

export function PipeProfileView({ jobId, studyKind, rpmInt }: Props) {
  const { bridge } = useCfd();
  const [art, setArt] = useState<PipeProfileArtifact | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [field, setField] = useState<Field>("p");

  useEffect(() => {
    let cancelled = false;
    setArt(null);
    setErr(null);
    bridge
      .loadCapture(jobId, studyKind, rpmInt, "profiles.json")
      .then((v) => { if (!cancelled) setArt(v as PipeProfileArtifact); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [bridge, jobId, studyKind, rpmInt]);

  const meta = FIELD_META[field];
  const profiles = useMemo(() => art?.profiles ?? [], [art]);

  if (err) return <Notice text={`Failed to load profiles: ${err}`} tone="error" />;
  if (!art) return <Notice text="Loading profiles…" tone="info" />;
  if (profiles.length === 0) return <Notice text="No profiles captured." tone="info" />;

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-[#5A5F66]">
        <span>field</span>
        {(Object.keys(FIELD_META) as Field[]).map((f) => (
          <button key={f} type="button"
            onClick={() => setField(f)}
            className={
              "rounded-sm border px-2 py-0.5 " +
              (f === field
                ? "border-[#FFC627] bg-[#FFC627]/10 text-[#FFC627]"
                : "border-[#2A2C32] text-[#9097A0] hover:border-[#FFC627]")
            }>
            {FIELD_META[f].label}
          </button>
        ))}
        <span className="ml-3 text-[10px] text-[#5A5F66]">{profiles.length} pipes · rpm {rpmInt}</span>
      </div>
      <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
        {profiles.map((pr) => {
          const xs_mm = pr.xM.map((m) => m * 1000);
          const ys = meta.pick(pr);
          const color = ROLE_COLOR[pr.role];
          return (
            <div key={pr.label} className="flex flex-col rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <LinePlot
                title={`${pr.label} · ${pr.role} · L=${(pr.lengthM * 1000).toFixed(0)} mm`}
                xs={xs_mm}
                series={[{ label: meta.label, y: ys, color, showPoints: false }]}
                xLabel="x (mm)" yLabel={meta.units}
                height={200}
              />
            </div>
          );
        })}
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
