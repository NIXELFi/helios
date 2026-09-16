// Physics-preset picker. Shown at the top of Single-RPM + Sweep modals
// to let the user pick the Option B production knob set (or another
// preset) without manually wiring up parameter overrides. The selected
// preset's overrides are exposed via the `onChange` callback.

import { useMemo } from "react";
import { PRESETS, findPreset, type Preset } from "../lib/presets";
import type { ParameterOverride } from "../state/types";

interface Props {
  selectedId: string;
  onChange: (overrides: ParameterOverride[], preset: Preset) => void;
}

export function PresetPicker({ selectedId, onChange }: Props) {
  const selected = useMemo(() => findPreset(selectedId), [selectedId]);

  return (
    <div className="mb-3 rounded-sm border border-helios-line bg-helios-panel">
      <div className="flex items-center justify-between border-b border-helios-line px-3 py-1.5">
        <div className="text-[10px] uppercase tracking-wider text-asu-gold">
          Physics preset
        </div>
        <a
          className="text-[10px] uppercase tracking-wider text-helios-muted hover:text-asu-gold"
          href="https://github.com/anthropics/claude-code"
          onClick={(e) => e.preventDefault()}
          title="See physics_findings/SESSION_HANDOFF.md §2 in the repo"
        >
          Documented in physics_findings/
        </a>
      </div>

      <div className="px-3 py-2">
        <label htmlFor="cfd-preset" className="sr-only">Preset</label>
        <select
          id="cfd-preset"
          value={selected.id}
          onChange={(e) => {
            const p = findPreset(e.target.value);
            onChange(p.overrides, p);
          }}
          className="w-full rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-[11px] text-helios-text hover:border-asu-gold focus:border-asu-gold focus:outline-none"
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <p className="mt-2 text-[10px] text-helios-dim">{selected.tagline}</p>

        {selected.overrides.length > 0 && (
          <details className="mt-2 text-[10px]">
            <summary className="cursor-pointer text-helios-muted hover:text-asu-gold">
              {selected.overrides.length} override{selected.overrides.length > 1 ? "s" : ""} applied
              {selected.findings.length > 0 && (
                <span className="ml-2 text-helios-muted">
                  (findings: {selected.findings.join(", ")})
                </span>
              )}
            </summary>
            <table className="mt-2 w-full font-mono text-[10px]">
              <thead className="text-helios-muted">
                <tr>
                  <th className="pb-1 text-left font-normal">Path</th>
                  <th className="pb-1 text-right font-normal">Value</th>
                </tr>
              </thead>
              <tbody>
                {selected.overrides.map((o) => (
                  <tr key={o.path} className="border-t border-helios-line/40">
                    <td className="py-0.5 pr-2 text-helios-text">{o.path}</td>
                    <td className="py-0.5 text-right text-asu-gold">
                      {Number.isInteger(o.value) ? o.value.toFixed(1) : o.value.toString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[10px] text-helios-muted">{selected.description}</p>
          </details>
        )}
      </div>
    </div>
  );
}
