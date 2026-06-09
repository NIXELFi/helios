// RPM-sweep setup modal. Extracted from StudiesScreen so it can be opened from
// two places: the Studies screen ("New study → Sweep") and the optimization
// results screen ("Run sweep with this recipe"). When `seedOverrides` is given,
// the modal sweeps that fixed parameter recipe (e.g. an optimization trial's
// geometry) across RPM instead of a named preset — the preset picker is hidden
// and a banner names the source.

import { useState } from "react";

import { PresetPicker } from "./PresetPicker";
import { parseRpmList } from "../lib/rpmList";
import { basename } from "../lib/cfdPath";
import { DEFAULT_PRESET_ID, findPreset } from "../lib/presets";
import type { JunctionKind, ParameterOverride, SweepParams } from "../state/types";

export const INPUT_CLS =
  "rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none";

export function CaptureCheckboxes({
  waves, pv, profiles, onWaves, onPv, onProfiles,
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

export function SweepParamsModal({
  open, defaultPath, seedOverrides, seedLabel, onCancel, onStart,
}: {
  open: boolean;
  defaultPath: string;
  /** When set, sweep this fixed recipe (overrides) instead of a preset. */
  seedOverrides?: ParameterOverride[];
  /** Human label for the recipe banner (e.g. "trial #87"). */
  seedLabel?: string;
  onCancel: () => void;
  onStart: (params: SweepParams) => void;
}) {
  const seeded = seedOverrides != null;
  // Defaults match the canonical Python sweep script: 4000-15000 step 500,
  // 40 cycles max, characteristic junction, 0.005 tol, min_cycles=30.
  const [startRpm, setStartRpm] = useState<number>(4000);
  const [stopRpm, setStopRpm] = useState<number>(15000);
  const [stepRpm, setStepRpm] = useState<number>(500);
  const [useAdvanced, setUseAdvanced] = useState<boolean>(false);
  const [advancedText, setAdvancedText] = useState<string>("");

  const [nCycles, setNCycles] = useState<number>(40);
  const [junction, setJunction] = useState<JunctionKind>("characteristic");
  const [tol, setTol] = useState<number>(5e-3);
  const [minCycles, setMinCycles] = useState<number>(30);
  const [capPv, setCapPv] = useState<boolean>(true);
  const [capProfiles, setCapProfiles] = useState<boolean>(true);
  const [capWaves, setCapWaves] = useState<boolean>(false);
  const [presetId, setPresetId] = useState<string>(DEFAULT_PRESET_ID);
  // Seeded → fixed recipe overrides; otherwise the preset picker drives them.
  const [overrides, setOverrides] = useState<ParameterOverride[]>(
    () => seedOverrides ?? findPreset(DEFAULT_PRESET_ID).overrides,
  );

  if (!open) return null;

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
          <div id="cfd-sweep-title" className="text-[11px] uppercase tracking-wider text-[#FFC627]">
            {seeded ? "Sweep from recipe" : "RPM sweep"}
          </div>
          <span className="text-[10px] text-[#5A5F66]" title={defaultPath}>{basename(defaultPath)}</span>
        </div>
        <div className="p-3">
          {seeded ? (
            <div className="mb-3 rounded-sm border border-[#FFC627]/40 bg-[#FFC627]/5 px-2 py-1.5 text-[10px]">
              <span className="uppercase tracking-wider text-[#FFC627]">Recipe</span>
              <span className="ml-2 text-[#9097A0]">
                {seedLabel ? seedLabel + " — " : ""}{overrides.length} parameter override{overrides.length === 1 ? "" : "s"} applied to every RPM
              </span>
              <div className="mt-1 flex flex-wrap gap-1 font-mono text-[9px] text-[#5A5F66]">
                {overrides.map((o) => (
                  <span key={o.path} className="rounded-sm border border-[#2A2C32] px-1 py-[1px]">
                    {o.path}={o.value.toPrecision(4)}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <PresetPicker
              selectedId={presetId}
              onChange={(ov, p) => { setPresetId(p.id); setOverrides(ov); }}
            />
          )}
          {!useAdvanced && (
            <>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-[#5A5F66]">RPM range</div>
              <div className="grid grid-cols-3 gap-2 text-[11px]">
                <label className="flex flex-col gap-1">
                  <span className="uppercase tracking-wider text-[#5A5F66]">Start</span>
                  <input type="number" min={500} max={20000} step={100} className={INPUT_CLS}
                    value={startRpm} onChange={(e) => setStartRpm(Number(e.target.value))} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="uppercase tracking-wider text-[#5A5F66]">Stop</span>
                  <input type="number" min={500} max={20000} step={100} className={INPUT_CLS}
                    value={stopRpm} onChange={(e) => setStopRpm(Number(e.target.value))} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="uppercase tracking-wider text-[#5A5F66]">Step</span>
                  <input type="number" min={50} max={5000} step={50} className={INPUT_CLS}
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
                  if (!advancedText) setAdvancedText(`${startRpm}:${stopRpm}:${stepRpm}`);
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
              <textarea rows={2} className={INPUT_CLS + " w-full font-mono"}
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
            <label className="uppercase tracking-wider text-[#5A5F66]">Max cycles per RPM</label>
            <input type="number" min={1} max={200} step={1} className={INPUT_CLS}
              value={nCycles} onChange={(e) => setNCycles(Number(e.target.value))} />
            <label className="uppercase tracking-wider text-[#5A5F66]">Junction kind</label>
            <select className={INPUT_CLS}
              value={junction} onChange={(e) => setJunction(e.target.value as JunctionKind)}>
              <option value="stagnation">Stagnation</option>
              <option value="characteristic">Characteristic</option>
            </select>
            <label className="uppercase tracking-wider text-[#5A5F66]">Convergence tol (IMEP)</label>
            <input type="number" min={0} max={1} step={0.0001} className={INPUT_CLS}
              value={tol} onChange={(e) => setTol(Number(e.target.value))} />
            <label className="uppercase tracking-wider text-[#5A5F66]">Min cycles before conv.</label>
            <input type="number" min={0} max={50} step={1} className={INPUT_CLS}
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
