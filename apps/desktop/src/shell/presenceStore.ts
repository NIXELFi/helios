import { useSyncExternalStore } from "react";
import type { PresenceUser } from "./useHeliosPresence";

// Kept apart from useHeliosPresence.ts: that file imports MODULE_ICON from
// ModulePicker, and ModulePicker reads the roster through this one, so a value
// import between those two would be a cycle.

/** Same people, same modules, same connection counts and "online since"? */
export function sameRoster(a: readonly PresenceUser[], b: readonly PresenceUser[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.userId !== y.userId ||
      x.name !== y.name ||
      x.subteam !== y.subteam ||
      x.module !== y.module ||
      x.since !== y.since ||
      x.connections !== y.connections
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The roster lives OUTSIDE React state. It used to be state on the Shell, so
 * every presence sync/join/leave (a teammate opening Helios, switching module,
 * a socket blip) re-rendered the whole Shell and every mounted module under
 * it, on every client. Now only the component that shows the roster
 * subscribes (see `usePresenceRoster`), and a sync that changes nothing
 * notifies no one.
 */
export interface PresenceStore {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => PresenceUser[];
}

const EMPTY_ROSTER: PresenceUser[] = [];

export function createPresenceStore(): PresenceStore & { set: (next: PresenceUser[]) => void } {
  let roster: PresenceUser[] = EMPTY_ROSTER;
  const listeners = new Set<() => void>();
  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    getSnapshot: () => roster,
    set(next) {
      if (sameRoster(roster, next)) return;
      roster = next.length === 0 ? EMPTY_ROSTER : next;
      for (const l of listeners) l();
    },
  };
}

/** Subscribe to the live roster. Re-renders only when it actually changes. */
export function usePresenceRoster(store: PresenceStore): PresenceUser[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
