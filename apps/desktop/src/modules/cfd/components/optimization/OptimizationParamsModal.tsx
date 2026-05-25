// Three-section vertical modal: parameters, objective, sampling.
// Validation rolls up from each section; the Start button reports the
// first three errors so the user can fix them in order.

import { useMemo, useState } from "react";

import type {
  JunctionKind,
  LockedPair,
  ObjectiveSpec,
  OptimizationParams,
  ParameterBounds,
  ParameterBoundsUI,
  SamplerKind,
} from "../../state/types";
import { parseRpmList } from "../../lib/rpmList";
import { followerOf, withPerElement } from "../../lib/lockedPairs";
import { useParameterSchema } from "../../lib/useParameterSchema";
import { ParameterPanel } from "./ParameterPanel";
import { ObjectiveBuilder } from "./ObjectiveBuilder";

interface Props {
  configPath: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (params: OptimizationParams) => void;
}

const INPUT_CLS =
  "rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none";

export function OptimizationParamsModal({
  configPath,
  open,
  onClose,
  onSubmit,
}: Props) {
  const { schema, loading, error } = useParameterSchema(open ? configPath : null);
  const [bounds, setBounds] = useState<ParameterBoundsUI[]>([]);
  const [objective, setObjective] = useState<ObjectiveSpec>({
    metric: "imep_bar",
    aggregator: { kind: "max" },
    rpmList: [6000, 8000, 10000],
    direction: "maximize",
  });
  const [rpmListText, setRpmListText] = useState("6000:10000:2000");
  const [nTrials, setNTrials] = useState(32);
  const [sampler, setSampler] = useState<SamplerKind>("lhs");
  const [seedText, setSeedText] = useState("");
  const [nCyclesMax, setNCyclesMax] = useState(8);
  const [junction, setJunction] = useState<JunctionKind>("characteristic");
  const [tol, setTol] = useState<number>(5e-3);
  const [minCycles, setMinCycles] = useState<number>(3);

  const rpmParse = useMemo(() => parseRpmList(rpmListText), [rpmListText]);

  if (!open) return null;

  const enabled = bounds.filter((b) => b.enabled);
  const validationErrors: string[] = [];
  if (enabled.length === 0) {
    validationErrors.push("Enable at least 1 tunable parameter.");
  }
  for (const b of enabled) {
    if (!(b.min < b.max)) {
      validationErrors.push(`${b.path}: min must be < max.`);
    }
  }
  if (!rpmParse.ok) {
    validationErrors.push(`RPM list: ${rpmParse.error}`);
  }
  if (
    rpmParse.ok &&
    objective.aggregator.kind === "at-rpm" &&
    !rpmParse.rpms.includes(objective.aggregator.rpmInt)
  ) {
    validationErrors.push(
      `Objective RPM (${objective.aggregator.rpmInt}) not in RPM list.`,
    );
  }
  if (!Number.isInteger(nTrials) || nTrials < 2 || nTrials > 500) {
    validationErrors.push("nTrials must be an integer in [2, 500].");
  }

  function submit() {
    if (validationErrors.length > 0) return;
    if (!rpmParse.ok) return;
    const tunables: ParameterBounds[] = enabled.map((b) => ({
      path: withPerElement(b.path, b.perElement),
      min: b.min,
      max: b.max,
      step: b.step,
    }));
    // Emit lockedPairs for every enabled leader row that has the lock
    // toggle on. The follower path mirrors the leader's perElement so
    // per-cyl locks stay coherent across the in/out pair.
    const lockedPairs: LockedPair[] = [];
    for (const b of enabled) {
      if (!b.lockToFollower) continue;
      const followerBase = followerOf(b.path);
      if (!followerBase) continue;
      lockedPairs.push({
        leader: withPerElement(b.path, b.perElement),
        follower: withPerElement(followerBase, b.perElement),
      });
    }
    const seedTrim = seedText.trim();
    const params: OptimizationParams = {
      tunables,
      objective: { ...objective, rpmList: rpmParse.rpms },
      nTrials,
      sampler,
      seed: seedTrim === "" ? null : Number(seedTrim),
      nCyclesMax,
      junctionKind: junction,
      convergenceTolImep: tol,
      convergenceMinCycles: minCycles,
      lockedPairs,
    };
    onSubmit(params);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cfd-opt-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-[min(95vw,1100px)] flex-col rounded-sm border border-[#2A2C32] bg-[#0E0E10] text-[#D8DCE2] shadow-xl">
        <header className="flex flex-shrink-0 items-center justify-between border-b border-[#2A2C32] px-3 py-1.5">
          <div id="cfd-opt-title" className="text-[11px] uppercase tracking-wider text-[#FFC627]">
            New optimization
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[10px] uppercase tracking-wider text-[#5A5F66] hover:text-[#D8DCE2]"
          >
            Esc
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-3">
          <section className="mb-5">
            <h3 className="mb-2 text-[10px] uppercase tracking-wider text-[#5A5F66]">
              1. Parameters
            </h3>
            {loading && (
              <p className="text-[11px] text-[#5A5F66]">Loading schema…</p>
            )}
            {error && (
              <p className="text-[11px] text-red-300" role="alert">{error}</p>
            )}
            {schema && (
              <ParameterPanel schema={schema} bounds={bounds} onChange={setBounds} />
            )}
          </section>

          <section className="mb-5">
            <h3 className="mb-2 text-[10px] uppercase tracking-wider text-[#5A5F66]">
              2. Objective
            </h3>
            <ObjectiveBuilder
              value={objective}
              rpmListText={rpmListText}
              onRpmListTextChange={setRpmListText}
              onChange={setObjective}
            />
          </section>

          <section className="mb-2">
            <h3 className="mb-2 text-[10px] uppercase tracking-wider text-[#5A5F66]">
              3. Sampling
            </h3>
            <div className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-x-3 gap-y-2 text-[11px]">
              <label htmlFor="opt-ntrials" className="uppercase tracking-wider text-[10px] text-[#5A5F66]">
                Trials
              </label>
              <input
                id="opt-ntrials"
                type="number"
                min={2}
                max={500}
                step={1}
                value={nTrials}
                onChange={(e) => setNTrials(Number(e.target.value))}
                className={INPUT_CLS + " w-24"}
              />
              <label htmlFor="opt-sampler" className="uppercase tracking-wider text-[10px] text-[#5A5F66]">
                Sampler
              </label>
              <select
                id="opt-sampler"
                value={sampler}
                onChange={(e) => setSampler(e.target.value as SamplerKind)}
                className={INPUT_CLS + " w-32"}
              >
                <option value="lhs">Latin hypercube</option>
                <option value="random">Uniform random</option>
              </select>

              <label htmlFor="opt-seed" className="uppercase tracking-wider text-[10px] text-[#5A5F66]">
                Seed
              </label>
              <input
                id="opt-seed"
                type="text"
                placeholder="random"
                value={seedText}
                onChange={(e) => setSeedText(e.target.value)}
                className={INPUT_CLS + " w-24"}
              />
              <label htmlFor="opt-ncyc" className="uppercase tracking-wider text-[10px] text-[#5A5F66]">
                Max cycles per RPM
              </label>
              <input
                id="opt-ncyc"
                type="number"
                min={1}
                max={50}
                step={1}
                value={nCyclesMax}
                onChange={(e) => setNCyclesMax(Number(e.target.value))}
                className={INPUT_CLS + " w-24"}
              />

              <label htmlFor="opt-junc" className="uppercase tracking-wider text-[10px] text-[#5A5F66]">
                Junction kind
              </label>
              <select
                id="opt-junc"
                value={junction}
                onChange={(e) => setJunction(e.target.value as JunctionKind)}
                className={INPUT_CLS + " w-32"}
              >
                <option value="stagnation">Stagnation</option>
                <option value="characteristic">Characteristic</option>
              </select>
              <label htmlFor="opt-tol" className="uppercase tracking-wider text-[10px] text-[#5A5F66]">
                Convergence tol (IMEP)
              </label>
              <input
                id="opt-tol"
                type="number"
                min={0}
                max={1}
                step={0.0001}
                value={tol}
                onChange={(e) => setTol(Number(e.target.value))}
                className={INPUT_CLS + " w-24"}
              />

              <label htmlFor="opt-minc" className="uppercase tracking-wider text-[10px] text-[#5A5F66]">
                Min cycles before conv.
              </label>
              <input
                id="opt-minc"
                type="number"
                min={0}
                max={50}
                step={1}
                value={minCycles}
                onChange={(e) => setMinCycles(Number(e.target.value))}
                className={INPUT_CLS + " w-24"}
              />
              <span />
              <span />
            </div>
          </section>
        </div>

        <footer className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-[#2A2C32] px-3 py-2">
          <ul className="ml-3 list-disc text-[10px] text-red-300">
            {validationErrors.slice(0, 3).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm border border-[#2A2C32] bg-[#16171B] px-3 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={validationErrors.length > 0}
              className="rounded-sm bg-[#FFC627] px-3 py-1 text-[10px] uppercase tracking-wider text-[#0E0E10] hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Start optimization
              {rpmParse.ok &&
                ` (${enabled.length}p × ${nTrials}t × ${rpmParse.rpms.length}rpm)`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
