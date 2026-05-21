import { useState } from "react";

import { useCfd } from "../state/CfdContext";
import { ConfirmModal } from "../components/ConfirmModal";
import { basename } from "../lib/cfdPath";
import type { JunctionKind, SingleRpmParams, Study } from "../state/types";

export function StudiesScreen() {
  const { state, startSingleRpm, cancelStudy, deleteStudy, setActiveStudy, navigateTo } = useCfd();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
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

  return (
    <div className="flex h-full flex-col bg-[#0B0B0D] text-[#D8DCE2]">
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
      />

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
  const params = study.params;
  const cycles = study.kind === "single-rpm" ? study.cycles.length : 0;
  const total = params.nCyclesMax;
  return (
    <tr className={"border-t border-[#16171B] " + (isActive ? "bg-[#16171B] text-[#D8DCE2]" : "text-[#9097A0] hover:bg-[#16171B]/50")}>
      <td className="px-3 py-1.5 uppercase tracking-wider text-[10px] text-[#D8DCE2]">Single-RPM</td>
      <td className="px-3 py-1.5 text-[#9097A0]" title={study.configPath}>{basename(study.configPath)}</td>
      <td className="px-3 py-1.5 text-[#9097A0]">
        {`${params.rpm.toFixed(0)} rpm · ${params.junctionKind} · ${params.nCyclesMax}c`}
      </td>
      <td className="px-3 py-1.5">
        <StatusBadge status={study.status} />
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">
        {cycles} / {total}
      </td>
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
  open, onClose, onPickSingleRpm,
}: {
  open: boolean;
  onClose: () => void;
  onPickSingleRpm: () => void;
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
            <button type="button" disabled
              title="Coming in Phase 3"
              className="cursor-not-allowed rounded-sm border border-[#2A2C32] bg-[#0B0B0D] p-3 text-left opacity-50">
              <div className="text-[11px] uppercase tracking-wider text-[#D8DCE2]">RPM sweep <span className="ml-1 normal-case text-[#5A5F66]">(Phase 3)</span></div>
              <div className="mt-0.5 text-[10px] text-[#5A5F66]">Sweep RPM across a range with convergence stopping.</div>
            </button>
            <button type="button" disabled
              title="Coming in Phase 5"
              className="cursor-not-allowed rounded-sm border border-[#2A2C32] bg-[#0B0B0D] p-3 text-left opacity-50">
              <div className="text-[11px] uppercase tracking-wider text-[#D8DCE2]">Optimization <span className="ml-1 normal-case text-[#5A5F66]">(Phase 5)</span></div>
              <div className="mt-0.5 text-[10px] text-[#5A5F66]">Search parameter space to optimize an objective.</div>
            </button>
          </div>
        </div>
      </div>
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
  const [rpm, setRpm] = useState<number>(6000);
  const [nCycles, setNCycles] = useState<number>(25);
  const [junction, setJunction] = useState<JunctionKind>("stagnation");
  const [tol, setTol] = useState<number>(1e-3);
  const [minCycles, setMinCycles] = useState<number>(5);

  if (!open) return null;
  const inputCls = "rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none";
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
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[11px]">
            <label htmlFor="cfd-rpm" className="uppercase tracking-wider text-[#5A5F66]">RPM</label>
            <input id="cfd-rpm" type="number" min={500} max={20000} step={100}
              className={inputCls}
              value={rpm} onChange={(e) => setRpm(Number(e.target.value))} />
            <label htmlFor="cfd-ncyc" className="uppercase tracking-wider text-[#5A5F66]">Max cycles</label>
            <input id="cfd-ncyc" type="number" min={1} max={200} step={1}
              className={inputCls}
              value={nCycles} onChange={(e) => setNCycles(Number(e.target.value))} />
            <label htmlFor="cfd-junc" className="uppercase tracking-wider text-[#5A5F66]">Junction kind</label>
            <select id="cfd-junc" className={inputCls}
              value={junction} onChange={(e) => setJunction(e.target.value as JunctionKind)}>
              <option value="stagnation">Stagnation</option>
              <option value="characteristic">Characteristic</option>
            </select>
            <label htmlFor="cfd-tol" className="uppercase tracking-wider text-[#5A5F66]">Convergence tol (IMEP)</label>
            <input id="cfd-tol" type="number" min={0} max={1} step={0.0001}
              className={inputCls}
              value={tol} onChange={(e) => setTol(Number(e.target.value))} />
            <label htmlFor="cfd-min" className="uppercase tracking-wider text-[#5A5F66]">Min cycles before conv.</label>
            <input id="cfd-min" type="number" min={0} max={50} step={1}
              className={inputCls}
              value={minCycles} onChange={(e) => setMinCycles(Number(e.target.value))} />
          </div>
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
              })}>
              Start
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Reuse the imported ConfirmModal for parent confirmations if needed.
export const _ConfirmModal = ConfirmModal;
