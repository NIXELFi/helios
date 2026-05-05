import type { WidgetConfigEditorProps } from "../types";
import type { NumericReadoutConfig } from "./render";

export function NumericReadoutConfigEditor({ config, onChange }: WidgetConfigEditorProps<NumericReadoutConfig>) {
  return (
    <div className="flex flex-col gap-2 p-2 text-xs text-[#D8DCE2]">
      <label>Channel
        <input
          className="ml-2 bg-[#0E0E10] border border-[#2A2C32] px-1"
          value={config.channelId}
          onChange={(e) => onChange({ ...config, channelId: e.target.value })}
        />
      </label>
      <label>Units
        <input
          className="ml-2 bg-[#0E0E10] border border-[#2A2C32] px-1"
          value={config.units}
          onChange={(e) => onChange({ ...config, units: e.target.value })}
        />
      </label>
      <label>Decimals
        <input
          type="number" min={0} max={6}
          className="ml-2 w-12 bg-[#0E0E10] border border-[#2A2C32] px-1"
          value={config.decimals}
          onChange={(e) => onChange({ ...config, decimals: Number(e.target.value) })}
        />
      </label>
    </div>
  );
}
