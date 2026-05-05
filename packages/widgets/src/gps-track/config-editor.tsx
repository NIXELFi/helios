import type { WidgetConfigEditorProps } from "../types";
import type { GpsTrackConfig } from "./render";

export function GpsTrackConfigEditor({ config, onChange }: WidgetConfigEditorProps<GpsTrackConfig>) {
  const set = (k: keyof GpsTrackConfig, v: unknown) => onChange({ ...config, [k]: v } as GpsTrackConfig);
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      {(["latChannelId", "lonChannelId", "colorByChannelId"] as const).map((k) => (
        <label key={k} className="flex justify-between"><span>{k}</span>
          <input className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-40"
            value={(config[k] as string | undefined) ?? ""}
            onChange={(e) => set(k, e.target.value || undefined)} />
        </label>
      ))}
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
