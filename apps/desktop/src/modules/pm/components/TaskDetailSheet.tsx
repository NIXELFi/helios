"use client";

import type { TaskPriority, TaskRow, TaskStatus, TaskType } from "@helios/pm-ui";
import {
  STATUS_DOT,
  STATUS_LABEL,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  TypeBadge,
  computeCriticalPath,
  criticalityFill,
  daysUntilDue,
  taskOutline,
} from "@helios/pm-ui";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCornerDownRight,
  IconCornerLeftUp,
  IconExternalLink,
  IconFlag,
  IconLink,
  IconLock,
  IconPlus,
  IconSend,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo } from "react";
import { CreateTaskDialog } from "@pm/components/CreateTaskDialog";
import { TaskLookup } from "@pm/components/TaskLookup";
import { TaskOwnerChips } from "@pm/components/TaskOwnerChips";
import { TaskSubteamChips } from "@pm/components/TaskSubteamChips";
import { Select, type SelectOption } from "@pm/components/ui/Select";
import { useState } from "react";
import { selectCanEditTask, usePmStore } from "@pm/lib/pmStore";
import { SubsystemQuickCreate } from "@pm/components/SubsystemQuickCreate";
import { recallSharing, subsystemsForSubteam } from "@pm/lib/subsystemSharing";

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
  mfg_laser: "MFG-LZR",
  mfg_machine: "MFG-MCH",
  mfg_weld: "MFG-WELD",
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
  const allLinks = usePmStore((s) => s.links);
  const addLink = usePmStore((s) => s.addLink);
  const deleteLink = usePmStore((s) => s.deleteLink);
  const currentUserId = usePmStore((s) => s.currentUserId);
  const projectRoles = usePmStore((s) => s.projectRoles);

  const task = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId) ?? null
    : null;

  // Per-task edit permission, mirroring RLS, so the inline editors are disabled
  // (and the reason shown) when the signed-in user can't edit THIS task — not
  // just when they're a viewer. Without this, an engineer editing a task they
  // don't own would optimistically flip the value, have the write silently
  // rejected by RLS, and watch it snap back on the next refresh.
  const editPerm = task
    ? selectCanEditTask({ projectRoles, currentUserId }, task)
    : { allowed: true, reason: null };
  const canEdit = editPerm.allowed;

  // Live critical-path set — the DB `on_critical_path` flag is never populated,
  // so compute it from the same DAG the Gantt/Graph use (single source of truth).
  const criticalSet = useMemo(() => computeCriticalPath(tasks, deps), [tasks, deps]);

  const [subtaskDialogOpen, setSubtaskDialogOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [linkUrlDraft, setLinkUrlDraft] = useState("");
  const [linkLabelDraft, setLinkLabelDraft] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  const comments = useMemo(
    () =>
      task
        ? allComments
            .filter((c) => c.task_id === task.id)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
        : [],
    [allComments, task],
  );
  const links = useMemo(
    () =>
      task
        ? allLinks
            .filter((l) => l.task_id === task.id)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
        : [],
    [allLinks, task],
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
  const parentTask = useMemo(
    () => (task?.parent_task_id ? tasks.find((t) => t.id === task.parent_task_id) ?? null : null),
    [tasks, task],
  );
  // Tasks that can't be chosen as this task's parent: itself plus its whole
  // subtask subtree (choosing one would create a cycle).
  const parentExcludeIds = useMemo(() => {
    const set = new Set<string>();
    if (!task) return set;
    set.add(task.id);
    const childrenOf = new Map<string, string[]>();
    for (const t of tasks) {
      if (!t.parent_task_id) continue;
      const arr = childrenOf.get(t.parent_task_id) ?? [];
      arr.push(t.id);
      childrenOf.set(t.parent_task_id, arr);
    }
    const stack = [task.id];
    while (stack.length) {
      const id = stack.pop()!;
      for (const c of childrenOf.get(id) ?? []) {
        if (!set.has(c)) {
          set.add(c);
          stack.push(c);
        }
      }
    }
    return set;
  }, [tasks, task]);
  // Tasks that can't be added AS a subtask of this one: itself, its ancestors
  // (would create a cycle), and tasks already its direct children.
  const childExcludeIds = useMemo(() => {
    const set = new Set<string>();
    if (!task) return set;
    set.add(task.id);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    let cur = task.parent_task_id;
    while (cur && !set.has(cur)) {
      set.add(cur);
      cur = byId.get(cur)?.parent_task_id ?? null;
    }
    for (const st of subtasks) set.add(st.id);
    return set;
  }, [tasks, task, subtasks]);
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

  // Include subsystems shared into this task's subteam, mirroring the create
  // dialog and table editors — otherwise a shared subsystem can't be selected
  // when editing (see lib/subsystemSharing.ts).
  const sharing = useMemo(() => recallSharing(projectId), [projectId]);
  const teamSubsystems = task
    ? subsystemsForSubteam(subsystems, task.subteam_id, sharing)
    : [];
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);

  // When the PRIMARY subteam changes (e.g. promoted via the chips), a previously
  // chosen subsystem may no longer belong to it — clear it, matching the old
  // single-Select behavior that reset subsystem on a subteam switch.
  useEffect(() => {
    if (!task || !task.subsystem_id) return;
    if (!teamSubsystems.some((s) => s.id === task.subsystem_id)) {
      updateTask(task.id, { subsystem_id: null });
    }
  }, [task, teamSubsystems, updateTask]);

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
              disabled={!canEdit}
              onChange={(e) => updateTask(task.id, { title: e.target.value })}
              className="w-full bg-transparent text-lg font-medium text-helios-text outline-none focus:bg-helios-base/40 rounded px-1 -mx-1 disabled:opacity-100"
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
          {/* Read-only notice: tells the user WHY the fields are locked instead
              of letting an edit silently fail and revert on the next refresh. */}
          {!canEdit && editPerm.reason ? (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-950/40 px-3 py-2 text-xs text-amber-200/90">
              <IconLock size={14} strokeWidth={1.5} className="mt-0.5 shrink-0" />
              <span>{editPerm.reason}</span>
            </div>
          ) : null}
          {/* Top: status + due countdown */}
          <div className="mb-4 grid grid-cols-2 gap-3">
            <StatBox label="Status">
              <Select
                value={task.status}
                onChange={(v) => updateTask(task.id, { status: v })}
                options={STATUS_OPTIONS}
                disabled={!canEdit}
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
                disabled={!canEdit}
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
                disabled={!canEdit}
                ariaLabel="Priority"
              />
            </Field>

            <Field label="Type">
              <Select
                value={task.type}
                onChange={(v) => updateTask(task.id, { type: v })}
                options={TYPE_OPTIONS}
                disabled={!canEdit}
                ariaLabel="Type"
              />
            </Field>

            <Field label="MRL" title="Manufacturing Readiness Level (1–9)">
              <input
                type="number"
                min={1}
                max={9}
                value={task.mrl ?? ""}
                disabled={!canEdit}
                onChange={(e) =>
                  updateTask(task.id, { mrl: e.target.value ? Number(e.target.value) : null })
                }
                placeholder="—"
                className={selectStyle}
              />
            </Field>
          </div>

          {/* Co-owners (the Owner field above is the primary owner) */}
          <div className="mb-4">
            <Field label="Co-owners" title="Additional members who can edit this task">
              <div className="flex min-h-[30px] items-center">
                <TaskOwnerChips task={task} editable={canEdit} />
              </div>
            </Field>
          </div>

          {/* Subteams (multi, primary-starred) + Subsystem */}
          <div className="mb-4 grid grid-cols-2 gap-3">
            <Field label="Subteams">
              <div className="flex min-h-[30px] items-center">
                <TaskSubteamChips task={task} editable={canEdit} />
              </div>
            </Field>
            <Field label="Subsystem">
              <Select
                value={task.subsystem_id ?? ""}
                onChange={(v) => {
                  if (v === "__new-subsystem__") {
                    setQuickCreateOpen(true);
                    return;
                  }
                  updateTask(task.id, { subsystem_id: v || null });
                }}
                disabled={!canEdit}
                ariaLabel="Subsystem"
                options={[
                  { value: "", label: "—" },
                  ...teamSubsystems.map((s) => ({ value: s.id, label: s.name })),
                  ...(!canEdit ? [] : [{ value: "__new-subsystem__", label: "+ New subsystem…" }]),
                ]}
              />
              {quickCreateOpen && (
                <SubsystemQuickCreate
                  open
                  subteamId={task.subteam_id}
                  onClose={() => setQuickCreateOpen(false)}
                  onCreated={(id) => updateTask(task.id, { subsystem_id: id })}
                />
              )}
            </Field>
          </div>

          {/* Dates + estimate */}
          <div className="mb-4 grid grid-cols-3 gap-3">
            <Field label="Start">
              <input
                type="date"
                value={task.start_date ?? ""}
                disabled={!canEdit}
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
                disabled={!canEdit}
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
                disabled={!canEdit}
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
                disabled={!canEdit}
                onChange={(e) =>
                  updateTask(task.id, { description: e.target.value || null })
                }
                placeholder="Add a description…"
                rows={3}
                className={selectStyle + " resize-none"}
              />
            </Field>
          </div>

          {/* Parent task */}
          <Section title="Parent task">
            {parentTask ? (
              <div className="flex items-center gap-2 rounded border border-helios-line bg-helios-base/40 px-2 py-1.5 text-xs">
                <IconCornerLeftUp size={12} strokeWidth={1.5} className="text-helios-dim" />
                <span
                  aria-hidden
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: STATUS_DOT[parentTask.status] }}
                />
                <button
                  type="button"
                  onClick={() => selectTask(parentTask.id)}
                  className="flex-1 truncate text-left text-helios-text hover:underline"
                  title="Open parent task"
                >
                  {parentTask.title}
                </button>
                <button
                  type="button"
                  onClick={() => updateTask(task.id, { parent_task_id: null })}
                  className="shrink-0 rounded p-0.5 text-helios-dim hover:bg-helios-base hover:text-red-400"
                  aria-label="Detach from parent"
                  title="Detach from parent"
                >
                  <IconX size={12} strokeWidth={1.5} />
                </button>
              </div>
            ) : (
              <TaskLookup
                tasks={tasks}
                excludeIds={parentExcludeIds}
                onSelect={(id) => updateTask(task.id, { parent_task_id: id })}
                placeholder="Make this a subtask of… (pick a parent)"
              />
            )}
          </Section>

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
            {/* Attach an EXISTING task as a subtask — mirror of the parent picker. */}
            <div className="mt-1.5">
              <TaskLookup
                tasks={tasks}
                excludeIds={childExcludeIds}
                onSelect={(id) => updateTask(id, { parent_task_id: task.id })}
                placeholder="Add an existing task as a subtask…"
              />
            </div>
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

          {/* Links (hyperlinks to docs/drawings/specs) */}
          <Section title="Links" count={links.length}>
            {canEdit ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <input
                    type="url"
                    value={linkUrlDraft}
                    onChange={(e) => {
                      setLinkUrlDraft(e.target.value);
                      if (linkError) setLinkError(null);
                    }}
                    placeholder="https://…"
                    className={selectStyle + " flex-1"}
                  />
                  <input
                    type="text"
                    value={linkLabelDraft}
                    onChange={(e) => setLinkLabelDraft(e.target.value)}
                    placeholder="Label (optional)"
                    className={selectStyle + " w-40"}
                  />
                  <button
                    type="button"
                    disabled={linkUrlDraft.trim().length === 0}
                    onClick={() => {
                      const url = normalizeUrl(linkUrlDraft);
                      if (!url) {
                        setLinkError("Enter a valid http(s) URL.");
                        return;
                      }
                      addLink({
                        id: crypto.randomUUID(),
                        task_id: task.id,
                        url,
                        label: linkLabelDraft.trim() || null,
                        created_at: new Date().toISOString(),
                        created_by: currentUserId || null,
                      });
                      setLinkUrlDraft("");
                      setLinkLabelDraft("");
                      setLinkError(null);
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded bg-asu-gold px-2.5 py-1.5 text-xs font-medium text-helios-base hover:bg-asu-gold/90 disabled:opacity-50"
                    aria-label="Add link"
                  >
                    <IconPlus size={14} strokeWidth={1.5} />
                  </button>
                </div>
                {linkError ? (
                  <span className="text-[11px] text-red-400">{linkError}</span>
                ) : null}
              </div>
            ) : null}
            {links.length === 0 ? (
              <p className="text-xs text-helios-dim">No links.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {links.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-center gap-2 rounded border border-helios-line bg-helios-base/40 px-2 py-1.5 text-xs"
                  >
                    <IconLink size={12} strokeWidth={1.5} className="shrink-0 text-helios-dim" />
                    <button
                      type="button"
                      onClick={() => openExternalUrl(l.url)}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left text-helios-text hover:text-asu-gold"
                      title={l.url}
                    >
                      <span className="truncate">{l.label || linkDisplay(l.url)}</span>
                      <IconExternalLink size={11} strokeWidth={1.5} className="shrink-0 text-helios-dim" />
                    </button>
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={() => deleteLink(l.id)}
                        aria-label="Remove link"
                        className="shrink-0 rounded p-0.5 text-helios-dim hover:bg-helios-base hover:text-red-400"
                      >
                        <IconX size={12} strokeWidth={1.5} />
                      </button>
                    ) : null}
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
            {criticalSet.has(task.id) ? <span className="inline-flex items-center gap-1 text-asu-gold"><IconFlag size={10} strokeWidth={1.5} />On critical path</span> : null}
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

// Normalize a user-entered URL: add an https:// scheme if missing, and accept
// only http/https (the DB CHECK and the Rust opener enforce the same). Returns
// null when the value can't be made into a valid http(s) URL.
function normalizeUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

// A compact display string for a bare URL (host + path, no scheme/query).
function linkDisplay(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

// Open an external link in the system browser via the Tauri command. Best-effort:
// swallow errors (e.g. when running outside the desktop shell, as in tests).
function openExternalUrl(url: string): void {
  void invoke("open_external_url", { url }).catch(() => {});
}

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
