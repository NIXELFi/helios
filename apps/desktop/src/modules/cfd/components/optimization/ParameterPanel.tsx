// Full parameter tree, grouped by ParameterMeta.group. Owns the
// onChange contract for the bounds[] array. The panel maintains stable
// row identity by path so toggling enable doesn't reorder visible rows.

import type { ParameterBoundsUI, ParameterMeta } from "../../state/types";
import { ParameterRow } from "./ParameterRow";

interface Props {
  schema: ParameterMeta[];
  bounds: ParameterBoundsUI[];
  onChange: (next: ParameterBoundsUI[]) => void;
}

export function ParameterPanel({ schema, bounds, onChange }: Props) {
  // Group meta by panel group, preserving first-seen order.
  const groups: { name: string; metas: ParameterMeta[] }[] = [];
  const groupIdx = new Map<string, number>();
  for (const m of schema) {
    let i = groupIdx.get(m.group);
    if (i === undefined) {
      i = groups.length;
      groupIdx.set(m.group, i);
      groups.push({ name: m.group, metas: [] });
    }
    groups[i]?.metas.push(m);
  }

  // Index existing bounds by path for fast lookup.
  const boundsByPath = new Map(bounds.map((b) => [b.path, b]));

  function update(path: string, next: ParameterBoundsUI) {
    const existingIdx = bounds.findIndex((b) => b.path === path);
    if (existingIdx === -1) {
      onChange([...bounds, next]);
    } else {
      const copy = bounds.slice();
      copy[existingIdx] = next;
      onChange(copy);
    }
  }

  function defaultBoundsFor(m: ParameterMeta): ParameterBoundsUI {
    return {
      path: m.path,
      enabled: false,
      perElement: null,
      min: m.suggestedMin,
      max: m.suggestedMax,
      step: null,
    };
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g.name}>
          <h3 className="mb-1 text-[10px] uppercase tracking-wider text-[#FFC627]">
            {g.name}
          </h3>
          <table className="w-full">
            <thead>
              <tr className="text-left text-[9px] uppercase tracking-wider text-[#5A5F66]">
                <th className="px-2 py-1 font-normal">on</th>
                <th className="px-2 py-1 font-normal">path</th>
                <th className="px-2 py-1 font-normal">unit</th>
                <th className="px-2 py-1 text-right font-normal">default</th>
                <th className="px-2 py-1 font-normal">min</th>
                <th className="px-2 py-1 font-normal">max</th>
                <th className="px-2 py-1 font-normal">step</th>
                <th className="px-2 py-1 font-normal">scope</th>
              </tr>
            </thead>
            <tbody>
              {g.metas.map((m) => {
                const b = boundsByPath.get(m.path) ?? defaultBoundsFor(m);
                return (
                  <ParameterRow
                    key={m.path}
                    meta={m}
                    bounds={b}
                    onChange={(next) => update(m.path, next)}
                  />
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
