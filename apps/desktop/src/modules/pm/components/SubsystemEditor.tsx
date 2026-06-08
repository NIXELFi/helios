"use client";

import type { Subsystem } from "@helios/pm-ui";
import { IconPencil, IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePmStore } from "@pm/lib/pmStore";
import { recallSharing, rememberSharing, type SharingMap } from "@pm/lib/subsystemSharing";

const SWATCHES = [
  "#34D399", "#10B981", "#F87171", "#A78BFA", "#22D3EE",
  "#FB923C", "#F472B6", "#FBBF24", "#60A5FA", "#8C1D40", "#FFC627",
] as const;

const inputClass =
  "w-full rounded border border-helios-line bg-helios-base px-2.5 py-1.5 text-sm text-helios-text " +
  "placeholder:text-helios-dim focus:border-asu-gold focus:outline-none";

export function SubsystemEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const subteams = usePmStore((s) => s.subteams);
  const subsystems = usePmStore((s) => s.subsystems);
  const tasks = usePmStore((s) => s.tasks);
  const activeProjectId = usePmStore((s) => s.activeProjectId);
  const addSubsystem = usePmStore((s) => s.addSubsystem);
  const updateSubsystem = usePmStore((s) => s.updateSubsystem);
  const removeSubsystem = usePmStore((s) => s.removeSubsystem);

  const [sharing, setSharing] = useState<SharingMap>({});
  useEffect(() => {
    if (open) setSharing(recallSharing(activeProjectId));
  }, [open, activeProjectId]);
  function persistSharing(next: SharingMap) {
    setSharing(next);
    rememberSharing(activeProjectId, next);
  }

  // Form state (create or edit).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [color, setColor] = useState<string>("");
  const [primary, setPrimary] = useState<string>("");
  const [shared, setShared] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setCode("");
    setColor("");
    setPrimary(subteams[0]?.id ?? "");
    setShared(new Set());
    setError(null);
  };

  useEffect(() => {
    if (open) resetForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const handler = () => onClose();
    node.addEventListener("close", handler);
    return () => node.removeEventListener("close", handler);
  }, [onClose]);

  const subteamById = useMemo(() => new Map(subteams.map((s) => [s.id, s])), [subteams]);
  const taskCountBySubsystem = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) if (t.subsystem_id) m.set(t.subsystem_id, (m.get(t.subsystem_id) ?? 0) + 1);
    return m;
  }, [tasks]);

  function startEdit(ss: Subsystem) {
    setEditingId(ss.id);
    setName(ss.name);
    setCode(ss.code);
    setColor(ss.color ?? "");
    setPrimary(ss.subteam_id);
    setShared(new Set(sharing[ss.id] ?? []));
    setError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("Name is required.");
    if (!primary) return setError("Pick a primary subteam.");
    const sharedIds = [...shared].filter((id) => id !== primary);
    const finalCode = code.trim() || trimmed.slice(0, 3).toUpperCase();

    if (editingId) {
      updateSubsystem(editingId, {
        name: trimmed,
        code: finalCode,
        color: color || null,
        subteam_id: primary,
      });
      persistSharing({ ...sharing, [editingId]: sharedIds });
    } else {
      const id = crypto.randomUUID();
      addSubsystem({
        id,
        subteam_id: primary,
        parent_subsystem_id: null,
        name: trimmed,
        code: finalCode,
        color: color || null,
      });
      if (sharedIds.length) persistSharing({ ...sharing, [id]: sharedIds });
    }
    resetForm();
  }

  function handleDelete(ss: Subsystem) {
    const n = taskCountBySubsystem.get(ss.id) ?? 0;
    const warn =
      n > 0
        ? `\n\n${n} task${n === 1 ? "" : "s"} will be unassigned from this subsystem (not deleted).`
        : "";
    if (!window.confirm(`Remove subsystem "${ss.name}"?${warn}`)) return;
    removeSubsystem(ss.id);
    const next = { ...sharing };
    delete next[ss.id];
    persistSharing(next);
    if (editingId === ss.id) resetForm();
  }

  function toggleShared(id: string) {
    setShared((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Group subsystems by primary subteam for the list.
  const grouped = useMemo(() => {
    return subteams.map((st) => ({
      st,
      items: subsystems
        .filter((ss) => ss.subteam_id === st.id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [subteams, subsystems]);

  return (
    <dialog
      ref={ref}
      className="w-full max-w-3xl rounded-lg border border-helios-line bg-helios-panel p-0 text-helios-text backdrop:bg-black/60"
      aria-labelledby="subsystem-editor-title"
    >
      <div className="flex max-h-[82vh] flex-col">
        <header className="flex items-center justify-between border-b border-helios-line px-5 py-4">
          <div>
            <h2 id="subsystem-editor-title" className="text-base font-semibold">Subsystem Editor</h2>
            <p className="mt-0.5 text-xs text-helios-dim">
              Add, edit, or remove subsystems and share them across subteams.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-helios-text"
            aria-label="Close"
          >
            <IconX size={16} strokeWidth={1.5} />
          </button>
        </header>

        {/* Create / edit form */}
        <form onSubmit={handleSubmit} className="border-b border-helios-line bg-helios-base/30 px-5 py-4">
          <div className="grid grid-cols-[1fr_7rem_auto] gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Front Upright" className={inputClass} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">Code</span>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="FUP" className={inputClass} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">Primary subteam</span>
              <select value={primary} onChange={(e) => setPrimary(e.target.value)} className={inputClass + " min-w-[10rem]"}>
                {subteams.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">Color</span>
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Use ${c}`}
                  className={"size-5 rounded-full border " + (color.toLowerCase() === c.toLowerCase() ? "border-helios-text ring-2 ring-asu-gold" : "border-helios-line hover:scale-110")}
                  style={{ backgroundColor: c }}
                />
              ))}
              <button type="button" onClick={() => setColor("")} className="ml-1 text-[10px] text-helios-dim underline-offset-2 hover:underline">inherit</button>
            </div>
          </div>

          <div className="mt-3">
            <span className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">Also shared with</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {subteams.filter((s) => s.id !== primary).map((s) => {
                const on = shared.has(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleShared(s.id)}
                    className={"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors " + (on ? "border-asu-gold bg-asu-gold/15 text-asu-gold" : "border-helios-line text-helios-dim hover:text-helios-text")}
                  >
                    <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: s.color ?? "#6B7280" }} />
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>

          {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}

          <div className="mt-4 flex items-center justify-end gap-2">
            {editingId ? (
              <button type="button" onClick={resetForm} className="rounded border border-helios-line px-3 py-1.5 text-sm text-helios-text hover:bg-helios-base">
                Cancel edit
              </button>
            ) : null}
            <button type="submit" className="inline-flex items-center gap-1.5 rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-helios-base hover:bg-asu-gold/90">
              <IconPlus size={15} strokeWidth={1.5} />
              {editingId ? "Save subsystem" : "Add subsystem"}
            </button>
          </div>
        </form>

        {/* List grouped by subteam */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {grouped.every((g) => g.items.length === 0) ? (
            <p className="text-xs text-helios-dim">No subsystems yet. Add one above.</p>
          ) : (
            <ul className="flex flex-col gap-4">
              {grouped.filter((g) => g.items.length > 0).map(({ st, items }) => (
                <li key={st.id}>
                  <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold" style={{ color: st.color ?? "#D8DCE2" }}>
                    <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: st.color ?? "#6B7280" }} />
                    {st.name}
                  </div>
                  <ul className="flex flex-col gap-1">
                    {items.map((ss) => {
                      const extra = (sharing[ss.id] ?? []).map((id) => subteamById.get(id)).filter(Boolean);
                      return (
                        <li key={ss.id} className="group flex items-center gap-2 rounded border border-helios-line bg-helios-base/40 px-3 py-1.5">
                          <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: ss.color ?? st.color ?? "#6B7280" }} />
                          <span className="text-sm text-helios-text">{ss.name}</span>
                          <span className="text-[10px] uppercase tracking-widest text-helios-dim">{ss.code}</span>
                          {extra.length ? (
                            <span className="flex items-center gap-1 text-[10px] text-helios-dim">
                              · shared:
                              {extra.map((e) => (
                                <span key={e!.id} className="rounded-full px-1.5" style={{ backgroundColor: (e!.color ?? "#6B7280") + "33", color: e!.color ?? "#D8DCE2" }}>{e!.code}</span>
                              ))}
                            </span>
                          ) : null}
                          <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            <button type="button" onClick={() => startEdit(ss)} aria-label={`Edit ${ss.name}`} className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-asu-gold">
                              <IconPencil size={13} strokeWidth={1.5} />
                            </button>
                            <button type="button" onClick={() => handleDelete(ss)} aria-label={`Remove ${ss.name}`} className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-red-400">
                              <IconTrash size={13} strokeWidth={1.5} />
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </dialog>
  );
}
