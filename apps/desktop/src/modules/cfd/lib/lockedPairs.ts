// Registry of in/out diameter pairs that may be "locked" together in
// optimization studies. Mirrors `LOCKABLE_DIAMETER_PAIRS` in
// `crates/cfd-core/src/params.rs`. Order matters: inlet is the leader.
//
// The UI uses this to decide which rows show the "Lock in/out" toggle
// and which rows should be force-dimmed as followers.

export interface LockableDiameterPair {
  readonly leader: string;
  readonly follower: string;
}

export const LOCKABLE_DIAMETER_PAIRS: readonly LockableDiameterPair[] = [
  { leader: "runner_diameter_in", follower: "runner_diameter_out" },
  { leader: "primary_diameter_in", follower: "primary_diameter_out" },
  { leader: "secondary_diameter_in", follower: "secondary_diameter_out" },
  { leader: "collector_diameter_in", follower: "collector_diameter_out" },
];

/** Return the follower path registered for this leader, or null. */
export function followerOf(path: string): string | null {
  return LOCKABLE_DIAMETER_PAIRS.find((p) => p.leader === path)?.follower ?? null;
}

/** Return the leader path registered for this follower, or null. */
export function leaderOf(path: string): string | null {
  return LOCKABLE_DIAMETER_PAIRS.find((p) => p.follower === path)?.leader ?? null;
}

/** Encode a path + perElement into the wire format (path or path[N]). */
export function withPerElement(path: string, perElement: number | null): string {
  return perElement === null ? path : `${path}[${perElement}]`;
}
