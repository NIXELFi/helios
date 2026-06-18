"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type {
  Subsystem,
  Subteam,
  TaskPriority,
  TaskRow,
  TaskStatus,
  TaskType,
  User,
} from "@helios/pm-ui";
import {
  STATUS_DOT,
  STATUS_LABEL,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  TypeBadge,
  criticalityFill,
  taskStatus,
  taskType,
} from "@helios/pm-ui";
import {
  IconArrowLeft,
  IconArrowRight,
  IconPlus,
  IconStar,
  IconStarFilled,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { FloatingWindow } from "@pm/components/ui/FloatingWindow";
import { Select, type SelectOption } from "@pm/components/ui/Select";
import { TaskLookup } from "@pm/components/TaskLookup";
import { usePmStore } from "@pm/lib/pmStore";
import { SubsystemQuickCreate } from "@pm/components/SubsystemQuickCreate";
import { recallSharing, subsystemsForSubteam } from "@pm/lib/subsystemSharing";

export const createTaskInput = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  type: taskType,
  status: taskStatus,
  subteam_id: z.string().uuid("Pick a subteam"),
  subsystem_id: z.string().uuid().nullable(),
  owner_id: z.string().uuid().nullable(),
  start_date: z.string().nullable(),
  due_date: z.string().nullable(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  estimate_days: z.number().nonnegative().nullable(),
  mrl: z.number().int().min(1).max(9).nullable(),
  description: z.string().nullable(),
});
type CreateTaskInput = z.infer<typeof createTaskInput>;

const TYPE_LABEL: Record<TaskType, string> = {
  part: "Part",
  drawing: "Drawing",
  simulation: "Simulation",
  assembly: "Assembly",
  analysis: "Analysis",
  test: "Test",
  general: "General",
  mfg_laser: "MFG-LZR",
  mfg_machine: "MFG-MCH",
  mfg_weld: "MFG-WELD",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const STATUS_OPTIONS: SelectOption<TaskStatus>[] = TASK_STATUSES.map((s) => ({
  value: s,
  label: STATUS_LABEL[s],
  swatch: STATUS_DOT[s],
}));

const PRIORITY_OPTIONS: SelectOption<TaskPriority>[] = TASK_PRIORITIES.map((p) => ({
  value: p,
  label: PRIORITY_LABEL[p],
  fill: criticalityFill(p),
}));

const TYPE_OPTIONS: SelectOption<TaskType>[] = TASK_TYPES.map((t) => ({
  value: t,
  label: TYPE_LABEL[t],
  node: <TypeBadge type={t} />,
}));

// Persisted last-used subteam for the create-task form (PM team request:
// "the new task page should remember the previous subteam selection").
const LAST_SUBTEAM_KEY = "helios:pm:lastSubteamId";

function recallLastSubteam(): string | null {
  try {
    return window.localStorage.getItem(LAST_SUBTEAM_KEY);
  } catch {
    return null;
  }
}

function rememberLastSubteam(id: string): void {
  try {
    window.localStorage.setItem(LAST_SUBTEAM_KEY, id);
  } catch {
    // private mode / quota — non-fatal
  }
}

export interface CreateTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (task: TaskRow) => void;
  projectId: string;
  subteams: ReadonlyArray<Subteam>;
  subsystems: ReadonlyArray<Subsystem>;
  users: ReadonlyArray<User>;
  defaultSubteamId?: string | null;
  defaultStartDate?: string | null;
  defaultDueDate?: string | null;
  defaultStatus?: TaskStatus;
}

