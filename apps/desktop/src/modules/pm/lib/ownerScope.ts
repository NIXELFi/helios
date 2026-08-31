import type { SelectOption } from "@pm/components/ui/Select";
import type { TaskRow, User } from "@helios/pm-ui";

// Reported 2026-08-26 (Data Acquisition): "I want the options for owners to be
// limited to those in my subteam, its annoying to search through the whole team
// directory."
//
// Deliberately a RANKING, not a filter. Two reasons:
//   1. Membership data is incomplete — only 41 of 107 directory entries carry a
//      pm.subteam_memberships row — so filtering on it would hide most of the
//      team from every picker.
//   2. Cross-subteam assignment is a real workflow (a Chassis task owned by the
//      person doing the welding). Hiding those people would break it.
// So the subteam's own people come first under their own heading, and everyone
// else stays reachable one scroll — or one keystroke of the Select's search —
// below.

/**
 * Everyone who counts as "in" `subteamId`: an explicit membership row, plus
 * anyone already owning or co-owning a task that belongs to that subteam. The
 * second source is what keeps the list useful while memberships are sparse — if
 * you're doing this subteam's work, you belong at the top of its owner picker.
 */
export function usersInSubteam(
  users: ReadonlyArray<User>,
  tasks: ReadonlyArray<TaskRow>,
  subteamId: string | null,
): Set<string> {
  const out = new Set<string>();
  if (!subteamId) return out;

  for (const u of users) {
    if (u.subteam_ids?.includes(subteamId)) out.add(u.id);
  }

  for (const t of tasks) {
    const belongs = (t.subteams ?? []).length
      ? t.subteams.some((s) => s.id === subteamId)
      : t.subteam_id === subteamId;
    if (!belongs) continue;
    if (t.owner_id) out.add(t.owner_id);
    for (const o of t.owners ?? []) out.add(o.id);
  }

  return out;
}

/** Split a directory into [this subteam's people, everyone else], each keeping
 *  the directory's own (alphabetical) order. */
export function partitionBySubteam(
  users: ReadonlyArray<User>,
  inTeam: ReadonlySet<string>,
): { inTeam: User[]; others: User[] } {
  const a: User[] = [];
  const b: User[] = [];
  for (const u of users) (inTeam.has(u.id) ? a : b).push(u);
  return { inTeam: a, others: b };
}

/**
 * Build grouped owner options for a <Select>. When no subteam is in scope — or
 * nobody could be attributed to it — this degrades to exactly the old flat,
 * alphabetical list, so nothing regresses for an unscoped picker.
 */
export function ownerOptions(
  users: ReadonlyArray<User>,
  tasks: ReadonlyArray<TaskRow>,
  subteamId: string | null,
  subteamName: string | null,
): SelectOption<string>[] {
  const scoped = usersInSubteam(users, tasks, subteamId);
  const { inTeam, others } = partitionBySubteam(users, scoped);
  if (inTeam.length === 0 || others.length === 0) {
    return users.map((u) => ({ value: u.id, label: u.name }));
  }
  const teamLabel = subteamName ? `${subteamName} · this subteam` : "This subteam";
  return [
    ...inTeam.map((u) => ({ value: u.id, label: u.name, group: teamLabel })),
    ...others.map((u) => ({ value: u.id, label: u.name, group: "Everyone else" })),
  ];
}
