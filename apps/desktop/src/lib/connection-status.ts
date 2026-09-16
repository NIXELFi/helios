import { useSyncExternalStore } from "react";

/**
 * App-wide realtime connection health, published by useHeliosPresence (the
 * one channel every signed-in session holds) and read by the title bar's
 * ConnectionChip. "unknown" until the first subscribe result so a cold start
 * never flashes a scary chip; "down" covers CHANNEL_ERROR / TIMED_OUT /
 * CLOSED after the channel was up at least once, or the OS reporting no
 * network at all.
 */
export type ConnectionState = "unknown" | "up" | "down";

type Listener = () => void;
let current: ConnectionState = "unknown";
const listeners = new Set<Listener>();

export function publishConnectionState(next: ConnectionState): void {
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}
export function getConnectionState(): ConnectionState {
  return current;
}
export function subscribeConnectionState(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
/** Test-only. */
export function _resetConnectionState(): void {
  current = "unknown";
  listeners.clear();
}
export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(subscribeConnectionState, getConnectionState, getConnectionState);
}