export function CreateTaskDialog({
  open,
  onClose,
  onCreate,
  projectId,
  subteams,
  subsystems,
  users,
  defaultSubteamId = null,
  defaultStartDate = null,
  defaultDueDate = null,
  defaultStatus = "not_started",
}: CreateTaskDialogProps) {
  const allTasks = usePmStore((s) => s.tasks);
  const addDependency = usePmStore((s) => s.addDependency);
  const addTaskSubteam = usePmStore((s) => s.addTaskSubteam);

  // Last subteam the user created a task under (persisted) — so consecutive
  // new tasks don't reset to the first subteam in the list. An explicit
  // context default (e.g. opening from a board column) still wins.
  const rememberedSubteamId = recallLastSubteam();
  const initialSubteamId =
    defaultSubteamId ??
    (rememberedSubteamId && subteams.some((s) => s.id === rememberedSubteamId)
      ? rememberedSubteamId
      : null) ??
    subteams[0]?.id ??
    "";

  const defaults: CreateTaskInput = useMemo(
    () => ({
      title: "",
      type: "general",
      status: defaultStatus,
      subteam_id: initialSubteamId,
      subsystem_id: null,
      owner_id: null,
      start_date: defaultStartDate,
      due_date: defaultDueDate,
      priority: "medium",
      estimate_days: null,
      mrl: null,
      description: null,
    }),
    [initialSubteamId, defaultStartDate, defaultDueDate, defaultStatus],
  );

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    control,
    formState: { errors, isSubmitting },
  } = useForm<CreateTaskInput>({
    resolver: zodResolver(createTaskInput),
    defaultValues: defaults,
  });

  // Staged dependencies created after the task itself.
  const [prereqIds, setPrereqIds] = useState<string[]>([]);
  const [dependentIds, setDependentIds] = useState<string[]>([]);
  // ADDITIONAL (non-primary) subteam memberships staged for after the insert.
  // The form's `subteam_id` is always the PRIMARY; these are everyone else.
  const [extraSubteamIds, setExtraSubteamIds] = useState<string[]>([]);
  const [subteamPickerOpen, setSubteamPickerOpen] = useState(false);

  const watchedSubteamId = watch("subteam_id");

  const subteamById = useMemo(() => {
    const m = new Map<string, Subteam>();
    for (const s of subteams) m.set(s.id, s);
    return m;
  }, [subteams]);

  // The full staged membership list, primary first. The primary is whatever
  // `subteam_id` holds; the extras follow in selection order.
  const stagedSubteamIds = useMemo(
    () => [watchedSubteamId, ...extraSubteamIds.filter((id) => id !== watchedSubteamId)],
    [watchedSubteamId, extraSubteamIds],
  );

  const availableSubteams = useMemo(() => {
    const taken = new Set(stagedSubteamIds);
    return subteams.filter((s) => !taken.has(s.id));
  }, [subteams, stagedSubteamIds]);

  // Promote a staged extra to primary: swap the old primary down into extras and
  // lift the chosen one into `subteam_id`. Subsystem resets via the existing effect.
  function makePrimary(id: string) {
    const prevPrimary = watchedSubteamId;
    setValue("subteam_id", id, { shouldValidate: true });
    setExtraSubteamIds((prev) => {
      const withoutNew = prev.filter((x) => x !== id);
      return prevPrimary && prevPrimary !== id ? [prevPrimary, ...withoutNew] : withoutNew;
    });
  }

  function removeStagedSubteam(id: string) {
    // The primary can't be removed from the staged list (it's a required field).
    if (id === watchedSubteamId) return;
    setExtraSubteamIds((prev) => prev.filter((x) => x !== id));
  }

  // Include subsystems SHARED into the chosen subteam, not just those it owns —
  // otherwise a shared subsystem can't be picked here, defeating the share
  // feature (see lib/subsystemSharing.ts). Re-read on open so newly-added
  // sharing from the Subsystem Editor is reflected without a remount.
  const sharing = useMemo(() => recallSharing(projectId), [projectId, open]);
  const teamSubsystems = useMemo(
    () => subsystemsForSubteam(subsystems, watchedSubteamId, sharing),
    [subsystems, watchedSubteamId, sharing],
  );
  // "+ New subsystem…" in the picker (quick-create, scoped to the chosen
  // subteam). The full editor remains on the dashboard; this is the inline path.
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);

  useEffect(() => {
    if (open) {
      reset(defaults);
      setPrereqIds([]);
      setDependentIds([]);
      setExtraSubteamIds([]);
      setSubteamPickerOpen(false);
    }
  }, [open, defaults, reset]);

  // Clear subsystem if it doesn't belong to the chosen subteam
  useEffect(() => {
    const current = watch("subsystem_id");
    if (current && !teamSubsystems.some((s) => s.id === current)) {
      setValue("subsystem_id", null);
    }
  }, [teamSubsystems, setValue, watch]);

  const stagedSet = useMemo(
    () => new Set<string>([...prereqIds, ...dependentIds]),
    [prereqIds, dependentIds],
  );
  const tasksById = useMemo(() => {
    const m = new Map<string, TaskRow>();
    for (const t of allTasks) m.set(t.id, t);
    return m;
  }, [allTasks]);

  const onSubmit = handleSubmit((input) => {
    const subteam = subteams.find((s) => s.id === input.subteam_id);
    if (!subteam) return;
    const subsystem = input.subsystem_id
      ? subsystems.find((s) => s.id === input.subsystem_id) ?? null
      : null;
    const owner = input.owner_id ? users.find((u) => u.id === input.owner_id) ?? null : null;

    const task: TaskRow = {
      id: crypto.randomUUID(),
      project_id: projectId,
      subteam_id: subteam.id,
      subsystem_id: subsystem?.id ?? null,
      parent_task_id: null,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      type: input.type,
      status: input.status,
      priority: input.priority,
      owner_id: input.owner_id,
      start_date: input.start_date,
      due_date: input.due_date,
      estimate_days: input.estimate_days,
      mrl: input.mrl,
      on_critical_path: false,
      // Recorded server-side via `default auth.uid()`; the store stamps the
      // current user optimistically in addTask so the creator can edit it now.
      created_by: null,
      subteam,
      // The insert seeds the PRIMARY membership only; additional memberships are
      // written below via addTaskSubteam so a team-scope remap in onCreate can't
      // leave a stale subteams[0].
      subteams: [subteam],
      subsystem,
      owner,
      // The (primary) owner seeds the owners list; co-owners are added later from
      // the task detail sheet. The DB trigger seeds the same primary membership.
      owners: owner ? [owner] : [],
    };

    onCreate(task);
    // Remember the chosen subteam so the next new-task form starts there.
    rememberLastSubteam(subteam.id);
    // Attach any ADDITIONAL (non-primary) subteams now that the task exists.
    // addTaskSubteam no-ops on the primary / already-members, so this is safe
    // even if onCreate re-homed the primary into the current team scope.
    for (const id of extraSubteamIds) {
      if (id === subteam.id) continue;
      addTaskSubteam(task.id, id);
    }
    // Author staged dependencies now that the task exists in the store.
    for (const pid of prereqIds) {
      addDependency({ predecessor_id: pid, successor_id: task.id, dep_type: "FS", lag_days: 0 });
    }
    for (const did of dependentIds) {
      addDependency({ predecessor_id: task.id, successor_id: did, dep_type: "FS", lag_days: 0 });
    }
    reset(defaults);
    setPrereqIds([]);
    setDependentIds([]);
    setExtraSubteamIds([]);
    onClose();
  });

  return (
    <FloatingWindow
      open={open}
      title="New task"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-helios-line bg-transparent px-3 py-1.5 text-sm font-normal text-helios-text hover:bg-helios-base"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="create-task-form"
            disabled={isSubmitting}
            className="rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-helios-base hover:bg-asu-gold/90 disabled:opacity-60"
          >
            Create task
          </button>
        </>
      }
    >
      <form id="create-task-form" onSubmit={onSubmit} className="flex flex-col gap-4 px-5 py-5">
        <Field label="Title" error={errors.title?.message} htmlFor="task-title">
          <input
            id="task-title"
            type="text"
            autoFocus
            placeholder="e.g. Front bulkhead — final geometry"
            className={inputClass}
            {...register("title")}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Type">
            <Controller
              control={control}
              name="type"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onChange={field.onChange}
                  options={TYPE_OPTIONS}
                  ariaLabel="Type"
                />
              )}
            />
          </Field>
          <Field label="Priority">
            <Controller
              control={control}
              name="priority"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onChange={field.onChange}
                  options={PRIORITY_OPTIONS}
                  ariaLabel="Priority"
                />
              )}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Status">
            <Controller
              control={control}
              name="status"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onChange={field.onChange}
                  options={STATUS_OPTIONS}
                  ariaLabel="Status"
                />
              )}
            />
          </Field>
          <Field
            label="MRL"
            error={errors.mrl?.message}
            htmlFor="task-mrl"
            title="Manufacturing Readiness Level (1–9)"
          >
            <input
              id="task-mrl"
              type="number"
              min={1}
              max={9}
              placeholder="—"
              className={inputClass}
              {...register("mrl", {
                setValueAs: (v) => (v === "" || v == null ? null : Number(v)),
              })}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Subteams" error={errors.subteam_id?.message}>
            <Controller
              control={control}
              name="subteam_id"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onChange={field.onChange}
                  ariaLabel="Primary subteam"
                  options={subteams.map((s) => ({
                    value: s.id,
                    label: s.name,
                    swatch: s.color ?? "#6B7280",
                  }))}
                />
              )}
            />
            {/* Staged membership: primary (starred) + extras, plus an add picker. */}
            <div className="flex flex-wrap items-center gap-1">
              {stagedSubteamIds.map((id) => {
                const s = subteamById.get(id);
                if (!s) return null;
                const isPrimary = id === watchedSubteamId;
                return (
                  <span
                    key={id}
                    className="group/chip inline-flex items-center gap-1 rounded border border-helios-line bg-helios-base/60 px-1.5 py-0.5 text-[11px] leading-none text-helios-text"
                    title={s.name}
                  >
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: s.color ?? "#6B7280" }}
                    />
                    <span className="font-medium">{s.code}</span>
                    {isPrimary ? (
                      <IconStarFilled
                        size={11}
                        className="shrink-0 text-asu-gold"
                        aria-label="Primary subteam"
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => makePrimary(id)}
                          aria-label={`Set ${s.name} as primary`}
                          title="Set as primary"
                          className="shrink-0 text-helios-dim opacity-50 transition-opacity hover:text-asu-gold group-hover/chip:opacity-100"
                        >
                          <IconStar size={11} />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeStagedSubteam(id)}
                          aria-label={`Remove ${s.name}`}
                          title="Remove"
                          className="shrink-0 rounded text-helios-dim hover:text-red-400"
                        >
                          <IconX size={11} strokeWidth={1.5} />
                        </button>
                      </>
                    )}
                  </span>
                );
              })}
              {availableSubteams.length > 0 ? (
                <span className="relative inline-flex">
                  <button
                    type="button"
                    onClick={() => setSubteamPickerOpen((o) => !o)}
                    aria-label="Add subteam"
                    aria-expanded={subteamPickerOpen}
                    className="inline-flex items-center gap-0.5 rounded border border-dashed border-helios-line px-1.5 py-0.5 text-[11px] leading-none text-helios-dim hover:border-helios-text/40 hover:text-helios-text"
                  >
                    <IconPlus size={11} strokeWidth={1.5} />
                    Add
                  </button>
                  {subteamPickerOpen ? (
                    <>
                      <button
                        type="button"
                        aria-label="Close subteam picker"
                        onClick={() => setSubteamPickerOpen(false)}
                        className="fixed inset-0 z-[60] cursor-default"
                      />
                      <ul
                        role="listbox"
                        className="absolute left-0 top-full z-[70] mt-1 max-h-56 min-w-[10rem] overflow-y-auto rounded-md border border-helios-line bg-helios-panel py-1 shadow-xl"
                      >
                        {availableSubteams.map((s) => (
                          <li key={s.id}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={false}
                              onClick={() => {
                                setExtraSubteamIds((prev) => [...prev, s.id]);
                                setSubteamPickerOpen(false);
                              }}
                              className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-helios-text hover:bg-helios-base"
                            >
                              <span
                                aria-hidden
                                className="size-2 shrink-0 rounded-full"
                                style={{ backgroundColor: s.color ?? "#6B7280" }}
                              />
                              <span className="truncate">{s.name}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </span>
              ) : null}
            </div>
          </Field>
          <Field label="Subsystem">
            <Controller
              control={control}
              name="subsystem_id"
              render={({ field }) => (
                <>
                  <Select
                    value={field.value ?? ""}
                    onChange={(v) => {
                      if (v === "__new-subsystem__") {
                        setQuickCreateOpen(true);
                        return; // keep the current value until the dialog resolves
                      }
                      field.onChange(v === "" ? null : v);
                    }}
                    disabled={!watchedSubteamId}
                    ariaLabel="Subsystem"
                    options={[
                      { value: "", label: "—" },
                      ...teamSubsystems.map((s) => ({ value: s.id, label: s.name })),
                      ...(watchedSubteamId
                        ? [{ value: "__new-subsystem__", label: "+ New subsystem…" }]
                        : []),
                    ]}
                  />
                  {quickCreateOpen && watchedSubteamId && (
                    <SubsystemQuickCreate
                      open
                      subteamId={watchedSubteamId}
                      onClose={() => setQuickCreateOpen(false)}
                      onCreated={(id) => field.onChange(id)}
                    />
                  )}
                </>
              )}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Owner">
            <Controller
              control={control}
              name="owner_id"
              render={({ field }) => (
                <Select
                  value={field.value ?? ""}
                  onChange={(v) => field.onChange(v === "" ? null : v)}
                  ariaLabel="Owner"
                  options={[
                    { value: "", label: "Unassigned" },
                    ...users.map((u) => ({ value: u.id, label: u.name })),
                  ]}
                />
              )}
            />
          </Field>
          <div />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Start" htmlFor="task-start">
            <input
              id="task-start"
              type="date"
              className={inputClass}
              {...register("start_date", { setValueAs: (v) => (v === "" ? null : v) })}
            />
          </Field>
          <Field label="Due date" htmlFor="task-due">
            <input
              id="task-due"
              type="date"
              className={inputClass}
              {...register("due_date", { setValueAs: (v) => (v === "" ? null : v) })}
            />
          </Field>
          <Field label="Estimate (days)" error={errors.estimate_days?.message} htmlFor="task-estimate">
            <input
              id="task-estimate"
              type="number"
              min={0}
              step="0.5"
              placeholder="—"
              className={inputClass}
              {...register("estimate_days", {
                setValueAs: (v) => (v === "" || v == null ? null : Number(v)),
              })}
            />
          </Field>
        </div>

        <Field label="Description" htmlFor="task-description">
          <textarea
            id="task-description"
            rows={3}
            placeholder="Add a description…"
            className={inputClass + " resize-none"}
            {...register("description", { setValueAs: (v) => (v === "" ? null : v) })}
          />
        </Field>

        {/* Dependencies */}
        <DependencyPicker
          label="Prerequisites"
          icon={<IconArrowLeft size={11} strokeWidth={1.5} className="text-blue-300" />}
          ids={prereqIds}
          tasks={allTasks}
          tasksById={tasksById}
          excludeIds={stagedSet}
          onAdd={(id) => setPrereqIds((p) => [...p, id])}
          onRemove={(id) => setPrereqIds((p) => p.filter((x) => x !== id))}
        />
        <DependencyPicker
          label="Dependents"
          icon={<IconArrowRight size={11} strokeWidth={1.5} className="text-amber-300" />}
          ids={dependentIds}
          tasks={allTasks}
          tasksById={tasksById}
          excludeIds={stagedSet}
          onAdd={(id) => setDependentIds((p) => [...p, id])}
          onRemove={(id) => setDependentIds((p) => p.filter((x) => x !== id))}
        />
      </form>
    </FloatingWindow>
  );
}

function DependencyPicker({
  label,
  icon,
  ids,
  tasks,
  tasksById,
  excludeIds,
  onAdd,
  onRemove,
}: {
  label: string;
  icon: React.ReactNode;
  ids: string[];
  tasks: ReadonlyArray<TaskRow>;
  tasksById: Map<string, TaskRow>;
  excludeIds: ReadonlySet<string>;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-helios-dim">{label}</span>
      <TaskLookup
        tasks={tasks}
        excludeIds={excludeIds}
        onSelect={onAdd}
        placeholder={`Add a ${label.toLowerCase().replace(/s$/, "")} by title…`}
      />
      {ids.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {ids.map((id) => {
            const t = tasksById.get(id);
            if (!t) return null;
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded border border-helios-line bg-helios-base/40 px-2 py-1.5 text-xs"
              >
                {icon}
                <span
                  aria-hidden
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: t.subteam.color ?? "#6B7280" }}
                />
                <span className="flex-1 truncate text-helios-text">{t.title}</span>
                <button
                  type="button"
                  onClick={() => onRemove(id)}
                  aria-label={`Remove ${t.title}`}
                  className="rounded p-0.5 text-helios-dim hover:bg-helios-base hover:text-red-400"
                >
                  <IconX size={12} strokeWidth={1.5} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

const inputClass =
  "w-full rounded border border-helios-line bg-helios-base px-2.5 py-1.5 text-sm text-helios-text " +
  "placeholder:text-helios-dim focus:border-asu-gold focus:outline-none disabled:opacity-60";

function Field({
  label,
  error,
  htmlFor,
  title,
  children,
}: {
  label: string;
  error?: string;
  htmlFor?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1.5" title={title}>
      <span className="text-xs font-medium uppercase tracking-wide text-helios-dim">
        {label}
      </span>
      {children}
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </label>
  );
}
