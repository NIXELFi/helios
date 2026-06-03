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
} from "@helios/pm-ui";
import { IconArrowLeft, IconArrowRight, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { FloatingWindow } from "@pm/components/ui/FloatingWindow";
import { Select, type SelectOption } from "@pm/components/ui/Select";
import { TaskLookup } from "@pm/components/TaskLookup";
import { usePmStore } from "@pm/lib/pmStore";

const createTaskInput = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  type: z.enum(["part", "drawing", "simulation", "assembly", "analysis", "test", "general"]),
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

  const initialSubteamId = defaultSubteamId ?? subteams[0]?.id ?? "";

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

  const watchedSubteamId = watch("subteam_id");

  const teamSubsystems = useMemo(
    () => subsystems.filter((s) => s.subteam_id === watchedSubteamId),
    [subsystems, watchedSubteamId],
  );

  useEffect(() => {
    if (open) {
      reset(defaults);
      setPrereqIds([]);
      setDependentIds([]);
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
      subteam,
      subsystem,
      owner,
    };

    onCreate(task);
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
          <Field label="Subteam" error={errors.subteam_id?.message}>
            <Controller
              control={control}
              name="subteam_id"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onChange={field.onChange}
                  ariaLabel="Subteam"
                  options={subteams.map((s) => ({
                    value: s.id,
                    label: s.name,
                    swatch: s.color ?? "#6B7280",
                  }))}
                />
              )}
            />
          </Field>
          <Field label="Subsystem">
            <Controller
              control={control}
              name="subsystem_id"
              render={({ field }) => (
                <Select
                  value={field.value ?? ""}
                  onChange={(v) => field.onChange(v === "" ? null : v)}
                  disabled={teamSubsystems.length === 0}
                  ariaLabel="Subsystem"
                  options={[
                    { value: "", label: "—" },
                    ...teamSubsystems.map((s) => ({ value: s.id, label: s.name })),
                  ]}
                />
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
