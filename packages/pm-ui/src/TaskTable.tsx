import type { TaskRow } from "./types";
import { StatusBadge } from "./statusBadge";
import { TypeBadge } from "./typeBadge";

export interface TaskTableProps {
  tasks: ReadonlyArray<TaskRow>;
  emptyMessage?: string;
}

// Simple read-only table — used by the part-centric Vault view and any other
// surface that just needs to render a few rows. The full interactive table
// lives in apps/web and reads from the pm store directly.
export function TaskTable({ tasks, emptyMessage = "No tasks yet." }: TaskTableProps) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-md border border-helios-line bg-helios-panel p-8 text-center text-helios-dim">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-helios-line bg-helios-panel">
      <table className="w-full text-left text-sm text-helios-text">
        <thead className="border-b border-helios-line text-helios-dim">
          <tr>
            <th className="px-4 py-3 font-medium">Title</th>
            <th className="px-4 py-3 font-medium">Type</th>
            <th className="px-4 py-3 font-medium">Subteam</th>
            <th className="px-4 py-3 font-medium">Owner</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Due</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-helios-line">
          {tasks.map((task) => (
            <tr key={task.id} className="hover:bg-helios-base/40">
              <td className="px-4 py-3 font-normal">{task.title}</td>
              <td className="px-4 py-3">
                <TypeBadge type={task.type} />
              </td>
              <td className="px-4 py-3">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: task.subteam.color ?? "#6B7280" }}
                  />
                  {task.subteam.name}
                </span>
              </td>
              <td className="px-4 py-3">
                {task.owner ? task.owner.name : <span className="text-helios-dim">Unassigned</span>}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={task.status} />
              </td>
              <td className="px-4 py-3 tabular-nums">
                {task.due_date ?? <span className="text-helios-dim">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
