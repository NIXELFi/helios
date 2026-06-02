"use client";

import type { TaskPriority, TaskRow, TaskStatus, TaskType } from "@helios/pm-ui";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  TypeBadge,
  criticalityFill,
  daysUntilDue,
  taskOutline,
} from "@helios/pm-ui";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCornerDownRight,
  IconFlag,
  IconPlus,
  IconSend,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useMemo } from "react";
import { CreateTaskDialog } from "@pm/components/CreateTaskDialog";
import { TaskLookup } from "@pm/components/TaskLookup";
import { Select, type SelectOption } from "@pm/components/ui/Select";
import { useState } from "react";
import { usePmStore } from "@pm/lib/pmStore";

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  designing: "Designing",
  manufacturing: "Manufacturing",
  testing: "Testing",
  needs_review: "Needs review",
  blocked: "Blocked",
  done: "Done",
};

const STATUS_DOT: Record<TaskStatus, string> = {
  backlog: "#9097A0",
  designing: "#60A5FA",
  manufacturing: "#FBBF24",
  testing: "#A78BFA",
  needs_review: "#FFC627",
  blocked: "#F87171",
  done: "#34D399",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const TYPE_LABEL: Record<TaskType, string> = {
  part: "Part",
  drawing: "Drawing",
  simulation: "Simulation",
  assembly: "Assembly",
  analysis: "Analysis",
  test: "Test",
  general: "General",
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

export function TaskDetailSheet() {
  const selectedTaskId = usePmStore((s) => s.selectedTaskId);
  const selectTask = usePmStore((s) => s.selectTask);
  const tasks = usePmStore((s) => s.tasks);
  const subteams = usePmStore((s) => s.subteams);
  const subsystems = usePmStore((s) => s.subsystems);
  const users = usePmStore((s) => s.users);
  const deps = usePmStore((s) => s.dependencies);
  const projectId = usePmStore((s) => s.projectId);
  const updateTask = usePmStore((s) => s.updateTask);
  const addTask = usePmStore((s) => s.addTask);
  const addDependency = usePmStore((s) => s.addDependency);
  const removeDependency = usePmStore((s) => s.removeDependency);
  const deleteTask = usePmStore((s) => s.deleteTask);
  const allComments = usePmStore((s) => s.comments);
  const addComment = usePmStore((s) => s.addComment);
  const currentUserId = usePmStore((s) => s.currentUserId);

  const task = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId) ?? null
    : null;

  const [subtaskDialogOpen, setSubtaskDialogOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");

  const comments = useMemo(
    () =>
      task
        ? allComments
            .filter((c) => c.task_id === task.id)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
        : [],
    [allComments, task],
  );
  const userName = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users) m.set(u.id, u.name);
    return m;
  }, [users]);

  // Recompute when task changes
  const subtasks = useMemo(
    () => (task ? tasks.filter((t) => t.parent_task_id === task.id) : []),
    [tasks, task],
  );
  const predecessors = useMemo(
    () =>
      task
        ? deps
            .filter((d) => d.successor_id === task.id)
            .map((d) => ({ dep: d, task: tasks.find((t) => t.id === d.predecessor_id) }))
            .filter((x): x is { dep: typeof x.dep; task: TaskRow } => Boolean(x.task))
        : [],
    [deps, tasks, task],
  );
  const successors = useMemo(
    () =>
      task
        ? deps
            .filter((d) => d.predecessor_id === task.id)
            .map((d) => ({ dep: d, task: tasks.find((t) => t.id === d.successor_id) }))
            .filter((x): x is { dep: typeof x.dep; task: TaskRow } => Boolean(x.task))
        : [],
    [deps, tasks, task],
  );

  const teamSubsystems = task
    ? subsystems.filter((s) => s.subteam_id === task.subteam_id)
    : [];

  // Tasks already linked (either direction) plus self — excluded from the lookups.
  const depExcludeIds = useMemo(() => {
    const set = new Set<string>();
    if (task) set.add(task.id);
    for (const p of predecessors) set.add(p.task.id);
    for (const s of successors) set.add(s.task.id);
    return set;
  }, [task, predecessors, successors]);

  if (!task) return null;

  const outline = taskOutline(task);
  const countdown = daysUntilDue(task.due_date);

  return (
    <>
      <button
        type="button"
        aria-label="Close detail panel"
        onClick={() => selectTask(null)}
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]"
      />
      <aside
        className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-[540px] flex-col border-l border-helios-line bg-helios-panel shadow-2xl"
        role="dialog"
        aria-label={`Task: ${task.title}`}
      >
        <header
          className="flex items-start gap-3 border-b border-helios-line px-5 py-4"
          style={{
            borderLeftWidth: 4,
            borderLeftColor: outline.borderColor,
            borderLeftStyle: "solid",
          }}
        >
          <div className="flex-1">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <span
                className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest"
                style={{ color: task.subteam.color ?? "#9097A0" }}
              >
                <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: task.subteam.color ?? "#6B7280" }} />
                {task.subteam.name}
              </span>
              {task.subsystem ? (
                <span className="text-[10px] font-normal text-helios-dim">
                  · {task.subsystem.name}
                </span>
              ) : null}
              <TypeBadge type={task.type} />
            </div>
            <input
              type="text"
              value={task.title}
              onChange={(e) => updateTask(task.id, { title: e.target.value })}
              className="w-full bg-transparent text-lg font-medium text-helios-text outline-none focus:bg-helios-base/40 rounded px-1 -mx-1"
            />
          </div>
          <button
            type="button"
            onClick={() => selectTask(null)}
            className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-helios-text"
            aria-label="Close"
          >
            <IconX size={16} strokeWidth={1.5} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Top: status + due countdown */}
          <div className="mb-4 grid grid-cols-2 gap-3">
            <StatBox label="Status">
              <Select
                value={task.status}
                onChange={(v) => updateTask(task.id, { status: v })}
                options={STATUS_OPTIONS}
                ariaLabel="Status"
              />
            </StatBox>

            <StatBox label="Countdown">
              <CountdownPill days={countdown} state={outline.state} />
            </StatBox>
          </div>

          {/* Owner / Priority / Type / MRL */}
          <div className="mb-4 grid grid-cols-2 gap-3">
            <Field label="Owner">
              <Select
                value={task.owner_id ?? ""}
                onChange={(v) => updateTask(task.id, { owner_id: v || null })}
                ariaLabel="Owner"
                options={[
                  { value: "", label: "Unassigned" },
                  ...users.map((u) => ({ value: u.id, label: u.name })),
                ]}
              />
            </Field>

            <Field label="Priority">
              <Select
                value={task.priority}
                onChange={(v) => updateTask(task.id, { priority: v })}
                options={PRIORITY_OPTIONS}
                ariaLabel="Priority"
              />
            </Field>

            <Field label="Type">
              <Select
                value={task.type}
                onChange={(v) => updateTask(task.id, { type: v })}
                options={TYPE_OPTIONS}
                ariaLabel="Type"
              />
            </Field>

            <Field label="MRL" title="Manufacturing Readiness Level (1–9)">
              <input
                type="number"
                min={1}
                max={9}
                value={task.mrl ?? ""}
                onChange={(e) =>
                  updateTask(task.id, { mrl: e.target.value ? Number(e.target.value) : null })
                }
                placeholder="—"
                className={selectStyle}
              />
            </Field>
          </div>

          {/* Subteam + Subsystem */}
          <div className="mb-4 grid grid-cols-2 gap-3">
            <Field label="Subteam">
              <Select
                value={task.subteam_id}
                onChange={(v) => updateTask(task.id, { subteam_id: v, subsystem_id: null })}
                ariaLabel="Subteam"
                options={subteams.map((s) => ({
                  value: s.id,
                  label: s.name,
                  swatch: s.color ?? "#6B7280",
                }))}
              />
            </Field>
            <Field label="Subsystem">
              <Select
                value={task.subsystem_id ?? ""}
                onChange={(v) => updateTask(task.id, { subsystem_id: v || null })}
                disabled={teamSubsystems.length === 0}
                ariaLabel="Subsystem"
                options={[
                  { value: "", label: "—" },
                  ...teamSubsystems.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            </Field>
          </div>

          {/* Dates + estimate */}
          <div className="mb-4 grid grid-cols-3 gap-3">
            <Field label="Start">
              <input
                type="date"
                value={task.start_date ?? ""}
                onChange={(e) =>
                  updateTask(task.id, { start_date: e.target.value || null })
                }
                className={selectStyle}
              />
            </Field>
            <Field label="Due">
              <input
                type="date"
                value={task.due_date ?? ""}
                onChange={(e) =>
                  updateTask(task.id, { due_date: e.target.value || null })
                }
                className={selectStyle}
              />
            </Field>
            <Field label="Estimate (days)">
              <input
                type="number"
                min={0}
                step={0.5}
                value={task.estimate_days ?? ""}
                onChange={(e) =>
                  updateTask(task.id, { estimate_days: e.target.value ? Number(e.target.value) : null })
                }
                placeholder="—"
                className={selectStyle}
              />
            </Field>
          </div>

          {/* Description */}
          <div className="mb-4">
            <Field label="Description">
              <textarea
                value={task.description ?? ""}
                onChange={(e) =>
                  updateTask(task.id, { description: e.target.value || null })
                }
                placeholder="Add a description…"
                rows={3}
                className={selectStyle + " resize-none"}
              />
            </Field>
          </div>

          {/* Subtasks */}
          <Section
            title="Subtasks"
            count={subtasks.length}
            action={
              <button
                type="button"
                onClick={() => setSubtaskDialogOpen(true)}
                className="inline-flex items-center gap-1 rounded border border-helios-line bg-transparent px-2 py-0.5 text-[11px] font-normal text-helios-dim hover:bg-helios-base hover:text-helios-text"
              >
                <IconPlus size={12} strokeWidth={1.5} />
                Subtask
              </button>
            }
          >
            {subtasks.length === 0 ? (
              <p className="text-xs text-helios-dim">No subtasks.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {subtasks.map((st) => (
                  <li key={st.id}>
                    <button
                      type="button"
                      onClick={() => selectTask(st.id)}
                      className="flex w-full items-center gap-2 rounded border border-helios-line bg-helios-base/40 px-2 py-1.5 text-left text-xs hover:bg-helios-base"
                    >
                      <IconCornerDownRight size={12} strokeWidth={1.5} className="text-helios-dim" />
                      <span
                        aria-hidden
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: STATUS_DOT[st.status] }}
                      />
                      <span className="flex-1 text-helios-text">{st.title}</span>
                      <span className="text-helios-dim tabular-nums">{st.due_date ?? "—"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Comments */}
          <Section title="Comments" count={comments.length}>
            <div className="flex items-end gap-2">
              <textarea
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                placeholder="Add a comment…"
                rows={2}
                className={selectStyle + " flex-1 resize-none"}
              />
              <button
                type="button"
                disabled={commentDraft.trim().length === 0}
                onClick={() => {
                  const body = commentDraft.trim();
                  if (!body) return;
                  addComment({
                    id: crypto.randomUUID(),
                    task_id: task.id,
                    author_id: currentUserId || null,
                    body,
                    created_at: new Date().toISOString(),
                    kind: "general",
                  });
                  setCommentDraft("");
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded bg-asu-gold px-2.5 py-1.5 text-xs font-medium text-helios-base hover:bg-asu-gold/90 disabled:opacity-50"
                aria-label="Add comment"
              >
                <IconSend size={14} strokeWidth={1.5} />
              </button>
            </div>
            {comments.length === 0 ? (
              <p className="text-xs text-helios-dim">No comments yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {comments.map((c) => (
                  <li
                    key={c.id}
                    className="rounded border border-helios-line bg-helios-base/40 px-2.5 py-2"
                  >
                    <div className="mb-1 flex items-center gap-2 text-[11px] text-helios-dim">
                      <span className="font-medium text-helios-text">
                        {c.author_id ? userName.get(c.author_id) ?? "Unknown" : "System"}
                      </span>
                      <span>{relativeTime(c.created_at)}</span>
                      {c.kind === "drawing_review" ? (
                        <span className="inline-flex items-center rounded border border-red-400/40 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-red-300">
                          Drawing review
                        </span>
                      ) : null}
                    </div>
                    <p className="whitespace-pre-wrap text-xs text-helios-text">{c.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Dependencies — predecessors */}
          <Section title="Prerequisites" count={predecessors.length}>
            <TaskLookup
              tasks={tasks}
              excludeIds={depExcludeIds}
              onSelect={(id) =>
                addDependency({
                  predecessor_id: id,
                  successor_id: task.id,
                  dep_type: "FS",
                  lag_days: 0,
                })
              }
              placeholder="Add a prerequisite by title…"
            />
            {predecessors.length === 0 ? (
              <p className="text-xs text-helios-dim">None.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {predecessors.map(({ task: pt, dep }) => (
                  <li
                    key={pt.id}
                    className="flex items-center gap-2 rounded border border-helios-line bg-helios-base/40 px-2 py-1.5 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => selectTask(pt.id)}
                      className="flex flex-1 items-center gap-2 text-left hover:text-asu-gold"
                    >
                      <IconArrowLeft size={11} strokeWidth={1.5} className="text-blue-300" />
                      <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: pt.subteam.color ?? "#6B7280" }} />
                      <span className="flex-1 text-helios-text">{pt.title}</span>
                      {dep.lag_days > 0 ? (
                        <span className="text-[10px] text-helios-dim">+{dep.lag_days}d</span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeDependency(pt.id, task.id)}
                      aria-label={`Remove prerequisite ${pt.title}`}
                      className="rounded p-0.5 text-helios-dim hover:bg-helios-base hover:text-red-400"
                    >
                      <IconX size={12} strokeWidth={1.5} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Dependencies — successors */}
          <Section title="Dependents" count={successors.length}>
            <TaskLookup
              tasks={tasks}
              excludeIds={depExcludeIds}
              onSelect={(id) =>
                addDependency({
                  predecessor_id: task.id,
                  successor_id: id,
                  dep_type: "FS",
                  lag_days: 0,
                })
              }
              placeholder="Add a dependent by title…"
            />
            {successors.length === 0 ? (
              <p className="text-xs text-helios-dim">None.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {successors.map(({ task: st, dep }) => (
                  <li
                    key={st.id}
                    className="flex items-center gap-2 rounded border border-helios-line bg-helios-base/40 px-2 py-1.5 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => selectTask(st.id)}
                      className="flex flex-1 items-center gap-2 text-left hover:text-asu-gold"
                    >
                      <IconArrowRight size={11} strokeWidth={1.5} className="text-amber-300" />
                      <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: st.subteam.color ?? "#6B7280" }} />
                      <span className="flex-1 text-helios-text">{st.title}</span>
                      {dep.lag_days > 0 ? (
                        <span className="text-[10px] text-helios-dim">+{dep.lag_days}d</span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeDependency(task.id, st.id)}
                      aria-label={`Remove dependent ${st.title}`}
                      className="rounded p-0.5 text-helios-dim hover:bg-helios-base hover:text-red-400"
                    >
                      <IconX size={12} strokeWidth={1.5} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <footer className="flex items-center justify-between border-t border-helios-line bg-helios-base/40 px-5 py-3">
          <span className="text-[10px] text-helios-dim">
            {task.on_critical_path ? <span className="inline-flex items-center gap-1 text-asu-gold"><IconFlag size={10} strokeWidth={1.5} />On critical path</span> : null}
          </span>
          <button
            type="button"
            onClick={() => {
              if (confirm(`Delete task "${task.title}"? This cannot be undone.`)) {
                deleteTask(task.id);
                selectTask(null);
              }
            }}
            className="inline-flex items-center gap-1 rounded border border-helios-line bg-transparent px-2 py-1 text-xs font-normal text-helios-dim hover:border-red-400/40 hover:bg-helios-base hover:text-red-400"
          >
            <IconTrash size={12} strokeWidth={1.5} />
            Delete
          </button>
        </footer>
      </aside>

      <CreateTaskDialog
        open={subtaskDialogOpen}
        onClose={() => setSubtaskDialogOpen(false)}
        onCreate={(newTask) => {
          addTask({ ...newTask, parent_task_id: task.id, subteam_id: task.subteam_id, subteam: task.subteam });
        }}
        projectId={projectId}
        subteams={subteams}
        subsystems={subsystems}
        users={users}
        defaultSubteamId={task.subteam_id}
      />
    </>
  );
}

function Field({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1" title={title}>
      <span className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">
        {label}
      </span>
      {children}
    </label>
  );
}

function StatBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded border border-helios-line bg-helios-base/40 px-3 py-2">
      <span className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">
        {label}
      </span>
      {children}
    </div>
  );
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-widest text-helios-dim">
          {title}{typeof count === "number" ? ` · ${count}` : ""}
        </h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function CountdownPill({
  days,
  state,
}: {
  days: number | null;
  state: ReturnType<typeof taskOutline>["state"];
}) {
  if (days === null) {
    return <span className="text-sm text-helios-dim">No due date</span>;
  }
  let tone = "text-helios-text";
  if (state === "past_due") tone = "text-red-400";
  else if (state === "approaching") tone = "text-orange-300";
  else if (state === "done") tone = "text-emerald-400";
  const abs = Math.abs(days);
  const word = abs === 1 ? "day" : "days";
  return (
    <span className={`text-sm font-medium tabular-nums ${tone}`}>
      {days < 0
        ? `${abs} ${word} overdue`
        : days === 0
          ? "Due today"
          : `${abs} ${word} left`}
    </span>
  );
}

const selectStyle =
  "rounded border border-helios-line bg-helios-base px-2 py-1.5 text-sm text-helios-text " +
  "focus:border-asu-gold focus:outline-none disabled:opacity-60";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
