// N-slot firing-order reorder using up/down arrows. Drag-to-reorder
// is a later polish item; this ships the validated mutation surface.

import { validateFiringOrder } from "../validation/client-rules";

interface Props {
  value: number[];
  nCylinders: number;
  onChange: (next: number[]) => void;
}

export function FiringOrderField({ value, nCylinders, onChange }: Props) {
  const valid = validateFiringOrder(value, nCylinders);
  const errorMsg = valid.ok ? null : valid.message;

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {value.map((cyl, i) => (
          <div
            key={i}
            className="flex items-center gap-0.5 rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-1.5 py-0.5"
          >
            <span className="font-mono text-[11px] text-[#D8DCE2]">{cyl}</span>
            <div className="flex flex-col">
              <button
                type="button"
                aria-label={`Move position ${i + 1} left`}
                disabled={i === 0}
                className="px-1 text-[8px] leading-none text-[#5A5F66] hover:text-[#FFC627] disabled:opacity-30"
                onClick={() => move(i, -1)}
              >
                ◀
              </button>
              <button
                type="button"
                aria-label={`Move position ${i + 1} right`}
                disabled={i === value.length - 1}
                className="px-1 text-[8px] leading-none text-[#5A5F66] hover:text-[#FFC627] disabled:opacity-30"
                onClick={() => move(i, 1)}
              >
                ▶
              </button>
            </div>
          </div>
        ))}
      </div>
      {errorMsg && <div className="text-[10px] text-red-300">{errorMsg}</div>}
    </div>
  );
}
