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
    <div className="mb-3 rounded-sm border border-[#2A2C32] bg-[#16171B]">
      <div className="flex items-center justify-between border-b border-[#2A2C32] px-3 py-1.5">
        <div className="text-[10px] uppercase tracking-wider text-[#FFC627]">
          Physics preset
        </div>
        <a
          className="text-[10px] uppercase tracking-wider text-[#5A5F66] hover:text-[#FFC627]"
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
          className="w-full rounded-sm border border-[#2A2C32] bg-[#0E0E10] px-2 py-1 text-[11px] text-[#D8DCE2] hover:border-[#FFC627] focus:border-[#FFC627] focus:outline-none"
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <p className="mt-2 text-[10px] text-[#9097A0]">{selected.tagline}</p>

        {selected.overrides.length > 0 && (
          <details className="mt-2 text-[10px]">
            <summary className="cursor-pointer text-[#5A5F66] hover:text-[#FFC627]">
              {selected.overrides.length} override{selected.overrides.length > 1 ? "s" : ""} applied
              {selected.findings.length > 0 && (
                <span className="ml-2 text-[#5A5F66]">
                  (findings: {selected.findings.join(", ")})
                </span>
              )}
            </summary>
            <table className="mt-2 w-full font-mono text-[10px]">
              <thead className="text-[#5A5F66]">
                <tr>
                  <th className="pb-1 text-left font-normal">Path</th>
                  <th className="pb-1 text-right font-normal">Value</th>
                </tr>
              </thead>
              <tbody>
                {selected.overrides.map((o) => (
                  <tr key={o.path} className="border-t border-[#2A2C32]/40">
                    <td className="py-0.5 pr-2 text-[#D8DCE2]">{o.path}</td>
                    <td className="py-0.5 text-right text-[#FFC627]">
                      {Number.isInteger(o.value) ? o.value.toFixed(1) : o.value.toString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[10px] text-[#5A5F66]">{selected.description}</p>
          </details>
        )}
      </div>
    </div>
  );
}
