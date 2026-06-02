"use client";

import type { Subteam } from "@helios/pm-ui";
import { IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

// Palette mirrors the seeded subteam colors so new subteams blend in.
const SWATCHES = [
  "#34D399",
  "#10B981",
  "#F87171",
  "#A78BFA",
  "#22D3EE",
  "#FB923C",
  "#F472B6",
  "#FBBF24",
  "#60A5FA",
  "#8C1D40",
  "#FFC627",
] as const;

const DEFAULT_COLOR = SWATCHES[0];

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const inputClass =
  "w-full rounded border border-helios-line bg-helios-base px-2.5 py-1.5 text-sm text-helios-text " +
  "placeholder:text-helios-dim focus:border-asu-gold focus:outline-none disabled:opacity-60";

export interface SubteamDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (subteam: Subteam) => void;
  // When set, the dialog edits this subteam; otherwise it creates a new one.
  subteam?: Subteam | null;
}

export function SubteamDialog({
  open,
  onClose,
  onSave,
  subteam = null,
}: SubteamDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [error, setError] = useState<string | null>(null);

  const isEdit = subteam !== null;

  useEffect(() => {
    if (open) {
      setName(subteam?.name ?? "");
      setCode(subteam?.code ?? "");
      setColor(subteam?.color ?? DEFAULT_COLOR);
      setError(null);
    }
  }, [open, subteam]);

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

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    const trimmedCode = code.trim();
    const saved: Subteam = {
      id: subteam?.id ?? crypto.randomUUID(),
      name: trimmedName,
      code: trimmedCode || trimmedName.slice(0, 3).toUpperCase(),
      slug: slugify(trimmedName) || (subteam?.slug ?? crypto.randomUUID()),
      color,
    };
    onSave(saved);
    onClose();
  }

  return (
    <dialog
      ref={ref}
      className="w-full max-w-md rounded-md border border-helios-line bg-helios-panel p-0 text-helios-text backdrop:bg-black/60"
      aria-labelledby="subteam-dialog-title"
    >
      <form onSubmit={handleSubmit} className="flex flex-col">
        <header className="flex items-center justify-between border-b border-helios-line px-5 py-4">
          <h2 id="subteam-dialog-title" className="text-base font-medium">
            {isEdit ? "Edit subteam" : "New subteam"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-helios-text"
            aria-label="Close"
          >
            <IconX size={16} strokeWidth={1.5} />
          </button>
        </header>

        <div className="flex flex-col gap-4 px-5 py-5">
          <div className="grid grid-cols-[1fr_auto] gap-4">
            <label htmlFor="subteam-name" className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-helios-dim">
                Name
              </span>
              <input
                id="subteam-name"
                type="text"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Aero Design"
                className={inputClass}
              />
            </label>
            <label htmlFor="subteam-code" className="flex w-24 flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-helios-dim">
                Code
              </span>
              <input
                id="subteam-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="AED"
                className={inputClass}
              />
            </label>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-helios-dim">
              Color
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {SWATCHES.map((c) => {
                const active = color.toLowerCase() === c.toLowerCase();
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    aria-label={`Use ${c}`}
                    className={
                      "size-6 rounded-full border transition-transform " +
                      (active
                        ? "border-helios-text ring-2 ring-asu-gold"
                        : "border-helios-line hover:scale-110")
                    }
                    style={{ backgroundColor: c }}
                  />
                );
              })}
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                aria-label="Custom color"
                className="size-6 cursor-pointer rounded border border-helios-line bg-transparent p-0"
              />
            </div>
          </div>

          {error ? <p className="text-xs text-red-400">{error}</p> : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-helios-line bg-helios-base/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-helios-line bg-transparent px-3 py-1.5 text-sm font-normal text-helios-text hover:bg-helios-base"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-helios-base hover:bg-asu-gold/90"
          >
            {isEdit ? "Save changes" : "Create subteam"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
