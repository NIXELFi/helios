"use client";

import type { Vendor, VendorCategory, VendorStatus } from "@helios/pm-ui";
import { VENDOR_CATEGORIES, VENDOR_STATUSES } from "@helios/pm-ui";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Select } from "@pm/components/ui/Select";

export const CATEGORY_LABEL: Record<VendorCategory, string> = {
  machining: "Machining",
  sheet_metal: "Sheet metal",
  waterjet: "Waterjet",
  laser: "Laser",
  "3d_print": "3D print",
  composites: "Composites",
  fasteners: "Fasteners",
  other: "Other",
};

export const STATUS_LABEL: Record<VendorStatus, string> = {
  active: "Active",
  preferred: "Preferred",
  inactive: "Inactive",
};

const MACHINING_TYPES = ["Mill", "Lathe"] as const;
const MACHINING_FEATURES = [
  "Tool changer",
  "Auto feed",
  "Live tooling",
  "Bar feeder",
] as const;

interface FormState {
  name: string;
  category: VendorCategory;
  contact_name: string;
  email: string;
  phone: string;
  website: string;
  location: string;
  processes: string[];
  machiningTypes: string[];
  machiningFeatures: string[];
  axis_count: string;
  lead_time_days: string;
  status: VendorStatus;
  notes: string;
}

function emptyForm(): FormState {
  return {
    name: "",
    category: "machining",
    contact_name: "",
    email: "",
    phone: "",
    website: "",
    location: "",
    processes: [],
    machiningTypes: [],
    machiningFeatures: [],
    axis_count: "",
    lead_time_days: "",
    status: "active",
    notes: "",
  };
}

function fromVendor(v: Vendor): FormState {
  return {
    name: v.name,
    category: v.category,
    contact_name: v.contact_name ?? "",
    email: v.email ?? "",
    phone: v.phone ?? "",
    website: v.website ?? "",
    location: v.location ?? "",
    processes: [...v.processes],
    machiningTypes: v.machining ? [...v.machining.types] : [],
    machiningFeatures: v.machining ? [...v.machining.features] : [],
    axis_count:
      v.machining && v.machining.axis_count != null
        ? String(v.machining.axis_count)
        : "",
    lead_time_days: v.lead_time_days != null ? String(v.lead_time_days) : "",
    status: v.status,
    notes: v.notes ?? "",
  };
}

export interface VendorDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (vendor: Vendor) => void;
  projectId: string;
  // When set, the dialog edits this vendor; otherwise it creates a new one.
  vendor?: Vendor | null;
}

