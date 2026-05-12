import { useMemo, useRef, useState, useEffect } from "react";
import type { ChannelMeta } from "@helios/store";

interface SourceHeaderEntry {
  sourceHeader: string;
  channelId: string;
  displayName: string;
}

interface Props {
  channels: ChannelMeta[];
  sessionLabel: string;
  /** Every source CSV column known to the session, in alphabetical order. */
  sourceHeaders: SourceHeaderEntry[];
  /** Canonical id → source_header currently overriding it (auto when absent). */
  overrides: Record<string, string>;
  /** Called when the user picks a new source for a canonical channel, or
   *  passes `null` to reset that canonical back to auto-resolution. */
  onOverrideChange: (canonicalId: string, sourceHeader: string | null) => void;
  onClose: () => void;
}

/** Inspector for every channel resolved in the primary session.
 *  Lets the user search/filter, inspect metadata, AND remap a canonical
 *  channel id to a different source CSV column when the auto-resolver picks
 *  the wrong one for a per-vehicle quirk.
 *
 *  The Source column is the click target: clicking it opens a small picker
 *  listing every source CSV header in the session plus a "Reset to auto"
 *  option. Subtle when the channel is on auto-resolution; highlighted with
 *  a yellow badge when an override is active so the user can see at a glance
 *  which channels are non-default. */
