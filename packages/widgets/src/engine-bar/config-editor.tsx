import type { WidgetConfigEditorProps } from "../types";
import type { EngineBarConfig } from "./render";
import { ChannelPicker } from "../lib/channel-picker";
import { clampSegments, MIN_SEGMENTS, MAX_SEGMENTS } from "../lib/config-clamp";

export function EngineBarConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<EngineBarConfig>) {
  const set = (k: keyof EngineBarConfig, v: unknown) => onChange({ ...config, [k]: v } as EngineBarConfig);
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-helios-text">
      <label className="flex justify-between items-center"><span>rpmChannelId</span>
        <ChannelPicker className="w-40" value={config.rpmChannelId} onChange={(v) => set("rpmChannelId", v)} channels={availableChannels} />
      </label>
      <label className="flex justify-between items-center"><span>gearChannelId</span>
        <ChannelPicker className="w-40" value={config.gearChannelId ?? ""} onChange={(v) => set("gearChannelId", v || undefined)} channels={availableChannels} allowEmpty />
      </label>
      <label className="flex justify-between"><span>redline</span>
        <input type="number" className="bg-helios-base border border-helios-line px-1 w-32" value={config.redline} onChange={(e) => set("redline", Number(e.target.value))} />
      </label>
      <label className="flex justify-between"><span>shiftLightStart</span>
        <input type="number" className="bg-helios-base border border-helios-line px-1 w-32" value={config.shiftLightStart} onChange={(e) => set("shiftLightStart", Number(e.target.value))} />
      </label>
      <label className="flex justify-between"><span>segments</span>
        <input type="number" className="bg-helios-base border border-helios-line px-1 w-32" min={MIN_SEGMENTS} max={MAX_SEGMENTS} value={config.segments} onChange={(e) => set("segments", clampSegments(e.target.value))} />
      </label>
    </div>
  );
}
