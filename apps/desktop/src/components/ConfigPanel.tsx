import { useState } from "react";
import { widgetRegistry, BUILTIN_WIDGET_TYPES } from "@helios/widgets";
import type { ChannelMeta } from "@helios/store";
import type { TileSpec, WidgetType } from "../workspaces/types";
import { ConfirmDialog } from "./ConfirmDialog";

const WIDGET_TYPES = BUILTIN_WIDGET_TYPES as readonly WidgetType[];

interface Props {
  tile: TileSpec;
  onChange: (next: TileSpec) => void;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  availableChannels: ChannelMeta[];
}

export function ConfigPanel({ tile, onChange, onClose, onDuplicate, onDelete, availableChannels }: Props) {
  const widget = widgetRegistry.get(tile.widgetType);
  const Editor = widget.ConfigEditor;
  // Pending destructive widget-type change awaiting in-app confirmation.
  // Replaces the native window.confirm (which Tauri's webview renders poorly /
  // inconsistently) with the app's ConfirmDialog.
  const [pendingType, setPendingType] = useState<WidgetType | null>(null);

  function applyTypeChange(nextType: WidgetType) {
    const nextWidget = widgetRegistry.get(nextType);
    onChange({
      ...tile,
      widgetType: nextType,
      config: nextWidget.defaultConfig as TileSpec["config"],
    });
  }

  return (
    <aside className="w-72 flex-shrink-0 border-l border-[#2A2C32] bg-[#0E0E10] flex flex-col">
      <div className="h-8 flex items-center justify-between px-2 border-b border-[#2A2C32]">
        <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">Configure</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Duplicate tile"
            onClick={onDuplicate}
            title="Duplicate this tile"
            className="px-1.5 h-5 text-[10px] uppercase tracking-wider text-[#9097A0] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
          >
            duplicate
          </button>
          <button
            type="button"
            aria-label="Delete tile"
            onClick={onDelete}
            title="Delete this tile"
            className="px-1.5 h-5 text-[10px] uppercase tracking-wider text-[#9097A0] hover:text-[#EF5350] hover:bg-[#16171B] rounded-sm"
          >
            delete
          </button>
          <button
            type="button"
            aria-label="Close config"
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center text-[#9097A0] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
            title="Close"
          >
            ×
          </button>
        </div>
      </div>
      <div className="px-2 py-1.5 border-b border-[#2A2C32] flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[#9097A0] flex-shrink-0">type</span>
        <select
          value={tile.widgetType}
          onChange={(e) => {
            const nextType = e.target.value as WidgetType;
            if (nextType === tile.widgetType) return;
            setPendingType(nextType);
          }}
          className="flex-1 bg-[#16171B] text-[#FFC627] border border-[#2A2C32] rounded-sm px-1 py-0.5 text-xs focus:outline-none focus:border-[#FFC627] cursor-pointer"
        >
          {WIDGET_TYPES.map((t) => (
            <option key={t} value={t}>{widgetRegistry.get(t).label}</option>
          ))}
        </select>
      </div>
      <div className="px-2 py-1.5 border-b border-[#2A2C32] flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[#9097A0] flex-shrink-0">title</span>
        <input
          type="text"
          value={tile.title ?? ""}
          placeholder={widget.label}
          // Raw while typing (trimming per keystroke would eat mid-word
          // spaces); normalized on blur. Empty clears back to the label.
          onChange={(e) => onChange({ ...tile, title: e.target.value || undefined })}
          onBlur={() => {
            const t = (tile.title ?? "").trim();
            onChange({ ...tile, title: t || undefined });
          }}
          className="flex-1 min-w-0 bg-[#16171B] text-[#D8DCE2] border border-[#2A2C32] rounded-sm px-1 py-0.5 text-xs focus:outline-none focus:border-[#FFC627]"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        <Editor
          config={tile.config}
          onChange={(nextConfig) => onChange({ ...tile, config: nextConfig as TileSpec["config"] })}
          availableChannels={availableChannels}
        />
      </div>
      <div className="px-2 py-2 border-t border-[#2A2C32] text-[10px] text-[#9097A0]">
        Changes save automatically.
      </div>
      {pendingType && (
        <ConfirmDialog
          title="Change widget type?"
          body={
            <>
              Convert <span className="font-semibold">{tile.title ?? widget.label}</span> from{" "}
              {widget.label} to {widgetRegistry.get(pendingType).label}? Position and size
              are kept; the widget's config resets to its default channels and ranges.
            </>
          }
          confirmLabel="Convert"
          confirmTone="danger"
          cancelLabel="Cancel"
          onConfirm={() => applyTypeChange(pendingType)}
          onClose={() => setPendingType(null)}
        />
      )}
    </aside>
  );
}
