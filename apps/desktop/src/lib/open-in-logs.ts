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
import type { Lap, LapRef, LapSet } from "@helios/lib";

const EVENT = "helios:open-in-logs";

/**
 * A lap of one of the files being opened.
 *
 * `lap` is the LAP NUMBER as the file's own lap table numbers it -- `Lap.index`
 * in Logs, not a position in `LapSet.laps`. For a simulator run the two tables
 * agree by construction: the simulator pulses `system.beacon` at the start
 * line and at every lap close, Logs takes each rising edge as a crossing, and
 * the segment between crossing k and k+1 is Logs lap k -- which is the
 * simulator's `laps[].lap` k. Whatever came before the green flag is Logs lap
 * 0, the untrusted out lap, which is why the array position is NOT the lap
 * number and must not be used as one.
 */
export interface OpenInLogsLap {
  path: string;
  lap: number;
}

/**
 * What to do once the files are open: which lap is Main, which is Ref, and a
 * window to zoom to. Every part optional; any part that cannot be resolved
 * against what actually loaded is simply skipped.
 */
export interface OpenInLogsSelection {
  main?: OpenInLogsLap;
  ref?: OpenInLogsLap;
  /** Seconds on the file's own clock (its time column), not on the lap's. */
  zoom?: { path: string; startS: number; endS: number };
  /** A workspace to bring up, if the user still has one with this id. */
  workspace?: string;
}

export interface OpenInLogsDetail {
  paths: string[];
  /** Shown in the Logs session list. Optional; the filename is used if absent. */
  label?: string;
  /** Per-path labels, index for index with `paths`; a missing entry falls
   *  back to `label`. Two runs opened together are two different things and
   *  should not share a name. */
  labels?: (string | undefined)[];
  selection?: OpenInLogsSelection;
}

export interface OpenInLogsOptions {
  labels?: (string | undefined)[];
  selection?: OpenInLogsSelection;
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
export function requestOpenInLogs(paths: string[], label?: string, options: OpenInLogsOptions = {}): void {
  if (!paths.length) return;
  const detail: OpenInLogsDetail = { paths, label, ...options };
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

/** The label a given path should be opened under, if any. */
export function labelForPath(detail: OpenInLogsDetail, index: number): string | undefined {
  return detail.labels?.[index] || detail.label || undefined;
}

/** A loaded session, as far as resolving a selection needs one. */
export interface OpenedSession {
  id: string;
  sourcePath?: string;
  laps: LapSet | null;
}

export interface ResolvedSelection {
  main: LapRef | null;
  ref: LapRef | null;
  zoom: { startUs: number; endUs: number } | null;
  /** The session the zoom is on, which should become the primary: the zoom
   *  is a range on its clock. */
  primaryId: string | null;
}

/** Index into `set.laps` of the lap NUMBERED `lap`; a trusted one first. */
export function lapIndexForNumber(set: LapSet | null, lap: number): number {
  if (!set) return -1;
  const match = (l: Lap) => l.index === lap;
  const trusted = set.laps.findIndex((l) => match(l) && l.trusted);
  return trusted >= 0 ? trusted : set.laps.findIndex(match);
}

/**
 * Turn a selection by path and lap number into one by session and lap index.
 *
 * Pure, so the mapping that matters -- a simulator lap number to a Logs lap --
 * is tested rather than trusted. See `OpenInLogsLap` for why it is `Lap.index`
 * and not the array position.
 *
 * The zoom is in seconds on the file's own clock, and a CSV's `time_s` column
 * is loaded as microseconds with no rebasing, so the range is simply scaled.
 * A little either side, so the sector's entry and exit are both on screen.
 */
export function resolveOpenSelection(
  selection: OpenInLogsSelection,
  sessions: OpenedSession[],
  padS = 0.5,
): ResolvedSelection {
  const byPath = (p: string) => sessions.find((s) => s.sourcePath === p) ?? null;
  const pick = (l: OpenInLogsLap | undefined): LapRef | null => {
    if (!l) return null;
    const s = byPath(l.path);
    const i = lapIndexForNumber(s?.laps ?? null, l.lap);
    return s && i >= 0 ? { sessionId: s.id, lapIndex: i } : null;
  };
  let zoom: ResolvedSelection["zoom"] = null;
  let primaryId: string | null = null;
  const z = selection.zoom;
  if (z && Number.isFinite(z.startS) && Number.isFinite(z.endS) && z.endS > z.startS) {
    const s = byPath(z.path);
    if (s) {
      zoom = {
        startUs: Math.round(Math.max(0, z.startS - padS) * 1_000_000),
        endUs: Math.round((z.endS + padS) * 1_000_000),
      };
      primaryId = s.id;
    }
  }
  const main = pick(selection.main);
  if (!primaryId && main) primaryId = main.sessionId;
  return { main, ref: pick(selection.ref), zoom, primaryId };
}
