"use client";

import type { Project } from "@helios/pm-ui";
import { IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

export interface ProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (values: { name: string; description: string | null }) => void;
  // When set, the dialog renames this project; otherwise it creates a new one.
  project?: Project | null;
}

const inputClass =
  "w-full rounded border border-helios-line bg-helios-base px-2.5 py-1.5 text-sm text-helios-text " +
  "placeholder:text-helios-dim focus:border-asu-gold focus:outline-none disabled:opacity-60";

export function ProjectDialog({
  open,
  onClose,
  onSave,
  project = null,
}: ProjectDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isEdit = project !== null;

  useEffect(() => {
    if (open) {
      setName(project?.name ?? "");
      setDescription(project?.description ?? "");
      setError(null);
    }
  }, [open, project]);

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
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    onSave({ name: trimmed, description: description.trim() || null });
    onClose();
  }

  return (
    <dialog
      ref={ref}
      className="w-full max-w-md rounded-md border border-helios-line bg-helios-panel p-0 text-helios-text backdrop:bg-black/60"
      aria-labelledby="project-dialog-title"
    >
      <form onSubmit={handleSubmit} className="flex flex-col">
        <header className="flex items-center justify-between border-b border-helios-line px-5 py-4">
          <h2 id="project-dialog-title" className="text-base font-medium">
            {isEdit ? "Rename project" : "New project"}
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
          <label htmlFor="project-name" className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-helios-dim">
              Name
            </span>
            <input
              id="project-name"
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. SDM28"
              className={inputClass}
            />
          </label>

          <label htmlFor="project-description" className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-helios-dim">
              Description
            </span>
            <input
              id="project-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              className={inputClass}
            />
          </label>

          {error ? <p className="text-xs text-red-400">{error}</p> : null}

          {!isEdit ? (
            <p className="text-xs text-helios-dim">
              New projects start empty but keep the subteam structure.
            </p>
          ) : null}
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
            {isEdit ? "Save changes" : "Create project"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
