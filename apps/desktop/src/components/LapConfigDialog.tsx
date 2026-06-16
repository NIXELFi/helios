import { useEffect, useMemo, useRef, useState } from "react";
import type { ChannelMeta } from "@helios/store";
import type { GpsPickerEmitter, LapDetectionConfig, LapDetectionMode, LapSet } from "@helios/lib";
import { detectLaps, formatLapTime } from "@helios/lib";
import { ChannelPicker } from "@helios/widgets";
import { lapInputsFor } from "../lib/lap-config";
import type { LoadedSession } from "../lib/session";

const PICKER_REQUEST_ID = "lap-config-start-finish";

/** Coalesce a raw numeric-input value to a finite number, falling back to the
 *  previous value when the parse is NaN/Infinity. Prevents `Number("")`,
 *  `Number("abc")` and `Math.max(1, NaN)` from poisoning the stored config
 *  (which yields NaN radii / centers and, downstream, negative-duration laps).
 *  Exported for unit testing. */
export function coalesceNum(raw: number, prev: number): number {
  return Number.isFinite(raw) ? raw : prev;
}

/** Parse a textarea of newline/comma-separated seconds into a sorted, deduped
 *  array of microsecond crossings. Out-of-order or duplicate entries would
 *  otherwise produce negative-duration or zero-length laps. Exported for
 *  unit testing. */
export function parseManualCrossingsUs(text: string): number[] {
  const lines = text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const us = lines
    .map((s) => Math.round(Number(s) * 1_000_000))
    .filter((n) => Number.isFinite(n));
  // Sort ascending, then dedupe (a Set preserves insertion order, so sort first).
  return Array.from(new Set(us.sort((a, b) => a - b)));
}

interface Props {
  session: LoadedSession;
  gpsPickerEmitter: GpsPickerEmitter;
  onSave: (cfg: LapDetectionConfig) => void;
  onClose: () => void;
}

export function LapConfigDialog({ session, gpsPickerEmitter, onSave, onClose }: Props) {
  const [cfg, setCfg] = useState<LapDetectionConfig>(session.lapConfig);
  const inputs = useMemo(() => lapInputsFor(session.store), [session.store]);
  const channels = useMemo(() => session.store.list(), [session.store]);
  const dialogRef = useRef<HTMLDivElement>(null);

  // True while the GPS Track widget is awaiting our click. The dialog
  // collapses to a non-blocking banner during this window so the user can
  // actually see and interact with the GPS map underneath.
  const [picking, setPicking] = useState(false);
  // Receive the picked coordinate, fold it into config, restore dialog.
  useEffect(() => {
    return gpsPickerEmitter.subscribeResult((res) => {
      if (res.requestId !== PICKER_REQUEST_ID) return;
      setPicking(false);
      setCfg((c) => ({
        ...c,
        gpsLine: {
          ...(c.gpsLine ?? { latChannelId: "gps.lat", lonChannelId: "gps.lon", radiusM: 30 }),
          centerLat: res.lat, centerLon: res.lon,
        },
      }));
    });
  }, [gpsPickerEmitter]);
  // If the user cancels via Esc while picking, restore the dialog.
  useEffect(() => {
    return gpsPickerEmitter.subscribeState((req) => {
      if (req === null) setPicking(false);
    });
  }, [gpsPickerEmitter]);

  // Modal a11y: Escape-to-close, focus-trap, focus-restore. Inactive while
  // `picking` (the dialog is collapsed to a non-blocking banner then, and the
  // GPS map underneath must stay interactive — Esc there cancels the pick via
  // the picker's own state subscription above).
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    // Focus the dialog body on open so Tab cycling starts inside the trap and
    // Escape works even before the user clicks a field.
    dialogRef.current?.focus?.();
    function onKey(e: KeyboardEvent) {
      if (picking) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const root = dialogRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prevFocus?.focus?.();
    };
  }, [onClose, picking]);

  const preview: LapSet | null = useMemo(() => {
    if (cfg.mode === "none") return null;
    try { return detectLaps(cfg, inputs); } catch { return null; }
  }, [cfg, inputs]);

  function set<K extends keyof LapDetectionConfig>(k: K, v: LapDetectionConfig[K]) {
    setCfg((c) => ({ ...c, [k]: v }));
  }

  function startPick() {
    gpsPickerEmitter.begin({
      requestId: PICKER_REQUEST_ID,
      prompt: "Click the GPS track to set start-finish line",
    });
    setPicking(true);
  }

  // Picking mode: render a non-blocking banner instead of the modal so the
  // GPS Track widget below stays interactive. The dialog state survives
  // (we're still mounted) and re-asserts as soon as the click lands.
  if (picking) {
    return (
      <div
        className="fixed left-1/2 -translate-x-1/2 bottom-6 z-50 bg-[#FFC627] text-[#0E0E10] px-4 py-2 rounded-sm shadow-lg flex items-center gap-3 text-xs font-semibold"
      >
        <span>Click the GPS track to set start-finish line</span>
        <button
          type="button"
          onClick={() => { gpsPickerEmitter.cancel(); setPicking(false); }}
          className="px-2 py-0.5 bg-[#0E0E10] text-[#FFC627] hover:brightness-110 rounded-sm"
        >Cancel</button>
      </div>
    );
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Lap detection config" className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 helios-overlay-in" onClick={onClose}>
      <div ref={dialogRef} tabIndex={-1} className="bg-[#0E0E10] border border-[#2A2C32] rounded-md helios-elevate helios-modal-in w-[720px] max-h-[80vh] flex flex-col outline-none" onClick={(e) => e.stopPropagation()}>
        <div className="h-9 flex items-center justify-between px-3 border-b border-[#2A2C32]">
          <span className="text-xs uppercase tracking-wider text-[#FFC627]">Lap detection · {session.label}</span>
          <button type="button" aria-label="Close" onClick={onClose}
                  className="w-5 h-5 flex items-center justify-center text-[#9097A0] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 text-xs text-[#D8DCE2]">
          <Field label="Mode">
            <select value={cfg.mode} onChange={(e) => set("mode", e.target.value as LapDetectionMode)}
                    className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 cursor-pointer">
              <option value="none">None — single segment, untrusted</option>
              <option value="gps_line">GPS start-finish line</option>
              <option value="beacon">Beacon channel</option>
              <option value="expression">Expression</option>
              <option value="manual">Manual crossings</option>
            </select>
          </Field>

          {cfg.mode === "gps_line" && (
            <GpsLineEditor cfg={cfg} setCfg={setCfg} channels={channels} onPickFromMap={startPick} />
          )}
          {cfg.mode === "beacon" && (
            <BeaconEditor cfg={cfg} setCfg={setCfg} channels={channels} />
          )}
          {cfg.mode === "expression" && (
            <ExpressionEditor cfg={cfg} setCfg={setCfg} />
          )}
          {cfg.mode === "manual" && (
            <ManualEditor cfg={cfg} setCfg={setCfg} />
          )}

          <Field label="Speed channel" hint="Used to integrate distance per lap. Optional.">
            <ChannelPicker channels={channels} value={cfg.speedChannelId ?? ""} allowEmpty
                           onChange={(v) => set("speedChannelId", v || undefined)} />
          </Field>

          <div className="border-t border-[#2A2C32] pt-3 mt-2">
            <div className="text-[10px] uppercase tracking-wider text-[#9097A0] mb-2">Preview</div>
            {preview ? (
              <PreviewTable set={preview} />
            ) : (
              <div className="text-[#9097A0] text-[11px]">{cfg.mode === "none" ? "no detection — entire session is one untrusted lap" : "(no preview)"}</div>
            )}
          </div>
        </div>

        <div className="px-3 py-2 border-t border-[#2A2C32] flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1 text-xs text-[#9097A0] hover:text-[#D8DCE2]">Cancel</button>
          <button type="button" onClick={() => { onSave(cfg); onClose(); }}
                  className="px-3 py-1 text-xs bg-[#FFC627] text-[#0E0E10] font-semibold hover:brightness-110">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] uppercase tracking-wider text-[#9097A0]">{label}</label>
      {children}
      {hint && <span className="text-[10px] text-[#5A5F66]">{hint}</span>}
    </div>
  );
}

