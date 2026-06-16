import { useEffect, useMemo, useRef, useState } from "react";
import type { ChannelMeta } from "@helios/store";
import { MATH_BUILTINS } from "@helios/lib";
import {
  type MathChannel, defaultMathChannel, isValidMathChannelId, checkExpression,
  normalizeChannelId,
} from "../lib/math-channels";
import { VECTOR_OPS, LAP_OPS } from "../lib/vector-ops";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  channels: MathChannel[];
  errors: Map<string, string>;
  availableChannels: ChannelMeta[];
  onChange: (next: MathChannel[]) => void;
  onClose: () => void;
}

/** Assigns a process-stable React key to each math-channel object so list
 *  rendering and selection survive the editable `id` changing (and never
 *  collide when two channels briefly share an id during editing). Keyed by
 *  object identity, so re-renders of the same channel object reuse the key. */
function useStableKeys() {
  const map = useRef(new WeakMap<MathChannel, string>());
  const counter = useRef(0);
  return (c: MathChannel): string => {
    let k = map.current.get(c);
    if (!k) {
      k = `mc-${counter.current++}`;
      map.current.set(c, k);
    }
    return k;
  };
}

export function MathChannelsModal({
  channels, errors, availableChannels, onChange, onClose,
}: Props) {
  // Selection is tracked by the channel's array index rather than its editable
  // id: ids can change as the user types and can transiently collide, so an
  // id-based key is not a stable handle.
  const [selectedIdx, setSelectedIdx] = useState<number>(channels.length > 0 ? 0 : -1);
  const selected = channels[selectedIdx] ?? null;
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const keyOf = useStableKeys();
  const dialogRef = useRef<HTMLDivElement>(null);

  // X2 — Escape-to-close + focus-trap + focus-restore (mirrors ConfirmDialog).
  // The trap/Escape are suppressed while the in-app delete confirm is open so
  // its own Escape wins.
  const trapActive = pendingDelete === null;
  // MathChannelsModal focus recapture — `onClose` is a fresh closure each parent
  // render and `trapActive` toggles whenever the nested delete-confirm opens.
  // Read both through refs so the keydown effect can stay mount-only ([]):
  // otherwise the effect re-runs on every parent render and whenever the confirm
  // toggles, recapturing `restoreTo` (the focus-restore target) from the wrong
  // moment and re-stealing focus.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const trapActiveRef = useRef(trapActive);
  trapActiveRef.current = trapActive;
  useEffect(() => {
    // Captured once on mount: the element to restore focus to on unmount.
    const restoreTo = document.activeElement as HTMLElement | null;
    function onKey(e: KeyboardEvent) {
      // While the delete-confirm is open, let ITS handler own the keyboard.
      if (!trapActiveRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab") {
        const root = dialogRef.current;
        if (!root) return;
        const focusable = root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreTo?.focus?.();
    };
    // Mount-only: onClose + trapActive read via refs so a parent re-render or a
    // confirm toggle doesn't recapture restoreTo / re-subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const availableSet = useMemo(() => {
    // Both an exact-id set and a normalized lookup so the modal's unknown
    // warning matches the tolerant resolution applied at evaluation time.
    const exact = new Set(availableChannels.map((c) => c.id));
    const norm = new Set(availableChannels.map((c) => normalizeChannelId(c.id)));
    return { has: (id: string) => exact.has(id) || norm.has(normalizeChannelId(id)) };
  }, [availableChannels]);
  // Exact source-channel id set, for the shadow-of-source-channel guard.
  const sourceIds = useMemo(
    () => new Set(availableChannels.map((c) => c.id)),
    [availableChannels],
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function add() {
    const fresh = defaultMathChannel(channels.map((c) => c.id));
    onChange([...channels, fresh]);
    setSelectedIdx(channels.length);
  }

  function update(next: MathChannel) {
    if (selectedIdx < 0) return;
    onChange(channels.map((c, i) => (i === selectedIdx ? next : c)));
  }

  function remove(idx: number) {
    onChange(channels.filter((_, i) => i !== idx));
    setPendingDelete(null);
    if (selectedIdx === idx) {
      // Select the previous channel (or the new first one) after removal.
      setSelectedIdx(idx > 0 ? idx - 1 : (channels.length > 1 ? 0 : -1));
    } else if (selectedIdx > idx) {
      setSelectedIdx(selectedIdx - 1);
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
      role="dialog"
      aria-modal="true"
      aria-label="Math channels"
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 helios-overlay-in"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="bg-[#0E0E10] border border-[#2A2C32] rounded-md helios-elevate helios-modal-in w-[1180px] h-[720px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-9 flex items-center justify-between px-3 border-b border-[#2A2C32]">
          <span className="text-xs uppercase tracking-wider text-[#FFC627]">ƒ Math Channels</span>
          <button
            aria-label="Close"
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center text-[#9097A0] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
          >×</button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Channel list */}
          <aside className="w-52 flex-shrink-0 border-r border-[#2A2C32] flex flex-col">
            <div className="px-2 py-1 border-b border-[#2A2C32] flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">{channels.length} defined</span>
              <button
                onClick={add}
                className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#FFC627] hover:bg-[#16171B] rounded-sm cursor-pointer"
              >+ add</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {channels.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-[#9097A0]">
                  No math channels yet. Click <span className="text-[#FFC627]">+ add</span>.
                </div>
              )}
              {channels.map((c, i) => {
                const hasError = errors.has(c.id);
                const isSelected = i === selectedIdx;
                return (
                  <div
                    key={keyOf(c)}
                    onClick={() => setSelectedIdx(i)}
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
                      <span className="text-[10px] text-[#9097A0]">{c.display_name}</span>
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
                  // ids belonging to OTHER math channels (collision), and every
                  // SOURCE channel id (shadow guard). Excludes this channel's own
                  // current id so re-typing the same value isn't a "collision".
                  otherMathIds={
                    new Set(channels.filter((_, i) => i !== selectedIdx).map((c) => c.id))
                  }
                  sourceIds={sourceIds}
                  textareaRef={textareaRef}
                  onChange={update}
                  onDelete={() => setPendingDelete(selectedIdx)}
                />
              : <div className="p-6 text-xs text-[#9097A0]">Select a math channel from the list, or click + add to create one.</div>
            }
          </main>
        </div>

        <div className="px-3 py-2 border-t border-[#2A2C32] text-[10px] text-[#9097A0]">
          Drag tokens from the palette into the expression box, or click them to insert at the cursor.
        </div>
      </div>

      {/* X3 — in-app delete confirm (native confirm() may not render in the
          Tauri webview, and is blocking). */}
      {pendingDelete !== null && channels[pendingDelete] && (
        <ConfirmDialog
          title="Delete math channel"
          body={`Delete math channel "${channels[pendingDelete]!.id}"? This cannot be undone.`}
          confirmLabel="Delete"
          confirmTone="danger"
          cancelLabel="Cancel"
          onConfirm={() => remove(pendingDelete)}
          onClose={() => setPendingDelete(null)}
        />
      )}
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
        <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">Palette</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <Section title="Channels" open={open["Channels"] ?? true} onToggle={() => toggle("Channels")}>
          {channelsByGroup.length === 0 && (
            <div className="px-3 py-1 text-[10px] text-[#9097A0]">No channels in primary session.</div>
          )}
          {channelsByGroup.map(([group, list]) => (
            <div key={group} className="mb-1">
              <div className="px-3 py-0.5 text-[9px] uppercase tracking-wider text-[#5A5F66]">{group}</div>
              {list.map((c) => (
                <Token
                  key={c.id}
                  text={c.id}
                  insert={formatRefForExpr(c.id)}
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
        className="w-full px-2 py-1 text-left text-[10px] uppercase tracking-wider text-[#9097A0] hover:text-[#FFC627] hover:bg-[#16171B] flex items-center justify-between"
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

/** Channel ids that aren't valid bare identifiers (e.g. contain spaces or
 *  punctuation) must be wrapped in `[...]` for the math parser. */
function formatRefForExpr(id: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(id) ? id : `[${id}]`;
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
  availableSet: { has: (id: string) => boolean };
  /** ids belonging to the OTHER math channels (duplicate-id guard). */
  otherMathIds: Set<string>;
  /** Every source channel id in the session (shadow-of-source guard). */
  sourceIds: Set<string>;
  textareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  onChange: (next: MathChannel) => void;
  onDelete: () => void;
}

function Editor({
  channel, errorFromApply, availableSet, otherMathIds, sourceIds, textareaRef, onChange, onDelete,
}: EditorProps) {
  const check = useMemo(() => checkExpression(channel.expression), [channel.expression]);
  const unknownRefs = check.ok
    ? check.refs.filter((r) => !availableSet.has(r) && !MATH_BUILTINS.constants.includes(r))
    : [];

  // C4 — the id field is edited locally so a colliding/shadowing value is
  // never propagated to the parent (which would silently overwrite a real
  // logged channel or another math channel via store.addChannel + duplicate keys).
  // The draft re-syncs whenever the committed channel.id changes (e.g. on
  // switching channels), so it always starts from the last valid value.
  const [idDraft, setIdDraft] = useState(channel.id);
  useEffect(() => { setIdDraft(channel.id); }, [channel.id]);

  const idValid = isValidMathChannelId(idDraft);
  const duplicatesMath = idValid && otherMathIds.has(idDraft);
  const shadowsSource = idValid && sourceIds.has(idDraft);
  const idError =
    !idValid ? "id must match [a-zA-Z_][a-zA-Z0-9_.]*"
    : duplicatesMath ? `id "${idDraft}" is already used by another math channel`
    : shadowsSource ? `id "${idDraft}" would shadow an existing source channel`
    : null;

  function setId(value: string) {
    setIdDraft(value);
    // Only commit when the new id is valid, unique among math channels, and
    // does not shadow a source channel. Otherwise keep the parent on the last
    // good id while the inline error guides the user.
    if (isValidMathChannelId(value) && !otherMathIds.has(value) && !sourceIds.has(value)) {
      onChange({ ...channel, id: value });
    }
  }

  function set<K extends keyof MathChannel>(key: K, value: MathChannel[K]) {
    onChange({ ...channel, [key]: value });
  }

  return (
    <div className="p-4 flex flex-col gap-3 text-xs text-[#D8DCE2]">
      <div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-2 items-center">
        <label className="text-[10px] uppercase tracking-wider text-[#9097A0]">id</label>
        <div className="flex items-center gap-2">
          <input
            value={idDraft}
            onChange={(e) => setId(e.target.value)}
            className={
              "flex-1 bg-[#16171B] border px-2 py-1 font-mono-num text-[#FFC627] focus:outline-none "
              + (idError ? "border-[#EF5350]" : "border-[#2A2C32] focus:border-[#FFC627]")
            }
          />
          {idError && <span className="text-[10px] text-[#EF5350]">{idError}</span>}
        </div>

        <label className="text-[10px] uppercase tracking-wider text-[#9097A0]">name</label>
        <input
          value={channel.display_name}
          onChange={(e) => set("display_name", e.target.value)}
          className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 focus:outline-none focus:border-[#FFC627]"
        />

        <label className="text-[10px] uppercase tracking-wider text-[#9097A0]">units</label>
        <input
          value={channel.units}
          onChange={(e) => set("units", e.target.value)}
          className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 focus:outline-none focus:border-[#FFC627]"
        />

        <label className="text-[10px] uppercase tracking-wider text-[#9097A0]">decimals</label>
        <input
          type="number" min={0} max={6}
          value={channel.decimals}
          // L11 — clamp/round to [0, 6] so an out-of-range value can never reach
          // toFixed() downstream (which throws RangeError outside 0..100).
          onChange={(e) => set("decimals", Math.max(0, Math.min(6, Math.round(Number(e.target.value) || 0))))}
          className="w-20 bg-[#16171B] border border-[#2A2C32] px-2 py-1 focus:outline-none focus:border-[#FFC627]"
        />

        <label className="text-[10px] uppercase tracking-wider text-[#9097A0]">color</label>
        <input
          type="color"
          value={channel.color}
          onChange={(e) => set("color", e.target.value)}
          className="w-12 h-7 bg-[#16171B] border border-[#2A2C32] cursor-pointer"
        />

        <label className="text-[10px] uppercase tracking-wider text-[#9097A0]">group</label>
        <input
          value={channel.group}
          onChange={(e) => set("group", e.target.value)}
          className="bg-[#16171B] border border-[#2A2C32] px-2 py-1 focus:outline-none focus:border-[#FFC627]"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] uppercase tracking-wider text-[#9097A0]">expression</label>
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
            Unknown channel(s): {unknownRefs.map((r) => `"${formatRefForExpr(r)}"`).join(", ")}.
            Will evaluate to NaN unless this session has them.
          </div>
        )}
        {check.ok && errorFromApply && (
          <div className="text-[10px] text-[#EF5350]">Apply error: {errorFromApply}</div>
        )}
        {check.ok && check.refs.length > 0 && unknownRefs.length === 0 && (
          <div className="text-[10px] text-[#9097A0]">References: {check.refs.map(formatRefForExpr).join(", ")}</div>
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
          className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#9097A0] hover:text-[#EF5350] hover:bg-[#16171B] rounded-sm cursor-pointer"
        >Delete</button>
        <span className="text-[10px] text-[#9097A0]">Edits save automatically.</span>
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
      <span className="text-[10px] uppercase tracking-wider text-[#9097A0] w-12">{label}</span>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className="flex-1 bg-[#16171B] border border-[#2A2C32] px-2 py-1 focus:outline-none focus:border-[#FFC627]"
      />
    </label>
  );
}
