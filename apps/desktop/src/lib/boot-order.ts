/* Boot ordering for the Logs module's recent sessions.
 *
 * Launch used to open EVERY remembered session — parsing each CSV, computing
 * laps and math channels — before the first frame was painted, so a user with
 * a long history stared at the loading screen for as long as the slowest file
 * took. Only one session can be primary, so only one of them has to exist
 * before the app is usable; the rest can arrive behind the first paint.
 */

/** Ceiling on how many remembered sessions a launch reopens by itself,
 *  counting the one loaded before first paint. A months-long recents list
 *  should not turn into minutes of background parsing (and hundreds of MB of
 *  channel data) that the user never asked for. */
export const MAX_AUTO_REOPEN = 12;

export interface RecentsBootPlan {
  /** Loaded before the first paint; the loading screen clears once it is in. */
  first: string | null;
  /** Loaded afterwards, in recents order, and merged into the session list. */
  rest: string[];
}

/**
 * Split the recents list into the one session to load before first paint and
 * the rest to load in the background.
 *
 * `first` is the newest recent whose saved meta is NOT hidden, because that is
 * the session the app will make primary — picking a hidden one would leave the
 * user looking at an empty workspace while the visible session loaded behind
 * it. When every recent is hidden (the user switched them all off) it falls
 * back to `recents[0]`, matching the primary fallback in App.tsx.
 *
 * `rest` keeps recents order and is capped so the total never exceeds
 * MAX_AUTO_REOPEN.
 */
export function planRecentsBoot(
  recents: string[],
  isHidden: (path: string) => boolean,
): RecentsBootPlan {
  if (recents.length === 0) return { first: null, rest: [] };
  const first = recents.find((p) => !isHidden(p)) ?? recents[0]!;
  // Drop only the ONE entry chosen as first (by index, not by value) so a
  // duplicated path in the list still loads the copy that was not consumed.
  const firstIdx = recents.indexOf(first);
  const rest = recents
    .filter((_, i) => i !== firstIdx)
    .slice(0, MAX_AUTO_REOPEN - 1);
  return { first, rest };
}
