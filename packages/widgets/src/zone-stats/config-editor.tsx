import type { WidgetConfigEditorProps } from "../types";
import { ChannelPicker } from "../lib/channel-picker";
import type { ZoneStatsConfig } from "./render";

export function ZoneStatsConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<ZoneStatsConfig>) {
  function add(id: string) {
    if (!id || config.channelIds.includes(id)) return;
    onChange({ ...config, channelIds: [...config.channelIds, id] });
  }
  function remove(id: string) {
    onChange({ ...config, channelIds: config.channelIds.filter((c) => c !== id) });
  }
  return (
    <div className="p-2 text-xs text-[#D8DCE2] flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wider text-[#7B8088]">Channels</div>
      <div className="flex flex-wrap gap-1">
        {config.channelIds.map((id) => (
          <span key={id} className="px-1.5 py-0.5 bg-[#0E0E10] border border-[#2A2C32] flex items-center gap-1">
            <span className="font-mono-num text-[10px]">{id}</span>
            <button onClick={() => remove(id)} className="text-[#7B8088] hover:text-[#EF5350]">×</button>
          </span>
        ))}
      </div>
      <ChannelPicker channels={availableChannels} value="" onChange={add} allowEmpty />
    </div>
  );
}
