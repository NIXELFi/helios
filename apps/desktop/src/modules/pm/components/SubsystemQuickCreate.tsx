"use client";

// Inline "create a subsystem right where you need one" dialog. The full
// SubsystemEditor (dashboard) stays the management surface; this is the
// lightweight path that pops up from any subsystem picker — name + optional
// color, primary subteam fixed to the picker's context — and hands the new id
// back so the caller can select it immediately. Persists through the same
// store action as the editor (optimistic + DB insert + rollback).
//
// CRASH-FIX: this used to be a native <dialog>.showModal() mounted INSIDE the
// CreateTaskDialog's <form> (via the subsystem picker's Controller). That
// stacked a top-layer modal on top of a floating window mid-Select
// interaction and hard-crashed the webview when opened from the new-task
// menu; the nested <form> also let its submit event bubble into the outer
// create-task form. Rewritten as a plain fixed overlay (the same modal
// convention the Vault module uses everywhere) with no <form> element at all
// — Enter/Escape are handled explicitly and nothing propagates to the parent
// form.

import { useEffect, useRef, useState } from "react";
import { usePmStore } from "@pm/lib/pmStore";

const SWATCHES = [
  "#34D399", "#F87171", "#A78BFA", "#22D3EE", "#FB923C",
  "#F472B6", "#FBBF24", "#60A5FA", "#8C1D40", "#FFC627",
] as const;

interface Props {
  open: boolean;
  /** The subteam the new subsystem will belong to (the picker's context). */
  subteamId: string;
  onClose: () => void;
  onCreated: (subsystemId: string) => void;
}

export function SubsystemQuickCreate({ open, subteamId, onClose, onCreated }: Props) {
  const subteams = usePmStore((s) => s.subteams);
  const subsystems = usePmStore((s) => s.subsystems);
  const addSubsystem = usePmStore((s) => s.addSubsystem);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const subteam = subteams.find((s) => s.id === subteamId);

  useEffect(() => {
    if (open) {
      setName("");
      setColor("");
      setError(null);
      inputRef.current?.focus();
    }
  }, [open]);

  // Escape closes. stopImmediatePropagation so a parent window/modal Escape
  // handler underneath doesn't ALSO fire on the same keypress.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return setError("Name is required.");
    if (!subteam) return setError("No subteam selected.");
    const dup = subsystems.some(
      (s) => s.subteam_id === subteamId && s.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (dup) return setError(`"${trimmed}" already exists in ${subteam.name}.`);
    const id = crypto.randomUUID();
    addSubsystem({
      id,
      subteam_id: subteamId,
      parent_subsystem_id: null,
      name: trimmed,
      code: trimmed.slice(0, 3).toUpperCase(),
      color: color || null,
    });
    onCreated(id);
    onClose();
  }

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New subsystem"
        onClick={(e) => e.stopPropagation()}
        className="flex w-[360px] flex-col gap-3 rounded-lg border border-helios-line bg-helios-panel p-4 text-helios-text shadow-2xl"
      >
        <div>
          <div className="text-sm font-semibold">New subsystem</div>
          <div className="text-xs text-helios-dim">
            in <span className="text-helios-text">{subteam?.name ?? "—"}</span>
          </div>
        </div>
        <input
          ref={inputRef}
          autoFocus
          aria-label="Subsystem name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // Enter creates. Handled here (not via <form>) because this modal
            // renders inside the create-task <form> — a nested form's submit
            // would bubble into it.
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              submit();
            }
          }}
          placeholder="e.g. Uprights"
          className="w-full rounded border border-helios-line bg-helios-base px-2.5 py-1.5 text-sm placeholder:text-helios-dim focus:border-asu-gold focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Color">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={`Color ${c}`}
              onClick={() => setColor(color === c ? "" : c)}
              className={
                "h-5 w-5 rounded-full border " +
                (color === c ? "border-white ring-2 ring-asu-gold" : "border-helios-line")
              }
              style={{ background: c }}
            />
          ))}
        </div>
        {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-helios-line px-3 py-1 text-xs text-helios-dim hover:text-helios-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded bg-asu-gold px-3 py-1 text-xs font-semibold text-black hover:brightness-110"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
