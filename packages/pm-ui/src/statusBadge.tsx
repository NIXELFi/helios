import type { TaskStatus } from "./types";
import { STATUS_DOT_CLASS, STATUS_LABEL } from "./statusMeta";

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-helios-text font-normal">
      <span aria-hidden className={`size-2 rounded-full ${STATUS_DOT_CLASS[status]}`} />
      <span>{STATUS_LABEL[status]}</span>
    </span>
  );
}