function GpsLineEditor({ cfg, setCfg, channels, onPickFromMap }: {
  cfg: LapDetectionConfig;
  setCfg: (f: (prev: LapDetectionConfig) => LapDetectionConfig) => void;
  channels: ChannelMeta[];
  onPickFromMap: () => void;
}) {
  const g = cfg.gpsLine ?? { latChannelId: "gps.lat", lonChannelId: "gps.lon", centerLat: 0, centerLon: 0, radiusM: 30 };
  function setG<K extends keyof typeof g>(k: K, v: (typeof g)[K]) {
    setCfg((c) => ({ ...c, gpsLine: { ...g, [k]: v } }));
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Lat channel">
        <ChannelPicker channels={channels} value={g.latChannelId} onChange={(v) => setG("latChannelId", v)} />
      </Field>
      <Field label="Lon channel">
        <ChannelPicker channels={channels} value={g.lonChannelId} onChange={(v) => setG("lonChannelId", v)} />
      </Field>
      <div className="col-span-2 flex items-end gap-2">
        <Field label="Center latitude">
          <input type="number" step="0.0000001" value={g.centerLat}
                 onChange={(e) => setG("centerLat", coalesceNum(Number(e.target.value), g.centerLat))}
                 className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 font-mono-num w-full" />
        </Field>
        <Field label="Center longitude">
          <input type="number" step="0.0000001" value={g.centerLon}
                 onChange={(e) => setG("centerLon", coalesceNum(Number(e.target.value), g.centerLon))}
                 className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 font-mono-num w-full" />
        </Field>
        <button
          type="button"
          onClick={onPickFromMap}
          className="h-[30px] px-3 bg-[#16171B] border border-[#FFC627] text-[#FFC627] hover:bg-[#FFC627] hover:text-[#0E0E10] text-[11px] font-semibold whitespace-nowrap"
          title="Click on the GPS track widget to set the center"
        >Pick from map</button>
      </div>
      <Field label="Radius (m)" hint="half-width of the start-finish line; smaller = stricter">
        <input type="number" min={1} step={1} value={g.radiusM}
               onChange={(e) => setG("radiusM", Math.max(1, coalesceNum(Number(e.target.value), g.radiusM)))}
               className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 font-mono-num" />
      </Field>
      <Field label="Heading (deg, optional)" hint="0=N, 90=E. Filters wrong-direction crossings.">
        <input type="number" min={0} max={360} value={g.headingDeg ?? ""}
               onChange={(e) => setG("headingDeg", e.target.value === "" ? undefined : coalesceNum(Number(e.target.value), g.headingDeg ?? 0))}
               className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 font-mono-num" />
      </Field>
    </div>
  );
}

