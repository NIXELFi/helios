import { useMemo, useRef, useState } from "react";
import type { ChannelMeta } from "@helios/store";
import { MATH_BUILTINS } from "@helios/lib";
import {
  type MathChannel, defaultMathChannel, isValidMathChannelId, checkExpression,
} from "../lib/math-channels";
import { VECTOR_OPS, LAP_OPS } from "../lib/vector-ops";

interface Props {
  channels: MathChannel[];
  errors: Map<string, string>;
  availableChannels: ChannelMeta[];
  onChange: (next: MathChannel[]) => void;
  onClose: () => void;
}

export function MathChannelsModal({
  channels, errors, availableChannels, onChange, onClose,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(channels[0]?.id ?? null);
  const selected = channels.find((c) => c.id === selectedId) ?? null;
  const availableSet = useMemo(() => new Set(availableChannels.map((c) => c.id)), [availableChannels]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function add() {
    const fresh = defaultMathChannel(channels.map((c) => c.id));
    onChange([...channels, fresh]);
    setSelectedId(fresh.id);
  }

  function update(next: MathChannel) {
    const oldId = selectedId ?? next.id;
    onChange(channels.map((c) => (c.id === oldId ? next : c)));
    setSelectedId(next.id);
  }

  function remove(id: string) {
    if (!confirm(`Delete math channel "${id}"?`)) return;
    onChange(channels.filter((c) => c.id !== id));
    if (selectedId === id) {
      setSelectedId(channels.find((c) => c.id !== id)?.id ?? null);
    }
  }

  /** Insert text into the expression textarea at the cursor (or replace
   *  selection). Triggered by clicking palette items. */
  function insertAtCursor(text: string) {
    if (!selected) return;
    const ta = textareaRef.current;
    const expr = selected.expression;
    const start = ta?.selectionStart ?? expr.length;
    const end = ta?.selectionEnd ?? expr.length;
    const next = expr.slice(0, start) + text + expr.slice(end);
    update({ ...selected, expression: next });
    // Move caret to just after the inserted text on the next tick.
    setTimeout(() => {
      const t = textareaRef.current;
      if (!t) return;
      const pos = start + text.length;
      t.focus();
      t.setSelectionRange(pos, pos);
    }, 0);
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-[#0E0E10] border border-[#2A2C32] w-[1180px] h-[720px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-9 flex items-center justify-between px-3 border-b border-[#2A2C32]">
          <span className="text-xs uppercase tracking-wider text-[#FFC627]">ƒ Math Channels</span>
          <button
            aria-label="Close"
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center text-[#7B8088] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
          >×</button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Channel list */}
          <aside className="w-52 flex-shrink-0 border-r border-[#2A2C32] flex flex-col">
            <div className="px-2 py-1 border-b border-[#2A2C32] flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-[#7B8088]">{channels.length} defined</span>
              <button
                onClick={add}
                className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#FFC627] hover:bg-[#16171B] rounded-sm cursor-pointer"
              >+ add</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {channels.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-[#7B8088]">
                  No math channels yet. Click <span className="text-[#FFC627]">+ add</span>.
                </div>
              )}
              {channels.map((c) => {
                const hasError = errors.has(c.id);
                const isSelected = c.id === selectedId;
                return (
                  <div
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={
                      "px-2 py-1.5 cursor-pointer flex items-center gap-2 text-xs " +
                      (isSelected ? "bg-[#16171B]" : "hover:bg-[#16171B]")
                    }
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                      style={{ background: c.color }}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">
                      <span className="font-mono-num text-[#FFC627]">{c.id}</span>
                      <br />
                      <span className="text-[10px] text-[#7B8088]">{c.display_name}</span>
                    </span>
                    {hasError && (
                      <span title={errors.get(c.id)} className="text-[#EF5350] flex-shrink-0">!</span>
                    )}
                  </div>
                );
              })}
            </div>
          </aside>

          {/* Token palette: drag or click to insert into the expression. */}
          <Palette
            channels={availableChannels}
            disabled={!selected}
            onInsert={insertAtCursor}
          />

          {/* Editor pane */}
          <main className="flex-1 overflow-y-auto">
            {selected
              ? <Editor
                  channel={selected}
                  errorFromApply={errors.get(selected.id)}
                  availableSet={availableSet}
                  textareaRef={textareaRef}
                  onChange={update}
                  onDelete={() => remove(selected.id)}
                />
              : <div className="p-6 text-xs text-[#7B8088]">Select a math channel from the list, or click + add to create one.</div>
            }
          </main>
        </div>

        <div className="px-3 py-2 border-t border-[#2A2C32] text-[10px] text-[#7B8088]">
          Drag tokens from the palette into the expression box, or click them to insert at the cursor.
        </div>
      </div>
    </div>
  );
}

interface PaletteProps {
  channels: ChannelMeta[];
  disabled: boolean;
  onInsert: (text: string) => void;
}

function Palette({ channels, disabled, onInsert }: PaletteProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({
    Channels: true, Operators: true, Functions: true, "Time ops": true, Constants: true,
  });
  function toggle(name: string) { setOpen((p) => ({ ...p, [name]: !p[name] })); }

  // Group channels by ChannelMeta.group for readability.
  const channelsByGroup = useMemo(() => {
    const map = new Map<string, ChannelMeta[]>();
    for (const c of [...channels].sort((a, b) => a.id.localeCompare(b.id))) {
      const list = map.get(c.group) ?? [];
      list.push(c);
      map.set(c.group, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [channels]);

  return (
    <aside className="w-60 flex-shrink-0 border-r border-[#2A2C32] flex flex-col bg-[#0B0B0D]">
      <div className="px-2 py-1 border-b border-[#2A2C32]">
        <span className="text-[10px] uppercase tracking-wider text-[#7B8088]">Palette</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <Section title="Channels" open={open["Channels"] ?? true} onToggle={() => toggle("Channels")}>
          {channelsByGroup.length === 0 && (
            <div className="px-3 py-1 text-[10px] text-[#7B8088]">No channels in primary session.</div>
          )}
          {channelsByGroup.map(([group, list]) => (
            <div key={group} className="mb-1">
              <div className="px-3 py-0.5 text-[9px] uppercase tracking-wider text-[#5A5F66]">{group}</div>
              {list.map((c) => (
                <Token
                  key={c.id}
                  text={c.id}
                  insert={c.id}
                  disabled={disabled}
                  onInsert={onInsert}
                  swatch={c.color}
                  hint={c.display_name && c.display_name !== c.id ? c.display_name : undefined}
                />
              ))}
            </div>
          ))}
        </Section>

        <Section title="Operators" open={open["Operators"] ?? true} onToggle={() => toggle("Operators")}>
          <div className="px-3 py-1 grid grid-cols-4 gap-1">
            {["+", "-", "*", "/", "%", "^", "(", ")",
              "<", ">", "<=", ">=", "==", "!=", "&&", "||", "!", "?", ":"]
              .map((op) => (
                <ChipToken key={op} disabled={disabled} text={op} insert={op === "?" || op === ":" ? op + " " : ` ${op} `} onInsert={onInsert} />
              ))}
          </div>
        </Section>

        <Section title="Functions" open={open["Functions"] ?? true} onToggle={() => toggle("Functions")}>
          {MATH_BUILTINS.functions.map((fn) => (
            <Token
              key={fn}
              text={`${fn}(…)`}
              insert={`${fn}(`}
              disabled={disabled}
              onInsert={onInsert}
              hint={functionHint(fn)}
            />
          ))}
        </Section>

        <Section title="Time ops" open={open["Time ops"] ?? true} onToggle={() => toggle("Time ops")}>
          {[...VECTOR_OPS].map((fn) => (
            <Token
              key={fn}
              text={`${fn}(${vectorOpSig(fn)})`}
              insert={`${fn}(`}
              disabled={disabled}
              onInsert={onInsert}
              hint={vectorOpHint(fn)}
            />
          ))}
          {[...LAP_OPS].map((fn) => (
            <Token
              key={fn}
              text={`${fn}(…)`}
              insert={`${fn}(`}
              disabled={disabled}
              onInsert={onInsert}
              hint="needs lap detection (future)"
              warning
            />
          ))}
        </Section>

        <Section title="Constants" open={open["Constants"] ?? true} onToggle={() => toggle("Constants")}>
          {MATH_BUILTINS.constants.map((c) => (
            <Token
              key={c}
              text={c}
              insert={c}
              disabled={disabled}
              onInsert={onInsert}
              hint={c === "pi" ? "π ≈ 3.14159…" : "e ≈ 2.71828…"}
            />
          ))}
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, open, onToggle, children }: {
  title: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="border-b border-[#16171B]">
      <button
        onClick={onToggle}
        className="w-full px-2 py-1 text-left text-[10px] uppercase tracking-wider text-[#7B8088] hover:text-[#FFC627] hover:bg-[#16171B] flex items-center justify-between"
      >
        <span>{title}</span>
        <span className="text-[#5A5F66]">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

interface TokenProps {
  text: string;
  insert: string;
  hint?: string;
  swatch?: string;
  warning?: boolean;
  disabled: boolean;
  onInsert: (text: string) => void;
}

function Token({ text, insert, hint, swatch, warning, disabled, onInsert }: TokenProps) {
  return (
    <div
      draggable={!disabled}
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", insert); e.dataTransfer.effectAllowed = "copy"; }}
      onClick={() => !disabled && onInsert(insert)}
      className={
        "px-3 py-0.5 text-[11px] flex items-center gap-1.5 truncate "
        + (disabled
          ? "text-[#5A5F66] cursor-not-allowed"
          : "text-[#D8DCE2] hover:bg-[#16171B] hover:text-[#FFC627] cursor-grab active:cursor-grabbing")
      }
      title={hint}
    >
      {swatch && (
        <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: swatch }} aria-hidden />
      )}
      <span className={"font-mono-num truncate " + (warning ? "text-[#FFB800]" : "")}>{text}</span>
      {hint && !swatch && <span className="ml-auto text-[9px] text-[#5A5F66] truncate">{hint}</span>}
    </div>
  );
}

function ChipToken({ text, insert, disabled, onInsert }: TokenProps) {
  return (
    <button
      draggable={!disabled}
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", insert); e.dataTransfer.effectAllowed = "copy"; }}
      onClick={() => !disabled && onInsert(insert)}
      disabled={disabled}
      className={
        "h-6 text-[11px] font-mono-num bg-[#16171B] border border-[#2A2C32] rounded-sm "
        + (disabled
          ? "text-[#5A5F66] cursor-not-allowed"
          : "text-[#D8DCE2] hover:border-[#FFC627] hover:text-[#FFC627] cursor-grab active:cursor-grabbing")
      }
    >{text}</button>
  );
}

function functionHint(name: string): string {
  switch (name) {
    case "abs": return "|x|";
    case "sqrt": return "√x";
    case "sin": case "cos": case "tan": return "x in radians";
    case "asin": case "acos": case "atan": return "→ radians";
    case "atan2": return "atan2(y, x)";
    case "min": case "max": return "(a, b, …)";
    case "pow": return "pow(b, e)";
    case "exp": return "e^x";
    case "log": case "ln": return "natural log";
    case "log10": return "log base 10";
    case "floor": case "ceil": case "round": case "sign": return "(x)";
    default: return "";
  }
}

function vectorOpSig(name: string): string {
  switch (name) {
    case "derivative": return "x";
    case "integral":   return "x";
    case "shift":      return "x, dt";
    case "smooth":     return "x, n";
    case "lowpass":    return "x, fc";
    default:           return "…";
  }
}

function vectorOpHint(name: string): string {
  switch (name) {
    case "derivative": return "d/dt of x";
    case "integral":   return "∫ x dt cumulative";
    case "shift":      return "shift x by dt seconds";
    case "smooth":     return "moving avg over n samples";
    case "lowpass":    return "first-order LPF, fc Hz";
    default:           return "";
  }
}

interface EditorProps {
  channel: MathChannel;
  errorFromApply: string | undefined;
  availableSet: Set<string>;
  textareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  onChange: (next: MathChannel) => void;
  onDelete: () => void;
}

function Editor({
  channel, errorFromApply, availableSet, textareaRef, onChange, onDelete,
}: EditorProps) {
  const check = useMemo(() => checkExpression(channel.expression), [channel.expression]);
  const unknownRefs = check.ok
    ? check.refs.filter((r) => !availableSet.has(r) && !MATH_BUILTINS.constants.includes(r))
    : [];
  const idValid = isValidMathChannelId(channel.id);

  function set<K extends keyof MathChannel>(key: K, value: MathChannel[K]) {
    onChange({ ...channel, [key]: value });
  }

  return (
    <div className="p-4 flex flex-col gap-3 text-xs text-[#D8DCE2]">
      <div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-2 items-center">
        <label className="text-[10px] uppercase tracking-wider text-[#7B8088]">id</label>
        <div className="flex items-center gap-2">
          <input
            value={channel.id}
            onChange={(e) => set("id", e.target.value)}
            className={
              "flex-1 bg-[#16171B] border px-2 py-1 font-mono-num text-[#FFC627] focus:outline-none "
              + (idValid ? "border-[#2A2C32] focus:border-[#FFC627]" : "border-[#EF5350]")
            }
          />
          {!idValid && <span className="text-[10px] text-[#EF5350]">id must match [a-zA-Z_][a-zA-Z0-9_.]*</span>}
        </div>

        <label className="text-[10px] uppercase tracking-wider text-[#7B8088]">name</label>
        <input
          value={channel.display_name}
          onChange={(e) => set("display_name", e.target.value)}
          className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 focus:outline-none focus:border-[#FFC627]"
        />

        <label className="text-[10px] uppercase tracking-wider text-[#7B8088]">units</label>
        <input
          value={channel.units}
          onChange={(e) => set("units", e.target.value)}
          className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 focus:outline-none focus:border-[#FFC627]"
        />

        <label className="text-[10px] uppercase tracking-wider text-[#7B8088]">decimals</label>
        <input
          type="number" min={0} max={6}
          value={channel.decimals}
          onChange={(e) => set("decimals", Number(e.target.value))}
          className="w-20 bg-[#16171B] border border-[#2A2C32] px-2 py-1 focus:outline-none focus:border-[#FFC627]"
        />

        <label className="text-[10px] uppercase tracking-wider text-[#7B8088]">color</label>
        <input
          type="color"
          value={channel.color}
          onChange={(e) => set("color", e.target.value)}
          className="w-12 h-7 bg-[#16171B] border border-[#2A2C32] cursor-pointer"
        />

        <label className="text-[10px] uppercase tracking-wider text-[#7B8088]">group</label>
        <input
          value={channel.group}
          onChange={(e) => set("group", e.target.value)}
          className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 focus:outline-none focus:border-[#FFC627]"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] uppercase tracking-wider text-[#7B8088]">expression</label>
        <textarea
          ref={textareaRef}
          value={channel.expression}
          onChange={(e) => set("expression", e.target.value)}
          rows={5}
          spellCheck={false}
          className={
            "bg-[#16171B] border px-2 py-1.5 font-mono-num text-[#D8DCE2] resize-y focus:outline-none "
            + (check.ok ? "border-[#2A2C32] focus:border-[#FFC627]" : "border-[#EF5350]")
          }
          placeholder="e.g. derivative(engine.rpm) or smooth(imu.lat_g, 21)"
        />
        {!check.ok && (
          <div className="text-[10px] text-[#EF5350]">{check.error}</div>
        )}
        {check.ok && unknownRefs.length > 0 && (
          <div className="text-[10px] text-[#FFB800]">
            Unknown channel(s): {unknownRefs.map((r) => `"${r}"`).join(", ")}.
            Will evaluate to NaN unless this session has them.
          </div>
        )}
        {check.ok && errorFromApply && (
          <div className="text-[10px] text-[#EF5350]">Apply error: {errorFromApply}</div>
        )}
        {check.ok && check.refs.length > 0 && unknownRefs.length === 0 && (
          <div className="text-[10px] text-[#7B8088]">References: {check.refs.join(", ")}</div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <NumberField label="min" value={channel.min} onChange={(v) => set("min", v)} />
        <NumberField label="max" value={channel.max} onChange={(v) => set("max", v)} />
        <NumberField label="warn" value={channel.warn} onChange={(v) => set("warn", v)} />
        <NumberField label="alarm" value={channel.alarm} onChange={(v) => set("alarm", v)} />
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-[#2A2C32] mt-2">
        <button
          onClick={onDelete}
          className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#7B8088] hover:text-[#EF5350] hover:bg-[#16171B] rounded-sm cursor-pointer"
        >Delete</button>
        <span className="text-[10px] text-[#7B8088]">Edits save automatically.</span>
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange }: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-[#7B8088] w-12">{label}</span>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className="flex-1 bg-[#16171B] border border-[#2A2C32] px-2 py-1 focus:outline-none focus:border-[#FFC627]"
      />
    </label>
  );
}