export function ChannelsModal({
  channels, sessionLabel, sourceHeaders, overrides, onOverrideChange, onClose,
}: Props) {
  const [filter, setFilter] = useState("");
  const [openPickerFor, setOpenPickerFor] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = !f ? channels : channels.filter((c) =>
      c.id.toLowerCase().includes(f)
      || c.display_name.toLowerCase().includes(f)
      || c.group.toLowerCase().includes(f)
      || (c.source_header?.toLowerCase().includes(f) ?? false)
    );
    const out = new Map<string, ChannelMeta[]>();
    for (const c of [...filtered].sort((a, b) => a.id.localeCompare(b.id))) {
      const list = out.get(c.group) ?? [];
      list.push(c);
      out.set(c.group, list);
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [channels, filter]);

  const totalShown = grouped.reduce((s, [, list]) => s + list.length, 0);
  const overrideCount = Object.keys(overrides).length;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-[#0E0E10] border border-[#2A2C32] w-[860px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-9 flex items-center justify-between px-3 border-b border-[#2A2C32]">
          <span className="text-xs uppercase tracking-wider text-[#FFC627]">Channels</span>
          <span className="text-[11px] text-[#7B8088]">{sessionLabel}</span>
          <button
            aria-label="Close"
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center text-[#7B8088] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
          >×</button>
        </div>
        <div className="px-3 py-2 border-b border-[#2A2C32] flex items-center gap-2">
          <input
            type="text"
            placeholder="filter by id, name, group, or source…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="flex-1 bg-[#16171B] border border-[#2A2C32] rounded-sm px-2 py-1 text-xs text-[#D8DCE2] focus:outline-none focus:border-[#FFC627]"
          />
          <span className="text-[10px] text-[#7B8088]">
            {totalShown} / {channels.length}
            {overrideCount > 0 && (
              <>
                {" · "}
                <span className="text-[#FFC627]">{overrideCount} overridden</span>
              </>
            )}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-xs text-[#D8DCE2]">
            <thead className="sticky top-0 bg-[#0E0E10] border-b border-[#2A2C32]">
              <tr className="text-[10px] uppercase tracking-wider text-[#7B8088]">
                <th className="text-left px-2 py-1 w-2"></th>
                <th className="text-left px-2 py-1">id</th>
                <th className="text-left px-2 py-1">display name</th>
                <th className="text-left px-2 py-1">source</th>
                <th className="text-left px-2 py-1">units</th>
                <th className="text-right px-2 py-1">rate</th>
                <th className="text-right px-2 py-1">min</th>
                <th className="text-right px-2 py-1">max</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(([group, list]) => (
                <>
                  <tr key={`g-${group}`} className="bg-[#16171B]">
                    <td colSpan={8} className="px-2 py-1 text-[10px] uppercase tracking-wider text-[#7B8088]">{group}</td>
                  </tr>
                  {list.map((c) => {
                    const overrideTarget = overrides[c.id];
                    const isOverridden = overrideTarget !== undefined;
                    // The "auto" source label is the channel's own
                    // source_header (or em-dash for math channels with none).
                    const autoLabel = c.source_header ?? "—";
                    // The shown source label reflects the active override if
                    // any, else the auto resolution.
                    const shownLabel = overrideTarget ?? autoLabel;
                    const canOverride =
                      c.source_header !== undefined && sourceHeaders.length > 0;
                    return (
                      <tr key={c.id} className="border-b border-[#16171B] hover:bg-[#16171B]">
                        <td className="px-2 py-1">
                          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: c.color }} />
                        </td>
                        <td className="px-2 py-1 font-mono-num text-[#FFC627]">{c.id}</td>
                        <td className="px-2 py-1">{c.display_name}</td>
                        <td className="px-2 py-1 relative">
                          {canOverride ? (
                            <SourcePicker
                              currentLabel={shownLabel}
                              autoLabel={autoLabel}
                              isOverridden={isOverridden}
                              isOpen={openPickerFor === c.id}
                              onOpen={() => setOpenPickerFor(c.id)}
                              onClose={() => setOpenPickerFor(null)}
                              sourceHeaders={sourceHeaders}
                              onPick={(sh) => {
                                onOverrideChange(c.id, sh);
                                setOpenPickerFor(null);
                              }}
                            />
                          ) : (
                            <span className="text-[#7B8088]">{shownLabel}</span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-[#7B8088]">{c.units || "—"}</td>
                        <td className="px-2 py-1 font-mono-num text-right text-[#7B8088]">{c.sample_rate_hz} Hz</td>
                        <td className="px-2 py-1 font-mono-num text-right text-[#7B8088]">{c.min ?? "—"}</td>
                        <td className="px-2 py-1 font-mono-num text-right text-[#7B8088]">{c.max ?? "—"}</td>
                      </tr>
                    );
                  })}
                </>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2 border-t border-[#2A2C32] text-[10px] text-[#7B8088]">
          Click a source cell to rebind the canonical channel to a different CSV column.
          {" "}Overrides are per-session and survive app restart.
        </div>
      </div>
    </div>
  );
}

interface SourcePickerProps {
  currentLabel: string;
  autoLabel: string;
  isOverridden: boolean;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  sourceHeaders: SourceHeaderEntry[];
  onPick: (sourceHeader: string | null) => void;
}

function SourcePicker({
  currentLabel, autoLabel, isOverridden, isOpen, onOpen, onClose,
  sourceHeaders, onPick,
}: SourcePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on click-outside. Listening on the modal's whole document avoids
  // having to plumb a global click-handler through the parent; we stop
  // propagation on the button below so clicking it doesn't immediately
  // close what it just opened.
  useEffect(() => {
    if (!isOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [isOpen, onClose]);

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={(e) => {
          e.stopPropagation();
          if (isOpen) onClose(); else onOpen();
        }}
        className={
          "text-left px-1.5 py-0.5 rounded-sm border text-[11px] font-mono-num " +
          (isOverridden
            ? "bg-[#1B1A14] text-[#FFC627] border-[#FFC627]/40 hover:border-[#FFC627]"
            : "bg-transparent text-[#7B8088] border-transparent hover:border-[#2A2C32] hover:text-[#D8DCE2]")
        }
        title={
          isOverridden
            ? `Overridden — auto would pick "${autoLabel}". Click to change.`
            : "Click to bind a different source column"
        }
      >
        {currentLabel}
        {isOverridden && <span className="ml-1 text-[9px] uppercase tracking-wider">·override</span>}
      </button>
      {isOpen && (
        <div
          role="listbox"
          className="absolute z-50 top-full left-0 mt-1 w-[260px] max-h-[280px] overflow-y-auto bg-[#0E0E10] border border-[#2A2C32] shadow-lg"
        >
          <button
            type="button"
            role="option"
            aria-selected={!isOverridden}
            onClick={(e) => {
              e.stopPropagation();
              onPick(null);
            }}
            className="block w-full text-left px-2 py-1 text-[11px] text-[#D8DCE2] hover:bg-[#16171B] border-b border-[#2A2C32]"
          >
            <span className="text-[#FFC627]">Reset to auto</span>
            <span className="ml-1 text-[10px] text-[#7B8088]">({autoLabel})</span>
          </button>
          {sourceHeaders.map((h) => (
            <button
              key={h.sourceHeader}
              type="button"
              role="option"
              aria-selected={currentLabel === h.sourceHeader}
              onClick={(e) => {
                e.stopPropagation();
                onPick(h.sourceHeader);
              }}
              className={
                "block w-full text-left px-2 py-1 text-[11px] hover:bg-[#16171B] " +
                (currentLabel === h.sourceHeader
                  ? "text-[#FFC627]"
                  : "text-[#D8DCE2]")
              }
            >
              <div className="font-mono-num">{h.sourceHeader}</div>
              <div className="text-[10px] text-[#7B8088]">→ {h.channelId}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
