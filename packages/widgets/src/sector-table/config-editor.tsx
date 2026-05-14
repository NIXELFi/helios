import type { WidgetConfigEditorProps } from "../types";
import type { SectorTableConfig } from "./render";

export function SectorTableConfigEditor({ config, onChange }: WidgetConfigEditorProps<SectorTableConfig>) {
  return (
    <div className="p-2 text-xs text-helios-dim space-y-2">
      <label className="flex items-center justify-between gap-2">
        <span>Sectors per lap</span>
        <input
          type="number" min={1} max={10}
          value={config.sectorCount}
          onChange={(e) => {
            const n = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1));
            onChange({ ...config, sectorCount: n });
          }}
          className="w-14 bg-helios-base border border-helios-line rounded-sm px-1 py-0.5 text-helios-text text-right focus:outline-none focus:border-asu-gold"
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        <span>Rows shown (most recent)</span>
        <input
          type="number" min={1} max={50}
          value={config.maxRows}
          onChange={(e) => {
            const n = Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1));
            onChange({ ...config, maxRows: n });
          }}
          className="w-14 bg-helios-base border border-helios-line rounded-sm px-1 py-0.5 text-helios-text text-right focus:outline-none focus:border-asu-gold"
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        <span>Hide untrusted laps</span>
        <input
          type="checkbox"
          checked={config.hideUntrusted}
          onChange={(e) => onChange({ ...config, hideUntrusted: e.target.checked })}
          className="accent-asu-gold"
        />
      </label>
      <p className="mt-3 leading-relaxed">
        Sectors auto-split each lap by distance.{" "}
        <span className="text-[#BA68C8]">Purple</span> = best sector across visible laps.{" "}
        <span className="text-asu-gold">Gold</span> = best total lap.
        The "opt" row is the theoretical lap from every purple sector.
      </p>
    </div>
  );
}