function BeaconEditor({ cfg, setCfg, channels }: { cfg: LapDetectionConfig; setCfg: (f: (prev: LapDetectionConfig) => LapDetectionConfig) => void; channels: ChannelMeta[] }) {
  const b = cfg.beacon ?? { channelId: "system.beacon", threshold: 0.5 };
  function setB<K extends keyof typeof b>(k: K, v: (typeof b)[K]) {
    setCfg((c) => ({ ...c, beacon: { ...b, [k]: v } }));
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Beacon channel" hint="Rising edges count as crossings.">
        <ChannelPicker channels={channels} value={b.channelId} onChange={(v) => setB("channelId", v)} />
      </Field>
      <Field label="Threshold">
        <input type="number" step="0.1" value={b.threshold}
               onChange={(e) => setB("threshold", coalesceNum(Number(e.target.value), b.threshold))}
               className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 font-mono-num" />
      </Field>
    </div>
  );
}

function ExpressionEditor({ cfg, setCfg }: { cfg: LapDetectionConfig; setCfg: (f: (prev: LapDetectionConfig) => LapDetectionConfig) => void }) {
  const e = cfg.expression ?? { expression: "" };
  function setE(v: string) { setCfg((c) => ({ ...c, expression: { expression: v } })); }
  return (
    <Field label="Expression" hint="Boolean expression in Helios math syntax. Each rising edge of (expr ≠ 0) is a crossing.">
      <textarea value={e.expression} onChange={(ev) => setE(ev.target.value)} rows={4}
                spellCheck={false}
                placeholder="e.g. gps.speed < 5 && previous_sample(gps.speed, 0) >= 5"
                className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 font-mono-num resize-y" />
    </Field>
  );
}

function ManualEditor({ cfg, setCfg }: { cfg: LapDetectionConfig; setCfg: (f: (prev: LapDetectionConfig) => LapDetectionConfig) => void }) {
  const m = cfg.manual ?? { crossingsUs: [] };
  const text = m.crossingsUs.map((u) => (u / 1_000_000).toFixed(3)).join("\n");
  function setText(t: string) {
    const us = parseManualCrossingsUs(t);
    setCfg((c) => ({ ...c, manual: { crossingsUs: us } }));
  }
  return (
    <Field label="Crossings (seconds, one per line)" hint="Each entry is a timestamp at the start-finish line.">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6}
                placeholder="12.45&#10;72.10&#10;131.85" spellCheck={false}
                className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 font-mono-num resize-y" />
    </Field>
  );
}

function PreviewTable({ set }: { set: LapSet }) {
  if (set.laps.length === 0) {
    return <div className="text-[#FFB800] text-[11px]">no crossings detected — try a wider radius or a different channel</div>;
  }
  const trusted = set.laps.filter((l) => l.trusted);
  const best = set.bestLapIndex >= 0 ? set.laps[set.bestLapIndex]! : null;
  return (
    <div className="text-[11px]">
      <div className="text-[#9AA0A6] mb-2">
        {trusted.length} trusted lap{trusted.length === 1 ? "" : "s"}
        {best && <> · best <span className="text-[#FFC627]">{formatLapTime(best.durationS * 1_000_000)}</span></>}
      </div>
      <div className="max-h-40 overflow-y-auto border border-[#2A2C32]">
        <table className="w-full font-mono-num">
          <thead className="text-[#9097A0] text-[9px] uppercase tracking-wider sticky top-0 bg-[#0E0E10]">
            <tr><th className="text-left px-2 py-0.5">#</th><th className="text-right px-2 py-0.5">Time</th><th className="text-right px-2 py-0.5">Distance</th><th className="text-left px-2 py-0.5">Trust</th></tr>
          </thead>
          <tbody>
            {set.laps.map((l, i) => (
              <tr key={i} className={"border-b border-[#23252B] " + (l.trusted ? "text-[#D8DCE2]" : "text-[#5A5F66]")}>
                <td className="px-2 py-0.5">{l.index}</td>
                <td className="text-right px-2 py-0.5">{formatLapTime(l.durationS * 1_000_000)}</td>
                <td className="text-right px-2 py-0.5">{Number.isFinite(l.distanceM) ? `${(l.distanceM / 1000).toFixed(2)} km` : "—"}</td>
                <td className="px-2 py-0.5 text-[10px]">{l.trusted ? "trusted" : "out/in"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
