/**
 * Shared "when" formatting for vault history surfaces (Recent check-ins rail,
 * History screen, file detail version list). Pure — `now` is injectable so
 * tests don't depend on the wall clock.
 */

/** Short relative time: "just now", "5m ago", "3h ago", "yesterday", "4d ago",
 *  then a plain date ("Mar 4" this year, "Mar 4, 2025" otherwise). Never the
 *  raw ISO string; "" for an unparseable timestamp. */
export function relativeWhen(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = now - t;
  // Clock skew (a version stamped a few seconds "in the future" by the server)
  // reads as just now rather than a full date.
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day}d ago`;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Full local date + time for tooltips: "Tue, Oct 28, 2026, 3:14 PM". */
export function absoluteWhen(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Label for a version/event author: "You" for the current user, else the
 *  resolved name, else a friendly placeholder (never a raw UUID). */
export function whoLabel(
  userId: string | null | undefined,
  names: ReadonlyMap<string, string>,
  currentUserId?: string | null,
): string {
  if (!userId) return "Unknown";
  if (currentUserId && userId === currentUserId) return "You";
  return names.get(userId) ?? "Unknown member";
}
