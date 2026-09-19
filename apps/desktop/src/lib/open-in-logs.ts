/* "Open this in Logs" — a one-way handoff from any module to the Logs module.
 *
 * The obvious alternative, lifting a callback into the Shell and threading it
 * down through every module's props, means the Shell has to know what each
 * module might want to hand over and every module in between has to carry a
 * prop it does not use. A window event is decoupled in exactly the way the
 * module rail already is: the sender names files, the Shell brings Logs to the
 * front, and Logs loads them. Neither end imports the other.
 *
 * The paths are ordinary data files (a simulator run's `telemetry.csv`, a
 * logger export), so what happens at the Logs end is the same
 * `handleAddSessionFiles` a drag-and-drop uses. Nothing here is a new ingest
 * path — it is the existing one, reached from somewhere else.
 */

import { useEffect } from "react";

const EVENT = "helios:open-in-logs";

export interface OpenInLogsDetail {
  paths: string[];
  /** Shown in the Logs session list. Optional; the filename is used if absent. */
  label?: string;
}

/**
 * Set when a request is made with nobody listening for it yet.
 *
 * Helios mounts a module on first visit and keeps it mounted, so on a fresh
 * launch the Logs app does not exist when the Sim module asks it to open a
 * file: the Shell's listener flips the active module, Logs mounts and
 * subscribes on the NEXT render, and the synchronous event has already gone.
 * The user lands in Logs looking at its boot state -- no telemetry, no error,
 * indistinguishable from the run simply being uninteresting.
 *
 * So the request is held until somebody subscribes and can act on it.
 */
let pending: OpenInLogsDetail | null = null;

/** Ask the Logs module to open these files, and the Shell to bring it up. */
export function requestOpenInLogs(paths: string[], label?: string): void {
  if (!paths.length) return;
  const detail: OpenInLogsDetail = { paths, label };
  pending = detail;
  window.dispatchEvent(new CustomEvent<OpenInLogsDetail>(EVENT, { detail }));
}

/**
 * Subscribe to those requests.
 *
 * Both the Shell (to switch modules) and the Logs app (to load the files)
 * listen. The handler is read through a ref-free dependency on purpose: the
 * caller passes a `useCallback`-stable function, and re-subscribing on every
 * render would drop events fired during the gap.
 */
export function useOpenInLogs(
  onRequest: (detail: OpenInLogsDetail) => void,
  options: { drainsPending?: boolean } = {},
): void {
  const { drainsPending = false } = options;
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<OpenInLogsDetail>).detail;
      if (!detail?.paths?.length) return;
      if (drainsPending) pending = null;
      onRequest(detail);
    }
    window.addEventListener(EVENT, handler);
    // A request made before this subscriber existed. Only the consumer that
    // actually LOADS the files drains it -- the Shell just switches module and
    // would otherwise swallow the request on behalf of a Logs app that has not
    // mounted yet.
    if (drainsPending && pending) {
      const detail = pending;
      pending = null;
      onRequest(detail);
    }
    return () => window.removeEventListener(EVENT, handler);
  }, [onRequest, drainsPending]);
}