export function VendorDialog({
  open,
  onClose,
  onSave,
  projectId,
  vendor = null,
}: VendorDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [processDraft, setProcessDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isEdit = vendor !== null;

  useEffect(() => {
    if (open) {
      setForm(vendor ? fromVendor(vendor) : emptyForm());
      setProcessDraft("");
      setError(null);
    }
  }, [open, vendor]);

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

  function patch(p: Partial<FormState>) {
    setForm((f) => ({ ...f, ...p }));
  }

  function toggleField(field: "machiningTypes" | "machiningFeatures", value: string) {
    setForm((f) => {
      const list = f[field];
      const next = list.includes(value)
        ? list.filter((v) => v !== value)
        : [...list, value];
      return { ...f, [field]: next };
    });
  }

  function addProcess() {
    const tag = processDraft.trim();
    if (!tag) return;
    setForm((f) =>
      f.processes.includes(tag) ? f : { ...f, processes: [...f.processes, tag] },
    );
    setProcessDraft("");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }

    const axisCount = form.axis_count.trim() === "" ? null : Number(form.axis_count);
    const hasMachining =
      form.machiningTypes.length > 0 ||
      form.machiningFeatures.length > 0 ||
      axisCount != null;

    const saved: Vendor = {
      id: vendor?.id ?? crypto.randomUUID(),
      project_id: vendor?.project_id ?? projectId,
      name,
      category: form.category,
      contact_name: form.contact_name.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      website: form.website.trim() || null,
      location: form.location.trim() || null,
      processes: form.processes,
      machining: hasMachining
        ? {
            types: form.machiningTypes,
            features: form.machiningFeatures,
            axis_count: axisCount,
          }
        : null,
      lead_time_days:
        form.lead_time_days.trim() === "" ? null : Number(form.lead_time_days),
      status: form.status,
      notes: form.notes.trim() || null,
    };

    onSave(saved);
    onClose();
  }

  return (
    <dialog
      ref={ref}
      className="w-full max-w-lg rounded-md border border-helios-line bg-helios-panel p-0 text-helios-text backdrop:bg-black/60"
      aria-labelledby="vendor-dialog-title"
    >
      <form onSubmit={handleSubmit} className="flex max-h-[85vh] flex-col">
        <header className="flex items-center justify-between border-b border-helios-line px-5 py-4">
          <h2 id="vendor-dialog-title" className="text-base font-medium">
            {isEdit ? "Edit vendor" : "New vendor"}
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

        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-5">
          <Field label="Name" htmlFor="vendor-name">
            <input
              id="vendor-name"
              type="text"
              autoFocus
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="e.g. Cardinal CNC"
              className={inputClass}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Category">
              <Select
                value={form.category}
                onChange={(v) => patch({ category: v as VendorCategory })}
                ariaLabel="Category"
                options={VENDOR_CATEGORIES.map((c) => ({
                  value: c,
                  label: CATEGORY_LABEL[c],
                }))}
              />
            </Field>

            <Field label="Status">
              <Select
                value={form.status}
                onChange={(v) => patch({ status: v as VendorStatus })}
                ariaLabel="Status"
                options={VENDOR_STATUSES.map((s) => ({
                  value: s,
                  label: STATUS_LABEL[s],
                }))}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Contact name" htmlFor="vendor-contact">
              <input
                id="vendor-contact"
                type="text"
                value={form.contact_name}
                onChange={(e) => patch({ contact_name: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Location" htmlFor="vendor-location">
              <input
                id="vendor-location"
                type="text"
                value={form.location}
                onChange={(e) => patch({ location: e.target.value })}
                placeholder="e.g. Tempe, AZ"
                className={inputClass}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Email" htmlFor="vendor-email">
              <input
                id="vendor-email"
                type="email"
                value={form.email}
                onChange={(e) => patch({ email: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Phone" htmlFor="vendor-phone">
              <input
                id="vendor-phone"
                type="tel"
                value={form.phone}
                onChange={(e) => patch({ phone: e.target.value })}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Website" htmlFor="vendor-website">
              <input
                id="vendor-website"
                type="text"
                value={form.website}
                onChange={(e) => patch({ website: e.target.value })}
                placeholder="example.com"
                className={inputClass}
              />
            </Field>
            <Field label="Lead time (days)" htmlFor="vendor-lead">
              <input
                id="vendor-lead"
                type="number"
                min={0}
                value={form.lead_time_days}
                onChange={(e) => patch({ lead_time_days: e.target.value })}
                placeholder="—"
                className={inputClass}
              />
            </Field>
          </div>

          {/* Processes — free tag list */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-helios-dim">
              Processes
            </span>
            {form.processes.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {form.processes.map((p) => (
                  <span
                    key={p}
                    className="inline-flex items-center gap-1 rounded border border-helios-line bg-helios-base px-2 py-0.5 text-xs text-helios-text"
                  >
                    {p}
                    <button
                      type="button"
                      onClick={() => patch({ processes: form.processes.filter((x) => x !== p) })}
                      className="text-helios-dim hover:text-red-400"
                      aria-label={`Remove ${p}`}
                    >
                      <IconX size={12} strokeWidth={1.5} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="flex gap-2">
              <input
                type="text"
                value={processDraft}
                onChange={(e) => setProcessDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addProcess();
                  }
                }}
                placeholder="Add a process and press enter"
                className={inputClass}
              />
              <button
                type="button"
                onClick={addProcess}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-helios-line bg-transparent px-2.5 py-1.5 text-sm font-normal text-helios-text hover:bg-helios-base"
              >
                <IconPlus size={14} strokeWidth={1.5} />
                Add
              </button>
            </div>
          </div>

          {/* Machining detail — only relevant for machining vendors */}
          {form.category === "machining" ? (
            <div className="flex flex-col gap-3 rounded border border-helios-line bg-helios-base/40 p-3">
              <span className="text-xs font-medium uppercase tracking-wide text-helios-dim">
                Machining capability
              </span>
              <ChipGroup
                label="Machine types"
                options={MACHINING_TYPES}
                selected={form.machiningTypes}
                onToggle={(v) => toggleField("machiningTypes", v)}
              />
              <ChipGroup
                label="Features"
                options={MACHINING_FEATURES}
                selected={form.machiningFeatures}
                onToggle={(v) => toggleField("machiningFeatures", v)}
              />
              <Field label="Axis count" htmlFor="vendor-axis">
                <input
                  id="vendor-axis"
                  type="number"
                  min={2}
                  max={9}
                  value={form.axis_count}
                  onChange={(e) => patch({ axis_count: e.target.value })}
                  placeholder="e.g. 5"
                  className={inputClass}
                />
              </Field>
            </div>
          ) : null}

          <Field label="Notes" htmlFor="vendor-notes">
            <textarea
              id="vendor-notes"
              rows={2}
              value={form.notes}
              onChange={(e) => patch({ notes: e.target.value })}
              className={inputClass + " resize-y"}
            />
          </Field>

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
            {isEdit ? "Save changes" : "Create vendor"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

const inputClass =
  "w-full rounded border border-helios-line bg-helios-base px-2.5 py-1.5 text-sm text-helios-text " +
  "placeholder:text-helios-dim focus:border-asu-gold focus:outline-none disabled:opacity-60";

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-helios-dim">
        {label}
      </span>
      {children}
    </label>
  );
}

function ChipGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: readonly string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-helios-dim">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onToggle(opt)}
              className={
                "rounded border px-2 py-0.5 text-xs transition-colors " +
                (active
                  ? "border-asu-gold/60 bg-asu-gold/10 text-asu-gold"
                  : "border-helios-line bg-transparent text-helios-dim hover:text-helios-text")
              }
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}
