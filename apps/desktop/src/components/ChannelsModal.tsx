import { useMemo, useState } from "react";
import type { ChannelMeta } from "@helios/store";

interface Props {
  channels: ChannelMeta[];
  sessionLabel: string;
  onClose: () => void;
}

/** Read-only inspector for every channel resolved in the primary session.
 *  Lets the user search/filter and inspect metadata so it's clear which
 *  underlying CSV column is currently mapped to each canonical id.
 *  Editing channel metadata or remapping CSV columns to different canonical
 *  ids is a follow-up (it requires either a per-session override layer or
 *  rewriting docs/channels.yaml at runtime). */
export function ChannelsModal({ channels, sessionLabel, onClose }: Props) {
  const [filter, setFilter] = useState("");

  const grouped = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = !f ? channels : channels.filter((c) =>
      c.id.toLowerCase().includes(f)
      || c.display_name.toLowerCase().includes(f)
      || c.group.toLowerCase().includes(f)
    );
    const out = new Map<string, ChannelMeta[]>();
    for (const c of [...filtered].sort((a, b) => a.id.localeCompare(b.id))) {
      const list = out.get(c.group) ?? [];
      list.push(c);
      out.set(c.group, list);
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [channels, filter]);

  const totalShown = grouped.reduce((s, [, list]) => s + list.length, 0);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-[#0E0E10] border border-[#2A2C32] w-[720px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-9 flex items-center justify-between px-3 border-b border-[#2A2C32]">
          <span className="text-xs uppercase tracking-wider text-[#FFC627]">Channels</span>
          <span className="text-[11px] text-[#7B8088]">{sessionLabel}</span>
          <button
            aria-label="Close"
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center text-[#7B8088] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
          >×</button>
        </div>
        <div className="px-3 py-2 border-b border-[#2A2C32] flex items-center gap-2">
          <input
            type="text"
            placeholder="filter by id, name, or group…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="flex-1 bg-[#16171B] border border-[#2A2C32] rounded-sm px-2 py-1 text-xs text-[#D8DCE2] focus:outline-none focus:border-[#FFC627]"
          />
          <span className="text-[10px] text-[#7B8088]">{totalShown} / {channels.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-xs text-[#D8DCE2]">
            <thead className="sticky top-0 bg-[#0E0E10] border-b border-[#2A2C32]">
              <tr className="text-[10px] uppercase tracking-wider text-[#7B8088]">
                <th className="text-left px-2 py-1 w-2"></th>
                <th className="text-left px-2 py-1">id</th>
                <th className="text-left px-2 py-1">display name</th>
                <th className="text-left px-2 py-1">units</th>
                <th className="text-right px-2 py-1">rate</th>
                <th className="text-right px-2 py-1">min</th>
                <th className="text-right px-2 py-1">max</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(([group, list]) => (
                <>
                  <tr key={`g-${group}`} className="bg-[#16171B]">
                    <td colSpan={7} className="px-2 py-1 text-[10px] uppercase tracking-wider text-[#7B8088]">{group}</td>
                  </tr>
                  {list.map((c) => (
                    <tr key={c.id} className="border-b border-[#16171B] hover:bg-[#16171B]">
                      <td className="px-2 py-1">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: c.color }} />
                      </td>
                      <td className="px-2 py-1 font-mono-num text-[#FFC627]">{c.id}</td>
                      <td className="px-2 py-1">{c.display_name}</td>
                      <td className="px-2 py-1 text-[#7B8088]">{c.units || "—"}</td>
                      <td className="px-2 py-1 font-mono-num text-right text-[#7B8088]">{c.sample_rate_hz} Hz</td>
                      <td className="px-2 py-1 font-mono-num text-right text-[#7B8088]">{c.min ?? "—"}</td>
                      <td className="px-2 py-1 font-mono-num text-right text-[#7B8088]">{c.max ?? "—"}</td>
                    </tr>
                  ))}
                </>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2 border-t border-[#2A2C32] text-[10px] text-[#7B8088]">
          Read-only. Editing channel metadata and remapping CSV columns to canonical ids will land in a future commit.
        </div>
      </div>
    </div>
  );
}
