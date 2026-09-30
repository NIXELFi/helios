import { useMemo, useState, type FC } from "react";
import type { ChannelMeta } from "@helios/store";
import { parseExpr } from "@helios/lib";
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
    <div className="flex flex-col gap-2 p-2 text-xs text-helios-text">
      {/* Mode toggle */}
      <div className="flex items-center gap-2 border-b border-helios-line pb-2">
        {(["simple", "advanced"] as const).map((m) => (
          <button key={m} type="button"
            onClick={() => set("mode", m)}
            className={
              "px-2 py-0.5 text-[11px] border rounded-sm cursor-pointer " +
              (config.mode === m
                ? "bg-asu-gold text-helios-on-gold border-asu-gold font-semibold"
                : "bg-helios-panel text-helios-text border-helios-line hover:border-asu-gold")
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
            <input type="number" className="bg-helios-base border border-helios-line px-1 w-32"
              value={config[k] === undefined ? "" : config[k]}
              onChange={(e) => set(k, e.target.value === "" ? undefined : Number(e.target.value))} />
          </label>
        ))}
      </div>

      {/* Advanced-only sections */}
      {config.mode === "advanced" && (
        <>
          <div className="flex flex-col gap-1 border-t border-helios-line pt-2">
            <FilterInput value={config.filter ?? ""} onChange={(v) => set("filter", v || undefined)} />
            <label className="flex justify-between items-center"><span>group by channel</span>
              <ChannelPicker className="w-40" value={config.groupByChannelId ?? ""}
                onChange={(v) => set("groupByChannelId", v || undefined)}
                channels={availableChannels} />
            </label>
          </div>

          <div className="flex flex-col gap-1 border-t border-helios-line pt-2">
            <div className="text-[10px] text-helios-dim uppercase tracking-wider">overlays</div>
            {config.overlays.map((o, idx) => (
              <OverlayRow key={o.id} overlay={o} index={idx} total={config.overlays.length}
                availableChannels={availableChannels}
                siblings={config.overlays.filter((s) => s.id !== o.id).map(({ id, kind }) => ({ id, kind }))}
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

function OverlayRow({ overlay, index, total, availableChannels, siblings, onConfigChange, onMove, onRemove }: {
  overlay: Overlay;
  index: number;
  total: number;
  availableChannels: ChannelMeta[];
  siblings: Array<{ id: string; kind: string }>;
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
  const Editor = mod.Editor as FC<{
    config: unknown;
    onChange: (c: unknown) => void;
    availableChannels: ChannelMeta[];
    siblings: Array<{ id: string; kind: string }>;
  }>;
  return (
    <div className="border border-helios-line rounded-sm">
      <div className="flex items-center justify-between px-1 py-0.5 bg-helios-base text-[11px]">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-left flex-1">
          <span>{open ? "▾" : "▸"}</span>
          <span className="font-semibold text-asu-gold">{overlay.kind}</span>
        </button>
        <div className="flex items-center gap-1">
          <button onClick={() => onMove(-1)} disabled={index === 0} className="px-1 disabled:opacity-30">↑</button>
          <button onClick={() => onMove(1)} disabled={index === total - 1} className="px-1 disabled:opacity-30">↓</button>
          <button onClick={onRemove} className="px-1 text-[#EF5350]">✕</button>
        </div>
      </div>
      {open && (
        <div className="p-1">
          <Editor config={overlay.config} onChange={onConfigChange}
            availableChannels={availableChannels} siblings={siblings} />
        </div>
      )}
    </div>
  );
}

function FilterInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const error = useMemo(() => {
    if (!value.trim()) return null;
    const r = parseExpr(value);
    return r.error ?? null;
  }, [value]);
  return (
    <div className="flex flex-col gap-0.5">
      <label className="flex justify-between items-center"><span>filter (math-expr)</span>
        <input type="text" value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="(none — e.g. throttle > 50)"
          className={
            "w-44 bg-helios-base border px-1 font-mono text-[11px] " +
            (error ? "border-[#EF5350]" : "border-helios-line")
          } />
      </label>
      {error && <div className="text-[10px] text-[#EF5350] text-right">{error}</div>}
    </div>
  );
}

function AddOverlayPicker({ mode, onAdd }: { mode: "simple" | "advanced"; onAdd: (kind: string) => void }) {
  const available = listOverlayModules().filter((m) => m.availability.includes(mode));
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((s) => !s)}
        className="px-2 py-0.5 text-[11px] border border-helios-line bg-helios-panel text-asu-gold hover:border-asu-gold rounded-sm cursor-pointer">
        + Add overlay
      </button>
      {open && (
        <div className="absolute z-10 mt-1 bg-helios-base border border-helios-line rounded-sm flex flex-col">
          {available.map((mod) => (
            <button key={mod.kind} onClick={() => { onAdd(mod.kind); setOpen(false); }}
              className="px-2 py-1 text-left text-[11px] hover:bg-helios-panel">{mod.kind}</button>
          ))}
        </div>
      )}
    </div>
  );
}
