import type { WidgetConfigEditorProps } from "../types";
import type { GpsTrackConfig, BasemapMode, LabelsMode } from "./render";
import type { Sensitivity } from "./turns";
import { ChannelPicker } from "../lib/channel-picker";

const BASEMAP_OPTIONS: Array<{ value: BasemapMode; label: string }> = [
  { value: "none",      label: "None (dark canvas)" },
  { value: "dark",      label: "Dark roads (CARTO)" },
  { value: "satellite", label: "Satellite (Esri)" },
  { value: "custom",    label: "Custom tile URL" },
];

const LABELS_OPTIONS: Array<{ value: LabelsMode; label: string }> = [
  { value: "none",                 label: "None" },
  { value: "turns",                label: "Turns (T1, T2…)" },
  { value: "turns_and_straights",  label: "Turns + straights" },
];

const SENSITIVITY_OPTIONS: Array<{ value: Sensitivity; label: string }> = [
  { value: "low",    label: "Low (only obvious corners)" },
  { value: "medium", label: "Medium (default)" },
  { value: "high",   label: "High (catches subtle bends)" },
];

export function GpsTrackConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<GpsTrackConfig>) {
  const set = (k: keyof GpsTrackConfig, v: unknown) => onChange({ ...config, [k]: v } as GpsTrackConfig);
  const basemap = config.basemap ?? "none";
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
      <div className="border-t border-[#2A2C32] mt-2 pt-2 flex flex-col gap-1">
        <label className="flex justify-between items-center"><span>basemap</span>
          <select
            className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-40 text-[#D8DCE2]"
            value={basemap}
            onChange={(e) => set("basemap", e.target.value as BasemapMode)}
          >
            {BASEMAP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        {basemap === "custom" && (
          <label className="flex justify-between items-center"><span>customTileUrl</span>
            <input
              className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-40 font-mono"
              placeholder="https://…/{z}/{x}/{y}.png"
              value={config.customTileUrl ?? ""}
              onChange={(e) => set("customTileUrl", e.target.value || undefined)}
            />
          </label>
        )}
      </div>
      <div className="border-t border-[#2A2C32] mt-2 pt-2 flex flex-col gap-1">
        <label className="flex justify-between items-center"><span>track labels</span>
          <select
            className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-40 text-[#D8DCE2]"
            value={config.labels ?? "none"}
            onChange={(e) => set("labels", e.target.value as LabelsMode)}
          >
            {LABELS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        {(config.labels ?? "none") !== "none" && (
          <label className="flex justify-between items-center"><span>sensitivity</span>
            <select
              className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-40 text-[#D8DCE2]"
              value={config.labelSensitivity ?? "medium"}
              onChange={(e) => set("labelSensitivity", e.target.value as Sensitivity)}
            >
              {SENSITIVITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}
