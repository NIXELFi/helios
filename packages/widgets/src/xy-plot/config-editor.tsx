import { useState, type FC } from "react";
import type { ChannelMeta } from "@helios/store";
import type { WidgetConfigEditorProps } from "../types";
import type { XyPlotConfig, Overlay } from "./types";
import { ChannelPicker } from "../lib/channel-picker";
import { getOverlayModule, listOverlayModules } from "./overlays/registry";

export function XyPlotConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<XyPlotConfig>) {
  const set = <K extends keyof XyPlotConfig>(k: K, v: XyPlotConfig[K]) => onChange({ ...config, [k]: v });

  const updateOverlay = (id: string, nextConfig: unknown) => {
    onChange({
      ...config,
      overlays: config.overlays.map((o) => o.id === id ? { ...o, config: nextConfig as never } as Overlay : o),
    });
  };
  const removeOverlay = (id: string) =>
    onChange({ ...config, overlays: config.overlays.filter((o) => o.id !== id) });
  const moveOverlay = (id: string, dir: -1 | 1) => {
    const idx = config.overlays.findIndex((o) => o.id === id);
    if (idx < 0) return;
    const next = [...config.overlays];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    onChange({ ...config, overlays: next });
  };
  const addOverlay = (kind: string) => {
    const mod = getOverlayModule(kind);
    if (!mod) return;
    onChange({
      ...config,
      overlays: [...config.overlays, {
        id: crypto.randomUUID(),
        kind,
        config: mod.defaultConfig() as never,
      } as Overlay],
    });
  };

  return (
    <div className="flex flex-col gap-2 p-2 text-xs text-[#D8DCE2]">
      {/* Mode toggle */}
      <div className="flex items-center gap-2 border-b border-[#2A2C32] pb-2">
        {(["simple", "advanced"] as const).map((m) => (
          <button key={m} type="button"
            onClick={() => set("mode", m)}
            className={
              "px-2 py-0.5 text-[11px] border rounded-sm cursor-pointer " +
              (config.mode === m
                ? "bg-[#FFC627] text-[#0E0E10] border-[#FFC627] font-semibold"
                : "bg-[#16171B] text-[#D8DCE2] border-[#2A2C32] hover:border-[#FFC627]")
            }>{m}</button>
        ))}
      </div>

      {/* Channels (always visible) */}
      <div className="flex flex-col gap-1">
        <label className="flex justify-between items-center"><span>x channel</span>
          <ChannelPicker className="w-40" value={config.xChannelId} onChange={(v) => set("xChannelId", v)} channels={availableChannels} />
        </label>
        <label className="flex justify-between items-center"><span>y channel</span>
          <ChannelPicker className="w-40" value={config.yChannelId} onChange={(v) => set("yChannelId", v)} channels={availableChannels} />
        </label>
        {(["xMin", "xMax", "yMin", "yMax"] as const).map((k) => (
          <label key={k} className="flex justify-between"><span>{k}</span>
            <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
              value={config[k] === undefined ? "" : config[k]}
              onChange={(e) => set(k, e.target.value === "" ? undefined : Number(e.target.value))} />
          </label>
        ))}
      </div>

      {/* Advanced-only sections */}
      {config.mode === "advanced" && (
        <>
          <div className="flex flex-col gap-1 border-t border-[#2A2C32] pt-2">
            <label className="flex justify-between items-center"><span>filter (math-expr)</span>
              <input type="text" value={config.filter ?? ""}
                onChange={(e) => set("filter", e.target.value)}
                placeholder="(none)"
                className="w-44 bg-[#0E0E10] border border-[#2A2C32] px-1 font-mono text-[11px]" />
            </label>
            <label className="flex justify-between items-center"><span>group by channel</span>
              <ChannelPicker className="w-40" value={config.groupByChannelId ?? ""}
                onChange={(v) => set("groupByChannelId", v || undefined)}
                channels={availableChannels} />
            </label>
          </div>

          <div className="flex flex-col gap-1 border-t border-[#2A2C32] pt-2">
            <div className="text-[10px] text-[#7B8088] uppercase tracking-wider">overlays</div>
            {config.overlays.map((o, idx) => (
              <OverlayRow key={o.id} overlay={o} index={idx} total={config.overlays.length}
                availableChannels={availableChannels}
                onConfigChange={(c) => updateOverlay(o.id, c)}
                onMove={(dir) => moveOverlay(o.id, dir)}
                onRemove={() => removeOverlay(o.id)} />
            ))}
            <AddOverlayPicker mode={config.mode} onAdd={addOverlay} />
          </div>
        </>
      )}
    </div>
  );
}

function OverlayRow({ overlay, index, total, availableChannels, onConfigChange, onMove, onRemove }: {
  overlay: Overlay;
  index: number;
  total: number;
  availableChannels: ChannelMeta[];
  onConfigChange: (cfg: unknown) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const mod = getOverlayModule(overlay.kind);
  const [open, setOpen] = useState(true);
  if (!mod) {
    return (
      <div className="text-[#EF5350] text-[11px] py-1">
        unknown overlay kind: {overlay.kind} <button onClick={onRemove} className="ml-2 underline">remove</button>
      </div>
    );
  }
  const Editor = mod.Editor as FC<{ config: unknown; onChange: (c: unknown) => void; availableChannels: ChannelMeta[] }>;
  return (
    <div className="border border-[#2A2C32] rounded-sm">
      <div className="flex items-center justify-between px-1 py-0.5 bg-[#0E0E10] text-[11px]">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-left flex-1">
          <span>{open ? "▾" : "▸"}</span>
          <span className="font-semibold text-[#FFC627]">{overlay.kind}</span>
        </button>
        <div className="flex items-center gap-1">
          <button onClick={() => onMove(-1)} disabled={index === 0} className="px-1 disabled:opacity-30">↑</button>
          <button onClick={() => onMove(1)} disabled={index === total - 1} className="px-1 disabled:opacity-30">↓</button>
          <button onClick={onRemove} className="px-1 text-[#EF5350]">✕</button>
        </div>
      </div>
      {open && (
        <div className="p-1">
          <Editor config={overlay.config} onChange={onConfigChange} availableChannels={availableChannels} />
        </div>
      )}
    </div>
  );
}

function AddOverlayPicker({ mode, onAdd }: { mode: "simple" | "advanced"; onAdd: (kind: string) => void }) {
  const available = listOverlayModules().filter((m) => m.availability.includes(mode));
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((s) => !s)}
        className="px-2 py-0.5 text-[11px] border border-[#2A2C32] bg-[#16171B] text-[#FFC627] hover:border-[#FFC627] rounded-sm cursor-pointer">
        + Add overlay
      </button>
      {open && (
        <div className="absolute z-10 mt-1 bg-[#0E0E10] border border-[#2A2C32] rounded-sm flex flex-col">
          {available.map((mod) => (
            <button key={mod.kind} onClick={() => { onAdd(mod.kind); setOpen(false); }}
              className="px-2 py-1 text-left text-[11px] hover:bg-[#16171B]">{mod.kind}</button>
          ))}
        </div>
      )}
    </div>
  );
}
