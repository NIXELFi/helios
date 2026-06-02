"use client";

import type { CalendarEvent, Subteam } from "@helios/pm-ui";
import { IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { FloatingWindow } from "@pm/components/ui/FloatingWindow";

const inputClass =
  "rounded border border-helios-line bg-helios-base px-2.5 py-1.5 text-sm text-helios-text " +
  "placeholder:text-helios-dim focus:border-asu-gold focus:outline-none";

export interface EventDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (event: CalendarEvent) => void;
  projectId: string;
  subteams: ReadonlyArray<Subteam>;
  event?: CalendarEvent | null;
  defaultDate?: string | null;
}

export function EventDialog({
  open,
  onClose,
  onSave,
  projectId,
  subteams,
  event = null,
  defaultDate = null,
}: EventDialogProps) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [allSubteams, setAllSubteams] = useState(false);
  const [subteamIds, setSubteamIds] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [description, setDescription] = useState("");

  // Initialise on open (edit vs create).
  useEffect(() => {
    if (!open) return;
    setTitle(event?.title ?? "");
    setDate(event?.date ?? defaultDate ?? "");
    setAllSubteams(event?.all_subteams ?? false);
    setSubteamIds(event ? [...event.subteam_ids] : []);
    setTags(event ? [...event.type_tags] : []);
    setTagDraft("");
    setDescription(event?.description ?? "");
  }, [open, event, defaultDate]);

  function toggleSubteam(id: string) {
    setSubteamIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function addTag() {
    const t = tagDraft.trim();
    if (t && !tags.includes(t)) setTags((prev) => [...prev, t]);
    setTagDraft("");
  }

  function removeTag(t: string) {
    setTags((prev) => prev.filter((x) => x !== t));
  }

  function handleSave() {
    if (!title.trim() || !date) return;
    onSave({
      id: event?.id ?? crypto.randomUUID(),
      project_id: projectId,
      title: title.trim(),
      date,
      all_subteams: allSubteams,
      subteam_ids: allSubteams ? [] : subteamIds,
      type_tags: tags,
      description: description.trim() === "" ? null : description.trim(),
    });
    onClose();
  }

  const canSave = title.trim().length > 0 && date !== "";

  return (
    <FloatingWindow
      open={open}
      title={event ? "Edit event" : "New event"}
      onClose={onClose}
      initialWidth={480}
      initialHeight={560}
      footer={
        <>
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
            Save event
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-5">
        <Field label="Title">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Event name…"
            className={inputClass}
            autoFocus
          />
        </Field>

        <Field label="Date">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Subteams">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setAllSubteams((v) => !v)}
              className={
                "rounded-full border px-2 py-0.5 text-[11px] font-normal transition-colors " +
                (allSubteams
                  ? "border-asu-gold/60 bg-asu-gold/10 text-asu-gold"
                  : "border-helios-line bg-transparent text-helios-dim hover:text-helios-text")
              }
            >
              All subteams
            </button>
            {subteams.map((s) => {
              const active = !allSubteams && subteamIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={allSubteams}
                  onClick={() => toggleSubteam(s.id)}
                  className={
                    "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-normal transition-colors disabled:opacity-40 " +
                    (active
                      ? "border-helios-text/40 bg-helios-base text-helios-text"
                      : "border-helios-line bg-transparent text-helios-dim hover:text-helios-text")
                  }
                >
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: s.color ?? "#6B7280" }}
                  />
                  {s.code}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Type tags">
          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag();
                }
              }}
              onBlur={addTag}
              placeholder="Type a tag, press Enter…"
              className={inputClass}
            />
            {tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 rounded-full border border-helios-line bg-helios-base px-2 py-0.5 text-[11px] text-helios-text"
                  >
                    {t}
                    <button
                      type="button"
                      onClick={() => removeTag(t)}
                      aria-label={`Remove ${t}`}
                      className="text-helios-dim hover:text-helios-text"
                    >
                      <IconX size={11} strokeWidth={1.5} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
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
