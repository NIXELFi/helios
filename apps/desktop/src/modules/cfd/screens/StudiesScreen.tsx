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
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-helios-line bg-helios-base px-4 py-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-helios-text">Studies</h1>
          <p className="text-xs text-helios-dim">
            {state.loadedConfig
              ? <>Using <span className="text-helios-text">{basename(state.loadedConfig.path)}</span></>
              : <>Open a config first.</>}
          </p>
        </div>
        <button
          type="button"
          className="rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-helios-base hover:bg-yellow-300 disabled:opacity-50"
          disabled={noConfig}
          onClick={openNewStudy}
        >
          New study…
        </button>
      </header>

      {startError && (
        <div className="border-b border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200" role="alert">
          {startError}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {studies.length === 0 ? (
          <div className="m-8 rounded border border-helios-line bg-helios-panel p-8 text-center text-sm text-helios-dim">
            No studies yet. Click "New study…" to start one.
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-helios-line text-xs uppercase text-helios-dim">
              <tr>
                <th className="px-4 py-2">Kind</th>
                <th className="px-4 py-2">Config</th>
                <th className="px-4 py-2">Params</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Cycles</th>
                <th className="px-4 py-2">Started</th>
                <th className="px-4 py-2 text-right">Actions</th>
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
    <tr className={"border-t border-helios-line " + (isActive ? "bg-helios-line/30" : "hover:bg-helios-panel/50")}>
      <td className="px-4 py-2 text-helios-text">Single-RPM</td>
      <td className="px-4 py-2 text-helios-dim" title={study.configPath}>{basename(study.configPath)}</td>
      <td className="px-4 py-2 text-helios-dim">
        {`${params.rpm.toFixed(0)} rpm · ${params.junctionKind} · ${params.nCyclesMax}c`}
      </td>
      <td className="px-4 py-2">
        <StatusBadge status={study.status} />
      </td>
      <td className="px-4 py-2 text-right tabular-nums">
        {cycles} / {total}
      </td>
      <td className="px-4 py-2 text-helios-dim">{new Date(study.startedAt).toLocaleTimeString()}</td>
      <td className="px-4 py-2 text-right">
        <button type="button" className="px-2 text-sm text-asu-gold hover:underline" onClick={onView}>View</button>
        {study.status === "running" && (
          <button type="button" className="ml-2 px-2 text-sm text-red-300 hover:underline" onClick={onCancel}>Cancel</button>
        )}
        {study.status !== "running" && study.status !== "cancelling" && (
          <button type="button" className="ml-2 px-2 text-sm text-helios-dim hover:underline" onClick={onDelete}>Delete</button>
        )}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: Study["status"] }) {
  const colors: Record<Study["status"], string> = {
    idle:        "bg-helios-line text-helios-dim",
    running:     "bg-asu-gold/20 text-asu-gold",
    cancelling:  "bg-amber-500/20 text-amber-300",
    done:        "bg-green-500/20 text-green-300",
    cancelled:   "bg-helios-line text-helios-dim",
    error:       "bg-red-500/20 text-red-300",
  };
  return <span className={"rounded px-1.5 py-0.5 text-xs font-medium " + colors[status]}>{status}</span>;
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[min(90vw,520px)] rounded-md border border-helios-line bg-helios-panel p-5 text-helios-text shadow-xl">
        <h2 id="cfd-kind-title" className="text-base font-semibold">New study</h2>
        <p className="mt-1 text-sm text-helios-dim">Pick a study kind. More kinds are landing in later phases.</p>
        <div className="mt-4 grid grid-cols-1 gap-2">
          <button type="button" onClick={onPickSingleRpm}
            className="rounded border border-helios-line bg-helios-base p-3 text-left hover:border-asu-gold">
            <div className="font-medium">Single-RPM run</div>
            <div className="text-xs text-helios-dim">Run a fixed RPM for N cycles. Phase 1.</div>
          </button>
          <button type="button" disabled
            title="Coming in Phase 3"
            className="cursor-not-allowed rounded border border-helios-line bg-helios-base p-3 text-left opacity-50">
            <div className="font-medium">RPM sweep <span className="ml-2 text-xs text-helios-dim">(Phase 3)</span></div>
            <div className="text-xs text-helios-dim">Sweep RPM across a range with convergence stopping.</div>
          </button>
          <button type="button" disabled
            title="Coming in Phase 5"
            className="cursor-not-allowed rounded border border-helios-line bg-helios-base p-3 text-left opacity-50">
            <div className="font-medium">Optimization study <span className="ml-2 text-xs text-helios-dim">(Phase 5)</span></div>
            <div className="text-xs text-helios-dim">Search parameter space to optimize an objective.</div>
          </button>
        </div>
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose}
            className="rounded border border-helios-line bg-helios-base px-3 py-1.5 text-sm hover:bg-helios-line">
            Cancel
          </button>
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
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cfd-params-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-[min(90vw,520px)] rounded-md border border-helios-line bg-helios-panel p-5 text-helios-text shadow-xl">
        <h2 id="cfd-params-title" className="text-base font-semibold">Single-RPM run</h2>
        <p className="mt-1 text-xs text-helios-dim" title={defaultPath}>Config: {basename(defaultPath)}</p>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <label className="contents">
            <span className="text-helios-dim self-center">RPM</span>
            <input type="number" min={500} max={20000} step={100}
              className="rounded border border-helios-line bg-helios-base px-2 py-1"
              value={rpm} onChange={(e) => setRpm(Number(e.target.value))} />
          </label>
          <label className="contents">
            <span className="text-helios-dim self-center">Max cycles</span>
            <input type="number" min={1} max={200} step={1}
              className="rounded border border-helios-line bg-helios-base px-2 py-1"
              value={nCycles} onChange={(e) => setNCycles(Number(e.target.value))} />
          </label>
          <label className="contents">
            <span className="text-helios-dim self-center">Junction kind</span>
            <select className="rounded border border-helios-line bg-helios-base px-2 py-1"
              value={junction} onChange={(e) => setJunction(e.target.value as JunctionKind)}>
              <option value="stagnation">Stagnation</option>
              <option value="characteristic">Characteristic</option>
            </select>
          </label>
          <label className="contents">
            <span className="text-helios-dim self-center">Convergence tol (IMEP)</span>
            <input type="number" min={0} max={1} step={0.0001}
              className="rounded border border-helios-line bg-helios-base px-2 py-1"
              value={tol} onChange={(e) => setTol(Number(e.target.value))} />
          </label>
          <label className="contents">
            <span className="text-helios-dim self-center">Min cycles before convergence</span>
            <input type="number" min={0} max={50} step={1}
              className="rounded border border-helios-line bg-helios-base px-2 py-1"
              value={minCycles} onChange={(e) => setMinCycles(Number(e.target.value))} />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel}
            className="rounded border border-helios-line bg-helios-base px-3 py-1.5 text-sm hover:bg-helios-line">
            Cancel
          </button>
          <button type="button"
            className="rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-helios-base hover:bg-yellow-300"
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
  );
}

// Reuse the imported ConfirmModal for parent confirmations if needed.
export const _ConfirmModal = ConfirmModal;
