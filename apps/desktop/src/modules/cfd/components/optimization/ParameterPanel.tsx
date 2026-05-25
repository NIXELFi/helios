// Full parameter tree, grouped by ParameterMeta.group. Owns the
// onChange contract for the bounds[] array. The panel maintains stable
// row identity by path so toggling enable doesn't reorder visible rows.
//
// Lock awareness: when a leader row has `lockToFollower=true`, the
// matching follower row is rendered read-only and its `enabled` is
// forced off in serialization (handled by the modal). The follower's
// perElement is also overridden to mirror the leader's.

import type { ParameterBoundsUI, ParameterMeta } from "../../state/types";
import { followerOf, leaderOf } from "../../lib/lockedPairs";
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

  // Build the "this row is a locked follower" map. A follower row is
  // locked iff its registered leader exists in `bounds` AND has
  // `lockToFollower=true` AND that leader row is `enabled`.
  const followerLockedTo = new Map<string, string>(); // followerPath -> leaderPath
  for (const b of bounds) {
    if (!b.lockToFollower || !b.enabled) continue;
    const f = followerOf(b.path);
    if (f) followerLockedTo.set(f, b.path);
  }

  function update(path: string, next: ParameterBoundsUI) {
    // Force-clamp the follower's perElement to mirror the leader when
    // the lock is active. Users cannot diverge the follower's index
    // from the leader's via the UI; this also protects round-trips.
    const leaderOfThis = leaderOf(path);
    const leader = leaderOfThis ? boundsByPath.get(leaderOfThis) : undefined;
    if (leader?.lockToFollower && leader.enabled) {
      next = { ...next, enabled: false, perElement: leader.perElement };
    }
    const existingIdx = bounds.findIndex((b) => b.path === path);
    let copy: ParameterBoundsUI[];
    if (existingIdx === -1) {
      copy = [...bounds, next];
    } else {
      copy = bounds.slice();
      copy[existingIdx] = next;
    }
    // If this update is on a LEADER whose lock just toggled / scope just
    // changed, propagate the perElement to the follower's row so the
    // visible "[N]" suffix on the follower stays in sync.
    const followerPath = followerOf(path);
    if (followerPath && next.lockToFollower && next.enabled) {
      const fIdx = copy.findIndex((b) => b.path === followerPath);
      const followerMeta = schema.find((m) => m.path === followerPath);
      const existingFollower = fIdx !== -1 ? copy[fIdx] : undefined;
      if (existingFollower) {
        copy[fIdx] = {
          ...existingFollower,
          enabled: false,
          perElement: next.perElement,
        };
      } else if (followerMeta) {
        copy.push({
          path: followerPath,
          enabled: false,
          perElement: next.perElement,
          min: followerMeta.suggestedMin,
          max: followerMeta.suggestedMax,
          step: null,
        });
      }
    }
    onChange(copy);
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
                const canLock = followerOf(m.path) !== null;
                const leaderLockedTo = followerLockedTo.get(m.path) ?? null;
                // Display-only override: when locked, render the follower
                // row's perElement as the leader's (mirroring) without
                // touching stored state (already mirrored by `update`).
                const displayBounds = leaderLockedTo
                  ? {
                      ...b,
                      perElement:
                        boundsByPath.get(leaderLockedTo)?.perElement ?? b.perElement,
                      enabled: false,
                    }
                  : b;
                return (
                  <ParameterRow
                    key={m.path}
                    meta={m}
                    bounds={displayBounds}
                    canLock={canLock}
                    lockedAsFollower={
                      leaderLockedTo ? { leader: leaderLockedTo } : null
                    }
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
