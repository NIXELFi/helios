"use client";

import type { Milestone, MilestoneType } from "@helios/pm-ui";
import { IconTrash } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { FloatingWindow } from "@pm/components/ui/FloatingWindow";
import { Select } from "@pm/components/ui/Select";

const inputClass =
  "rounded border border-helios-line bg-helios-base px-2.5 py-1.5 text-sm text-helios-text " +
  "placeholder:text-helios-dim focus:border-asu-gold focus:outline-none";

// Local label map for the milestone types (mirrors the constant in
// GanttViewClient; there is no shared export to import).
const MILESTONE_TYPE_LABEL: Record<MilestoneType, string> = {
  design_review: "Design review",
  integration: "Integration",
  validation: "Validation",
  gate: "Gate",
  comp_event: "Competition",
};

const MILESTONE_TYPE_OPTIONS: Array<{ value: MilestoneType; label: string }> = (
  ["design_review", "integration", "validation", "gate", "comp_event"] as MilestoneType[]
).map((t) => ({ value: t, label: MILESTONE_TYPE_LABEL[t] }));

export interface MilestoneDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (milestone: Milestone) => void;
  onDelete?: (milestone: Milestone) => void;
  projectId: string;
  milestone?: Milestone | null;
}

export function MilestoneDialog({
  open,
  onClose,
  onSave,
  onDelete,
  projectId,
  milestone = null,
}: MilestoneDialogProps) {
  const [name, setName] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [type, setType] = useState<MilestoneType>("design_review");
  const [description, setDescription] = useState("");

  // Initialise on open (edit vs create).
  useEffect(() => {
    if (!open) return;
    setName(milestone?.name ?? "");
    setTargetDate(milestone?.target_date ?? "");
    setType(milestone?.type ?? "design_review");
    setDescription(milestone?.description ?? "");
  }, [open, milestone]);

  function handleSave() {
    if (!name.trim() || !targetDate) return;
    onSave({
      id: milestone?.id ?? crypto.randomUUID(),
      project_id: projectId,
      name: name.trim(),
      target_date: targetDate,
      type,
      description: description.trim() === "" ? null : description.trim(),
    });
    onClose();
  }

  const canSave = name.trim().length > 0 && targetDate !== "" && projectId !== "";

  return (
    <FloatingWindow
      open={open}
      title={milestone ? "Edit milestone" : "New milestone"}
      onClose={onClose}
      initialWidth={480}
      initialHeight={480}
      footer={
        <div className="flex w-full items-center justify-between">
          <div>
            {milestone && onDelete ? (
              <button
                type="button"
                onClick={() => {
                  if (
                    milestone &&
                    confirm(`Delete milestone "${milestone.name}"? This cannot be undone.`)
                  ) {
                    onDelete(milestone);
                  }
                }}
                className="inline-flex items-center gap-1 rounded border border-helios-line bg-transparent px-2.5 py-1.5 text-sm font-normal text-helios-dim hover:border-red-400/40 hover:bg-helios-base hover:text-red-400"
              >
                <IconTrash size={14} strokeWidth={1.5} />
                Delete
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-helios-line bg-transparent px-3 py-1.5 text-sm font-normal text-helios-dim hover:bg-helios-base hover:text-helios-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className="rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-black hover:bg-asu-gold/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save milestone
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4 p-5">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Milestone name…"
            className={inputClass}
            autoFocus
          />
        </Field>

        <Field label="Target date">
          <input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Type">
          <Select
            value={type}
            ariaLabel="Milestone type"
            onChange={(v) => setType(v as MilestoneType)}
            options={MILESTONE_TYPE_OPTIONS}
          />
        </Field>

        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Optional details…"
            className={inputClass + " resize-none"}
          />
        </Field>
      </div>
    </FloatingWindow>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">
        {label}
      </span>
      {children}
    </label>
  );
}
