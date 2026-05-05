import type { WidgetConfigEditorProps } from "../types";
import type { EngineBarConfig } from "./render";
import { ChannelPicker } from "../lib/channel-picker";

export function EngineBarConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<EngineBarConfig>) {
  const set = (k: keyof EngineBarConfig, v: unknown) => onChange({ ...config, [k]: v } as EngineBarConfig);
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      <label className="flex justify-between items-center"><span>rpmChannelId</span>
        <ChannelPicker className="w-40" value={config.rpmChannelId} onChange={(v) => set("rpmChannelId", v)} channels={availableChannels} />
      </label>
      <label className="flex justify-between items-center"><span>gearChannelId</span>
        <ChannelPicker className="w-40" value={config.gearChannelId ?? ""} onChange={(v) => set("gearChannelId", v || undefined)} channels={availableChannels} allowEmpty />
      </label>
      <label className="flex justify-between"><span>redline</span>
        <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.redline} onChange={(e) => set("redline", Number(e.target.value))} />
      </label>
      <label className="flex justify-between"><span>shiftLightStart</span>
        <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.shiftLightStart} onChange={(e) => set("shiftLightStart", Number(e.target.value))} />
      </label>
      <label className="flex justify-between"><span>segments</span>
        <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.segments} onChange={(e) => set("segments", Number(e.target.value))} />
      </label>
    </div>
  );
}
