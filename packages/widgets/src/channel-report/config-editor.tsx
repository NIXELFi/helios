import type { WidgetConfigEditorProps } from "../types";
import { ChannelPicker } from "../lib/channel-picker";
import type { ChannelReportConfig, ChannelReportStat } from "./render";

const ALL_STATS: { id: ChannelReportStat; label: string }[] = [
  { id: "avg", label: "Average" },
  { id: "min", label: "Minimum" },
  { id: "max", label: "Maximum" },
  { id: "abs_max", label: "|Max|" },
  { id: "start", label: "Start" },
  { id: "end", label: "End" },
  { id: "change", label: "Change (end − start)" },
  { id: "stddev", label: "Std deviation" },
];

export function ChannelReportConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<ChannelReportConfig>) {
  function set<K extends keyof ChannelReportConfig>(k: K, v: ChannelReportConfig[K]) {
    onChange({ ...config, [k]: v });
  }
  function toggleStat(s: ChannelReportStat) {
    const has = config.stats.includes(s);
    set("stats", has ? config.stats.filter((x) => x !== s) : [...config.stats, s]);
  }
  function addChannel(id: string) {
    if (!id || config.channelIds.includes(id)) return;
    set("channelIds", [...config.channelIds, id]);
  }
  function removeChannel(id: string) {
    set("channelIds", config.channelIds.filter((c) => c !== id));
  }
  return (
    <div className="p-2 text-xs text-[#D8DCE2] flex flex-col gap-3">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-[#9097A0] mb-1">Channels</div>
        <div className="flex flex-wrap gap-1 mb-1">
          {config.channelIds.map((id) => (
            <span key={id} className="px-1.5 py-0.5 bg-[#16171B] border border-[#2A2C32] flex items-center gap-1">
              <span className="font-mono-num text-[10px]">{id}</span>
              <button onClick={() => removeChannel(id)} className="text-[#9097A0] hover:text-[#EF5350]">×</button>
            </span>
          ))}
        </div>
        <ChannelPicker channels={availableChannels} value="" onChange={addChannel} allowEmpty />
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-[#9097A0] mb-1">Stats</div>
        <div className="grid grid-cols-2 gap-1">
          {ALL_STATS.map((s) => (
            <label key={s.id} className="flex items-center gap-1 text-[11px] cursor-pointer">
              <input type="checkbox" checked={config.stats.includes(s.id)} onChange={() => toggleStat(s.id)} className="accent-[#FFC627]" />
              {s.label}
            </label>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2 text-[11px] cursor-pointer">
        <input type="checkbox" checked={config.hideUntrusted} onChange={(e) => set("hideUntrusted", e.target.checked)} className="accent-[#FFC627]" />
        Hide out-laps / in-laps (untrusted)
      </label>
      <label className="flex items-center gap-2 text-[11px] cursor-pointer">
        <input type="checkbox" checked={config.perSession} onChange={(e) => set("perSession", e.target.checked)} className="accent-[#FFC627]" />
        Show all visible sessions (one block each)
      </label>
    </div>
  );
}
