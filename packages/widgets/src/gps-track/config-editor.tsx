import type { WidgetConfigEditorProps } from "../types";
import type { GpsTrackConfig } from "./render";
import { ChannelPicker } from "../lib/channel-picker";

export function GpsTrackConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<GpsTrackConfig>) {
  const set = (k: keyof GpsTrackConfig, v: unknown) => onChange({ ...config, [k]: v } as GpsTrackConfig);
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      <label className="flex justify-between items-center"><span>latChannelId</span>
        <ChannelPicker className="w-40" value={config.latChannelId} onChange={(v) => set("latChannelId", v)} channels={availableChannels} />
      </label>
      <label className="flex justify-between items-center"><span>lonChannelId</span>
        <ChannelPicker className="w-40" value={config.lonChannelId} onChange={(v) => set("lonChannelId", v)} channels={availableChannels} />
      </label>
      <label className="flex justify-between items-center"><span>color</span>
        <input
          type="color"
          className="w-12 h-7 bg-[#0E0E10] border border-[#2A2C32] cursor-pointer"
          value={config.color ?? "#4FC3F7"}
          onChange={(e) => set("color", e.target.value)}
        />
      </label>
      <label className="flex justify-between items-center"><span>colorByChannelId</span>
        <ChannelPicker className="w-40" value={config.colorByChannelId ?? ""} onChange={(v) => set("colorByChannelId", v || undefined)} channels={availableChannels} allowEmpty />
      </label>
      {(["colorMin", "colorMax"] as const).map((k) => (
        <label key={k} className="flex justify-between"><span>{k}</span>
          <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-40"
            value={config[k] === undefined ? "" : config[k]}
            onChange={(e) => set(k, e.target.value === "" ? undefined : Number(e.target.value))} />
        </label>
      ))}
    </div>
  );
}
