"use client";

import type { Project } from "@helios/pm-ui";
import { IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

// On RENAME the dialog edits name + description. On CREATE a project IS a season,
// so it also collects the required car year + UNIQUE car code the server needs.
export type ProjectDialogValues =
  | { mode: "rename"; name: string; description: string | null }
  | { mode: "create"; name: string; carYear: number; carCode: string };

export interface ProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (values: ProjectDialogValues) => void;
  // When set, the dialog renames this project; otherwise it creates a new one.
  project?: Project | null;
  // An error from the (async) create attempt — e.g. "Only an admin can create a
  // season." or a duplicate car-code message — surfaced inline so a failed
  // server-backed create explains itself instead of the dialog just closing.
  externalError?: string | null;
}

const CAR_YEAR_MIN = 2000;
const CAR_YEAR_MAX = 2100;

const inputClass =
  "w-full rounded border border-helios-line bg-helios-base px-2.5 py-1.5 text-sm text-helios-text " +
  "placeholder:text-helios-dim focus:border-asu-gold focus:outline-none disabled:opacity-60";

export function ProjectDialog({
  open,
  onClose,
  onSave,
  project = null,
  externalError = null,
}: ProjectDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Create-only season fields. Default the year to the upcoming season so the
  // common case is one keystroke; held as a string so the field can be empty.
  const [carYear, setCarYear] = useState("");
  const [carCode, setCarCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isEdit = project !== null;

  useEffect(() => {
    if (open) {
      setName(project?.name ?? "");
      setDescription(project?.description ?? "");
      setCarYear(String(new Date().getFullYear() + 1));
      setCarCode("");
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

    if (isEdit) {
      onSave({ mode: "rename", name: trimmed, description: description.trim() || null });
      onClose();
      return;
    }

    // CREATE: a project is a season — require the year and the unique car code.
    const code = carCode.trim().toUpperCase();
    if (!code) {
      setError("Car code is required (e.g. SDM28).");
      return;
    }
    const year = Number.parseInt(carYear.trim(), 10);
    if (!Number.isInteger(year) || year < CAR_YEAR_MIN || year > CAR_YEAR_MAX) {
      setError(`Car year must be a number between ${CAR_YEAR_MIN} and ${CAR_YEAR_MAX}.`);
      return;
    }
    onSave({ mode: "create", name: trimmed, carYear: year, carCode: code });
    // NOTE: the parent closes the dialog only after the async create resolves, so
    // a failed create (duplicate code / not admin) can show its error here.
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
              placeholder="e.g. 2028 Season"
              className={inputClass}
            />
          </label>

          {isEdit ? (
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
          ) : (
            <div className="flex gap-3">
              <label htmlFor="project-car-year" className="flex w-28 flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-helios-dim">
                  Car year
                </span>
                <input
                  id="project-car-year"
                  type="number"
                  inputMode="numeric"
                  min={CAR_YEAR_MIN}
                  max={CAR_YEAR_MAX}
                  value={carYear}
                  onChange={(e) => setCarYear(e.target.value)}
                  placeholder="2028"
                  className={inputClass}
                />
              </label>
              <label htmlFor="project-car-code" className="flex flex-1 flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-helios-dim">
                  Car code
                </span>
                <input
                  id="project-car-code"
                  type="text"
                  value={carCode}
                  onChange={(e) => setCarCode(e.target.value.toUpperCase())}
                  placeholder="SDM28"
                  maxLength={16}
                  className={inputClass}
                />
              </label>
            </div>
          )}

          {error || externalError ? (
            <p className="text-xs text-red-400">{error ?? externalError}</p>
          ) : null}

          {!isEdit ? (
            <p className="text-xs text-helios-dim">
              A project is a season. Only admins can create one. The car code must
              be unique (e.g. SDM28). It starts empty but keeps the subteam structure.
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
