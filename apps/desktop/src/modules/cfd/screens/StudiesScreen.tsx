import { useState } from "react";

import { useCfd } from "../state/CfdContext";
import { ConfirmModal } from "../components/ConfirmModal";
import { OptimizationParamsModal } from "../components/optimization/OptimizationParamsModal";
import { basename } from "../lib/cfdPath";
import { parseRpmList } from "../lib/rpmList";
import type { JunctionKind, ParameterOverride, SingleRpmParams, Study, SweepParams } from "../state/types";
import { PresetPicker } from "../components/PresetPicker";
import { DEFAULT_PRESET_ID, findPreset } from "../lib/presets";

export function StudiesScreen() {
  const { state, startSingleRpm, startSweep, startOptimization, cancelStudy, deleteStudy, setActiveStudy, navigateTo } = useCfd();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [optimizationOpen, setOptimizationOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const studies = Object.values(state.studies).sort((a, b) => b.startedAt - a.startedAt);
  const noConfig = !state.loadedConfig;

  function openNewStudy() {
    setStartError(null);
    setPickerOpen(true);
  }
  function pickSingleRpm() {
    setPickerOpen(false);
    setParamsOpen(true);
  }
  function pickSweep() {
    setPickerOpen(false);
    setSweepOpen(true);
  }
  function pickOptimization() {
    setPickerOpen(false);
    setOptimizationOpen(true);
  }

  return (
    <div className="flex h-full flex-col bg-helios-base text-helios-text">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-[#2A2C32] bg-[#0E0E10] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wider text-[#FFC627]">Studies</div>
          <p className="text-[10px] text-[#5A5F66]">
            {state.loadedConfig
              ? <>Using <span className="text-[#D8DCE2]">{basename(state.loadedConfig.path)}</span></>
              : <>Open a config first.</>}
          </p>
        </div>
        <button
          type="button"
          className="rounded-sm bg-[#FFC627] px-2 py-1 text-[10px] uppercase tracking-wider text-[#0E0E10] hover:bg-yellow-300 disabled:opacity-50"
          disabled={noConfig}
          onClick={openNewStudy}
        >
          New study…
        </button>
      </header>

      {startError && (
        <div className="flex-shrink-0 border-b border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-200" role="alert">
          {startError}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {studies.length === 0 ? (
          <div className="m-8 rounded-sm border border-[#2A2C32] bg-[#0E0E10] p-8 text-center text-[11px] text-[#5A5F66]">
            No studies yet. Click "New study…" to start one.
          </div>
        ) : (
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="bg-[#0B0B0D] text-[10px] uppercase tracking-wider text-[#5A5F66]">
              <tr className="border-b border-[#2A2C32] [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-normal">
                <th>Kind</th>
                <th>Config</th>
                <th>Params</th>
                <th>Status</th>
                <th className="text-right">Cycles</th>
                <th>Started</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {studies.map((s) => <StudyRow
                key={s.id}
                study={s}
                isActive={state.activeStudyId === s.id}
                onCancel={() => cancelStudy(s.id)}
                onDelete={() => deleteStudy(s.id)}
                onView={() => { setActiveStudy(s.id); navigateTo("results"); }}
              />)}
            </tbody>
          </table>
        )}
      </div>

      <KindPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPickSingleRpm={pickSingleRpm}
        onPickSweep={pickSweep}
        onPickOptimization={pickOptimization}
      />

      {state.loadedConfig && (
        <OptimizationParamsModal
          configPath={state.loadedConfig.path}
          open={optimizationOpen}
          onClose={() => setOptimizationOpen(false)}
          onSubmit={async (params) => {
            if (!state.loadedConfig) return;
            try {
              await startOptimization(state.loadedConfig.path, params);
              setOptimizationOpen(false);
            } catch (e) {
              setStartError(e instanceof Error ? e.message : String(e));
              setOptimizationOpen(false);
            }
          }}
        />
      )}

      <SingleRpmParamsModal
        open={paramsOpen}
        defaultPath={state.loadedConfig?.path ?? ""}
        onCancel={() => setParamsOpen(false)}
        onStart={async (params) => {
          if (!state.loadedConfig) return;
          try {
            await startSingleRpm(state.loadedConfig.path, params);
            setParamsOpen(false);
          } catch (e) {
            setStartError(e instanceof Error ? e.message : String(e));
            setParamsOpen(false);
          }
        }}
      />

      <SweepParamsModal
        open={sweepOpen}
        defaultPath={state.loadedConfig?.path ?? ""}
        onCancel={() => setSweepOpen(false)}
        onStart={async (params) => {
          if (!state.loadedConfig) return;
          try {
            await startSweep(state.loadedConfig.path, params);
            setSweepOpen(false);
          } catch (e) {
            setStartError(e instanceof Error ? e.message : String(e));
            setSweepOpen(false);
          }
        }}
      />
    </div>
  );
}

function StudyRow({
  study, isActive, onCancel, onDelete, onView,
}: {
  study: Study;
  isActive: boolean;
  onCancel: () => void;
  onDelete: () => void;
  onView: () => void;
}) {
  let kindLabel: string;
  let paramsText: string;
  let progressText: string;
  if (study.kind === "single-rpm") {
    kindLabel = "Single-RPM";
    const p = study.params;
    paramsText = `${p.rpm.toFixed(0)} rpm · ${p.junctionKind} · ${p.nCyclesMax}c`;
    progressText = `${study.cycles.length} / ${p.nCyclesMax}`;
  } else if (study.kind === "sweep") {
    kindLabel = "Sweep";
    const p = study.params;
    const rpms = p.rpmList.length;
    paramsText = `${rpms} rpm · ${p.junctionKind} · ${p.nCyclesMax}c/rpm`;
    progressText = `${study.points.length} / ${rpms}`;
  } else {
    kindLabel = "Optimization";
    const p = study.params;
    paramsText = `${p.tunables.length} params · ${p.nTrials} trials · ${p.sampler}`;
    const done = study.trials.filter((t) => t.status === "done").length;
    progressText = `${done} / ${p.nTrials}`;
  }
  return (
    <tr className={"border-t border-[#16171B] " + (isActive ? "bg-[#16171B] text-[#D8DCE2]" : "text-[#9097A0] hover:bg-[#16171B]/50")}>
      <td className="px-3 py-1.5 uppercase tracking-wider text-[10px] text-[#D8DCE2]">{kindLabel}</td>
      <td className="px-3 py-1.5 text-[#9097A0]" title={study.configPath}>{basename(study.configPath)}</td>
      <td className="px-3 py-1.5 text-[#9097A0]">{paramsText}</td>
      <td className="px-3 py-1.5">
        <StatusBadge status={study.status} />
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">{progressText}</td>
      <td className="px-3 py-1.5 text-[#5A5F66]">{new Date(study.startedAt).toLocaleTimeString()}</td>
      <td className="px-3 py-1.5 text-right text-[10px] uppercase tracking-wider">
        <button type="button" className="px-1 text-[#FFC627] hover:underline" onClick={onView}>View</button>
        {study.status === "running" && (
          <button type="button" className="ml-2 px-1 text-red-300 hover:underline" onClick={onCancel}>Cancel</button>
        )}
        {study.status !== "running" && study.status !== "cancelling" && (
          <button type="button" className="ml-2 px-1 text-[#5A5F66] hover:text-[#9097A0] hover:underline" onClick={onDelete}>Delete</button>
        )}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: Study["status"] }) {
  const styles: Record<Study["status"], string> = {
    idle:        "border-[#2A2C32] text-[#5A5F66]",
    running:     "border-[#FFC627]/40 text-[#FFC627]",
    cancelling:  "border-amber-500/40 text-amber-300",
    done:        "border-green-500/40 text-green-300",
    cancelled:   "border-[#2A2C32] text-[#5A5F66]",
    error:       "border-red-500/40 text-red-300",
  };
  return (
    <span className={"rounded-sm border px-1.5 py-[1px] text-[9px] uppercase tracking-wider " + styles[status]}>
      {status}
    </span>
  );
}

function KindPicker({
  open, onClose, onPickSingleRpm, onPickSweep, onPickOptimization,
}: {
  open: boolean;
  onClose: () => void;
  onPickSingleRpm: () => void;
  onPickSweep: () => void;
  onPickOptimization: () => void;
}) {
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cfd-kind-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[min(90vw,520px)] rounded-sm border border-[#2A2C32] bg-[#0E0E10] text-[#D8DCE2] shadow-xl">
        <div className="flex items-center justify-between border-b border-[#2A2C32] px-3 py-1.5">
          <div id="cfd-kind-title" className="text-[11px] uppercase tracking-wider text-[#FFC627]">New study</div>
          <button type="button" onClick={onClose} className="text-[10px] uppercase tracking-wider text-[#5A5F66] hover:text-[#D8DCE2]">Esc</button>
        </div>
        <div className="p-3">
          <p className="text-[11px] text-[#9097A0]">Pick a study kind. More kinds are landing in later phases.</p>
          <div className="mt-3 grid grid-cols-1 gap-2">
            <button type="button" onClick={onPickSingleRpm}
              className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] p-3 text-left transition hover:border-[#FFC627]">
              <div className="text-[11px] uppercase tracking-wider text-[#D8DCE2]">Single-RPM run</div>
              <div className="mt-0.5 text-[10px] text-[#5A5F66]">Run a fixed RPM for N cycles. Phase 1.</div>
            </button>
            <button type="button" onClick={onPickSweep}
              className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] p-3 text-left transition hover:border-[#FFC627]">
              <div className="text-[11px] uppercase tracking-wider text-[#D8DCE2]">RPM sweep</div>
              <div className="mt-0.5 text-[10px] text-[#5A5F66]">Sweep RPM across a list or range; per-RPM convergence stopping.</div>
            </button>
            <button type="button" onClick={onPickOptimization}
              className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] p-3 text-left transition hover:border-[#FFC627]">
              <div className="text-[11px] uppercase tracking-wider text-[#D8DCE2]">Optimization</div>
              <div className="mt-0.5 text-[10px] text-[#5A5F66]">Search parameter space (LHS / random) to optimize an objective metric across an RPM list.</div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const INPUT_CLS = "rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none";

function CaptureCheckboxes({
  waves, pv, profiles,
  onWaves, onPv, onProfiles,
}: {
  waves: boolean; pv: boolean; profiles: boolean;
  onWaves: (b: boolean) => void;
  onPv: (b: boolean) => void;
  onProfiles: (b: boolean) => void;
}) {
  return (
    <div className="mt-3 border-t border-[#2A2C32] pt-3">
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-[#5A5F66]">Capture (disk artifacts)</div>
      <label className="flex items-center gap-2 text-[11px] text-[#D8DCE2]">
        <input type="checkbox" checked={pv} onChange={(e) => onPv(e.target.checked)} />
        <span>P-V loops + crank-angle traces</span>
      </label>
      <label className="mt-1 flex items-center gap-2 text-[11px] text-[#D8DCE2]">
        <input type="checkbox" checked={profiles} onChange={(e) => onProfiles(e.target.checked)} />
        <span>End-of-cycle pipe profiles</span>
      </label>
      <label className="mt-1 flex items-center gap-2 text-[11px] text-[#D8DCE2]">
        <input type="checkbox" checked={waves} onChange={(e) => onWaves(e.target.checked)} />
        <span>Per-step wave frames <span className="text-[#5A5F66]">(disk-heavy; ~1-2 MB/cycle)</span></span>
      </label>
    </div>
  );
}

function SingleRpmParamsModal({
  open, defaultPath, onCancel, onStart,
}: {
  open: boolean;
  defaultPath: string;
  onCancel: () => void;
  onStart: (params: SingleRpmParams) => void;
}) {
  // Matches Python convention (characteristic junction, tol=5e-3,
  // min_cycles=8). Closer to what the canonical sweep scripts use.
  const [rpm, setRpm] = useState<number>(8000);
  const [nCycles, setNCycles] = useState<number>(40);
  const [junction, setJunction] = useState<JunctionKind>("characteristic");
  const [tol, setTol] = useState<number>(5e-3);
  // Default min-cycles bumped from 8 → 30 (2026-05-23) after per-cycle
  // IMEP probe (test crates/cfd-core/tests/imep_convergence_probe.rs)
  // showed SDM26 @ 10k drifts +9% from cycle 8 → final, +2.6% from
  // cycle 20 → final, settling within 0.5% only by cycle 25-30. Classic
  // Ricardo-WAVE-style false-convergence trap if min is too low.
  const [minCycles, setMinCycles] = useState<number>(30);
  const [capPv, setCapPv] = useState<boolean>(true);
  const [capProfiles, setCapProfiles] = useState<boolean>(true);
  const [capWaves, setCapWaves] = useState<boolean>(false);
  const [presetId, setPresetId] = useState<string>(DEFAULT_PRESET_ID);
  const [overrides, setOverrides] = useState<ParameterOverride[]>(
    () => findPreset(DEFAULT_PRESET_ID).overrides,
  );

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cfd-params-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-[min(90vw,520px)] rounded-sm border border-[#2A2C32] bg-[#0E0E10] text-[#D8DCE2] shadow-xl">
        <div className="flex items-center justify-between border-b border-[#2A2C32] px-3 py-1.5">
          <div id="cfd-params-title" className="text-[11px] uppercase tracking-wider text-[#FFC627]">Single-RPM run</div>
          <span className="text-[10px] text-[#5A5F66]" title={defaultPath}>{basename(defaultPath)}</span>
        </div>
        <div className="p-3">
          <PresetPicker
            selectedId={presetId}
            onChange={(ov, p) => { setPresetId(p.id); setOverrides(ov); }}
          />
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[11px]">
            <label htmlFor="cfd-rpm" className="uppercase tracking-wider text-[#5A5F66]">RPM</label>
            <input id="cfd-rpm" type="number" min={500} max={20000} step={100}
              className={INPUT_CLS}
              value={rpm} onChange={(e) => setRpm(Number(e.target.value))} />
            <label htmlFor="cfd-ncyc" className="uppercase tracking-wider text-[#5A5F66]">Max cycles</label>
            <input id="cfd-ncyc" type="number" min={1} max={200} step={1}
              className={INPUT_CLS}
              value={nCycles} onChange={(e) => setNCycles(Number(e.target.value))} />
            <label htmlFor="cfd-junc" className="uppercase tracking-wider text-[#5A5F66]">Junction kind</label>
            <select id="cfd-junc" className={INPUT_CLS}
              value={junction} onChange={(e) => setJunction(e.target.value as JunctionKind)}>
              <option value="stagnation">Stagnation</option>
              <option value="characteristic">Characteristic</option>
            </select>
            <label htmlFor="cfd-tol" className="uppercase tracking-wider text-[#5A5F66]">Convergence tol (IMEP)</label>
            <input id="cfd-tol" type="number" min={0} max={1} step={0.0001}
              className={INPUT_CLS}
              value={tol} onChange={(e) => setTol(Number(e.target.value))} />
            <label htmlFor="cfd-min" className="uppercase tracking-wider text-[#5A5F66]">Min cycles before conv.</label>
            <input id="cfd-min" type="number" min={0} max={50} step={1}
              className={INPUT_CLS}
              value={minCycles} onChange={(e) => setMinCycles(Number(e.target.value))} />
          </div>
          <CaptureCheckboxes
            waves={capWaves} pv={capPv} profiles={capProfiles}
            onWaves={setCapWaves} onPv={setCapPv} onProfiles={setCapProfiles}
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onCancel}
              className="rounded-sm border border-[#2A2C32] bg-[#16171B] px-3 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]">
              Cancel
            </button>
            <button type="button"
              className="rounded-sm bg-[#FFC627] px-3 py-1 text-[10px] uppercase tracking-wider text-[#0E0E10] hover:bg-yellow-300"
              onClick={() => onStart({
                rpm,
                nCyclesMax: nCycles,
                junctionKind: junction,
                convergenceTolImep: tol,
                convergenceMinCycles: minCycles,
                captureWaves: capWaves,
                capturePvLoops: capPv,
                capturePipeProfiles: capProfiles,
                overrides,
              })}>
              Start
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SweepParamsModal({
  open, defaultPath, onCancel, onStart,
}: {
  open: boolean;
  defaultPath: string;
  onCancel: () => void;
  onStart: (params: SweepParams) => void;
}) {
  // Start/stop/step is the primary UX; for power users an "advanced"
  // expandable section accepts a comma-separated list / range syntax.
  // Defaults match the canonical Python sweep script
  // (audit_fixes/sweep_sdm26_export.py): 4000-15000 step 500, 40 cycles
  // max, characteristic junction, 0.005 tol, min_cycles=8.
  const [startRpm, setStartRpm] = useState<number>(4000);
  const [stopRpm, setStopRpm] = useState<number>(15000);
  const [stepRpm, setStepRpm] = useState<number>(500);
  const [useAdvanced, setUseAdvanced] = useState<boolean>(false);
  const [advancedText, setAdvancedText] = useState<string>("");

  const [nCycles, setNCycles] = useState<number>(40);
  const [junction, setJunction] = useState<JunctionKind>("characteristic");
  const [tol, setTol] = useState<number>(5e-3);
  // Default min-cycles bumped from 8 → 30 (2026-05-23) after per-cycle
  // IMEP probe (test crates/cfd-core/tests/imep_convergence_probe.rs)
  // showed SDM26 @ 10k drifts +9% from cycle 8 → final, +2.6% from
  // cycle 20 → final, settling within 0.5% only by cycle 25-30. Classic
  // Ricardo-WAVE-style false-convergence trap if min is too low.
  const [minCycles, setMinCycles] = useState<number>(30);
  const [capPv, setCapPv] = useState<boolean>(true);
  const [capProfiles, setCapProfiles] = useState<boolean>(true);
  const [capWaves, setCapWaves] = useState<boolean>(false);
  const [presetId, setPresetId] = useState<string>(DEFAULT_PRESET_ID);
  const [overrides, setOverrides] = useState<ParameterOverride[]>(
    () => findPreset(DEFAULT_PRESET_ID).overrides,
  );

  if (!open) return null;

  // Choose source of truth based on advanced toggle.
  const parsed = useAdvanced
    ? parseRpmList(advancedText)
    : parseRpmList(`${startRpm}:${stopRpm}:${stepRpm}`);
  const errMsg = parsed.ok ? null : parsed.error;
  const canStart = parsed.ok && parsed.rpms.length > 0;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cfd-sweep-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-[min(90vw,640px)] rounded-sm border border-[#2A2C32] bg-[#0E0E10] text-[#D8DCE2] shadow-xl">
        <div className="flex items-center justify-between border-b border-[#2A2C32] px-3 py-1.5">
          <div id="cfd-sweep-title" className="text-[11px] uppercase tracking-wider text-[#FFC627]">RPM sweep</div>
          <span className="text-[10px] text-[#5A5F66]" title={defaultPath}>{basename(defaultPath)}</span>
        </div>
        <div className="p-3">
          <PresetPicker
            selectedId={presetId}
            onChange={(ov, p) => { setPresetId(p.id); setOverrides(ov); }}
          />
          {!useAdvanced && (
            <>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-[#5A5F66]">RPM range</div>
              <div className="grid grid-cols-3 gap-2 text-[11px]">
                <label className="flex flex-col gap-1">
                  <span className="uppercase tracking-wider text-[#5A5F66]">Start</span>
                  <input id="cfd-sw-start" type="number" min={500} max={20000} step={100}
                    className={INPUT_CLS}
                    value={startRpm} onChange={(e) => setStartRpm(Number(e.target.value))} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="uppercase tracking-wider text-[#5A5F66]">Stop</span>
                  <input id="cfd-sw-stop" type="number" min={500} max={20000} step={100}
                    className={INPUT_CLS}
                    value={stopRpm} onChange={(e) => setStopRpm(Number(e.target.value))} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="uppercase tracking-wider text-[#5A5F66]">Step</span>
                  <input id="cfd-sw-step" type="number" min={50} max={5000} step={50}
                    className={INPUT_CLS}
                    value={stepRpm} onChange={(e) => setStepRpm(Number(e.target.value))} />
                </label>
              </div>
              <div className="mt-1 text-[10px]">
                {parsed.ok ? (
                  <span className="text-[#5A5F66]">
                    {parsed.rpms.length} rpm: {parsed.rpms.slice(0, 8).join(", ")}{parsed.rpms.length > 8 ? "…" : ""}
                  </span>
                ) : (
                  <span className="text-red-300" role="alert">{errMsg}</span>
                )}
              </div>
              <button type="button"
                className="mt-2 text-[10px] uppercase tracking-wider text-[#5A5F66] hover:text-[#FFC627]"
                onClick={() => {
                  // Seed the advanced field with the current start:stop:step
                  // when switching, so the textarea isn't empty.
                  if (!advancedText) {
                    setAdvancedText(`${startRpm}:${stopRpm}:${stepRpm}`);
                  }
                  setUseAdvanced(true);
                }}>
                Advanced — enter a custom list…
              </button>
            </>
          )}
          {useAdvanced && (
            <>
              <div className="mb-1 flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider text-[#5A5F66]">RPM list (advanced)</div>
                <button type="button"
                  className="text-[10px] uppercase tracking-wider text-[#5A5F66] hover:text-[#FFC627]"
                  onClick={() => setUseAdvanced(false)}>
                  Back to start/stop/step
                </button>
              </div>
              <textarea id="cfd-sweep-list" rows={2}
                className={INPUT_CLS + " w-full font-mono"}
                value={advancedText}
                onChange={(e) => setAdvancedText(e.target.value)}
                placeholder="comma list (4000, 6000, 8000) or range (4000:12000:1000), or mixed"
              />
              <div className="mt-1 text-[10px]">
                {parsed.ok ? (
                  <span className="text-[#5A5F66]">
                    {parsed.rpms.length} rpm: {parsed.rpms.slice(0, 8).join(", ")}{parsed.rpms.length > 8 ? "…" : ""}
                  </span>
                ) : (
                  <span className="text-red-300" role="alert">{errMsg}</span>
                )}
              </div>
            </>
          )}

          <div className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[11px]">
            <label htmlFor="cfd-sw-ncyc" className="uppercase tracking-wider text-[#5A5F66]">Max cycles per RPM</label>
            <input id="cfd-sw-ncyc" type="number" min={1} max={200} step={1}
              className={INPUT_CLS}
              value={nCycles} onChange={(e) => setNCycles(Number(e.target.value))} />
            <label htmlFor="cfd-sw-junc" className="uppercase tracking-wider text-[#5A5F66]">Junction kind</label>
            <select id="cfd-sw-junc" className={INPUT_CLS}
              value={junction} onChange={(e) => setJunction(e.target.value as JunctionKind)}>
              <option value="stagnation">Stagnation</option>
              <option value="characteristic">Characteristic</option>
            </select>
            <label htmlFor="cfd-sw-tol" className="uppercase tracking-wider text-[#5A5F66]">Convergence tol (IMEP)</label>
            <input id="cfd-sw-tol" type="number" min={0} max={1} step={0.0001}
              className={INPUT_CLS}
              value={tol} onChange={(e) => setTol(Number(e.target.value))} />
            <label htmlFor="cfd-sw-min" className="uppercase tracking-wider text-[#5A5F66]">Min cycles before conv.</label>
            <input id="cfd-sw-min" type="number" min={0} max={50} step={1}
              className={INPUT_CLS}
              value={minCycles} onChange={(e) => setMinCycles(Number(e.target.value))} />
          </div>
          <CaptureCheckboxes
            waves={capWaves} pv={capPv} profiles={capProfiles}
            onWaves={setCapWaves} onPv={setCapPv} onProfiles={setCapProfiles}
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onCancel}
              className="rounded-sm border border-[#2A2C32] bg-[#16171B] px-3 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]">
              Cancel
            </button>
            <button type="button" disabled={!canStart}
              className="rounded-sm bg-[#FFC627] px-3 py-1 text-[10px] uppercase tracking-wider text-[#0E0E10] hover:bg-yellow-300 disabled:opacity-50"
              onClick={() => {
                if (!parsed.ok) return;
                onStart({
                  rpmList: parsed.rpms,
                  nCyclesMax: nCycles,
                  junctionKind: junction,
                  convergenceTolImep: tol,
                  convergenceMinCycles: minCycles,
                  captureWaves: capWaves,
                  capturePvLoops: capPv,
                  capturePipeProfiles: capProfiles,
                  overrides,
                });
              }}>
              Start sweep
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Reuse the imported ConfirmModal for parent confirmations if needed.
export const _ConfirmModal = ConfirmModal;
