// One row in the optimization parameter table. Holds enable + min/max/step
// + per-element scope for array-kind parameters. Pure presentation; the
// panel owns the bounds[] state and passes onChange.

import type { ParameterBoundsUI, ParameterMeta } from "../../state/types";

interface Props {
  meta: ParameterMeta;
  bounds: ParameterBoundsUI;
  onChange: (next: ParameterBoundsUI) => void;
}

const NUM_INPUT_CLS =
  "w-24 rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-1.5 py-0.5 text-right font-mono text-[11px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none disabled:opacity-40";

const SELECT_CLS =
  "rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-1.5 py-0.5 font-mono text-[10px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none disabled:opacity-40";

export function ParameterRow({ meta, bounds, onChange }: Props) {
  const setField = <K extends keyof ParameterBoundsUI>(
    k: K,
    v: ParameterBoundsUI[K],
  ) => onChange({ ...bounds, [k]: v });

  const dimmed = bounds.enabled ? "" : "opacity-60";

  return (
    <tr className={"border-t border-[#16171B] " + dimmed}>
      <td className="px-2 py-1">
        <input
          type="checkbox"
          checked={bounds.enabled}
          onChange={(e) => setField("enabled", e.target.checked)}
          aria-label={`Enable ${meta.path} as tunable`}
        />
      </td>
      <td className="px-2 py-1 font-mono text-[11px] text-[#D8DCE2]">
        {meta.path}
        {meta.kind === "array" && bounds.perElement !== null && (
          <span className="ml-1 text-[#5A5F66]">[{bounds.perElement}]</span>
        )}
      </td>
      <td className="px-2 py-1 font-mono text-[10px] text-[#5A5F66]">{meta.unit}</td>
      <td className="px-2 py-1 text-right font-mono text-[10px] text-[#5A5F66]">
        {Number.isFinite(meta.default) ? meta.default.toPrecision(4) : "—"}
      </td>
      <td className="px-2 py-1">
        <NumberInput
          value={bounds.min}
          disabled={!bounds.enabled}
          onChange={(v) => setField("min", v)}
          aria-label={`${meta.path} min`}
        />
      </td>
      <td className="px-2 py-1">
        <NumberInput
          value={bounds.max}
          disabled={!bounds.enabled}
          onChange={(v) => setField("max", v)}
          aria-label={`${meta.path} max`}
        />
      </td>
      <td className="px-2 py-1">
        <NumberInput
          value={bounds.step ?? 0}
          disabled={!bounds.enabled}
          placeholder="cont."
          onChange={(v) => setField("step", v > 0 ? v : null)}
          aria-label={`${meta.path} step`}
        />
      </td>
      <td className="px-2 py-1">
        {meta.kind === "array" ? (
          <select
            value={bounds.perElement === null ? "uniform" : String(bounds.perElement)}
            disabled={!bounds.enabled}
            onChange={(e) =>
              setField(
                "perElement",
                e.target.value === "uniform" ? null : Number(e.target.value),
              )
            }
            className={SELECT_CLS}
            aria-label={`${meta.path} scope`}
          >
            <option value="uniform">uniform</option>
            {Array.from({ length: meta.arrayLen }, (_, i) => (
              <option key={i} value={i}>
                cyl {i}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[10px] text-[#5A5F66]">scalar</span>
        )}
      </td>
    </tr>
  );
}

interface NumberInputProps {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  placeholder?: string;
  "aria-label"?: string;
}

function NumberInput({
  value,
  onChange,
  disabled,
  placeholder,
  ...rest
}: NumberInputProps) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : ""}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      step="any"
      className={NUM_INPUT_CLS}
      aria-label={rest["aria-label"]}
    />
  );
}
