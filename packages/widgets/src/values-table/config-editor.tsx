import type { WidgetConfigEditorProps } from "../types";
import { ChannelPicker } from "../lib/channel-picker";
import type { ValuesTableConfig } from "./render";

export function ValuesTableConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<ValuesTableConfig>) {
  function addChannel(id: string) {
    if (!id || config.channelIds.includes(id)) return;
    onChange({ ...config, channelIds: [...config.channelIds, id] });
  }
  function removeChannel(id: string) {
    onChange({ ...config, channelIds: config.channelIds.filter((c) => c !== id) });
  }
  return (
    <div className="p-2 text-xs text-[#D8DCE2] flex flex-col gap-3">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-[#9097A0] mb-1">Channels</div>
        <div className="flex flex-wrap gap-1 mb-1">
          {config.channelIds.map((id) => (
            <span key={id} className="px-1.5 py-0.5 bg-[#16171B] border border-[#2A2C32] flex items-center gap-1">
              <span className="font-mono-num text-[10px]">{id}</span>
              <button
                aria-label={`Remove ${id}`}
                onClick={() => removeChannel(id)}
                className="text-[#9097A0] hover:text-[#EF5350]"
              >×</button>
            </span>
          ))}
        </div>
        <ChannelPicker channels={availableChannels} value="" onChange={addChannel} allowEmpty />
      </div>
      <label className="flex items-center gap-2 text-[11px] cursor-pointer">
        <input
          type="checkbox"
          checked={config.showStats}
          onChange={(e) => onChange({ ...config, showStats: e.target.checked })}
          className="accent-[#FFC627]"
        />
        Show min / max / avg (primary session, zoom window)
      </label>
    </div>
  );
}
