/**
 * Global, session-scoped view state shared across every chart in the app:
 * datum markers (vertical reference lines pinned to a timestamp) and an
 * optional zoom range that overrides the natural time-axis extent.
 *
 * Modeled after CursorEmitter — pub/sub with ref-based reads, so widgets
 * can react without React re-renders. Lives at App level; survives
 * workspace switches but resets on app restart.
 */

export interface ZoomRange {
  startUs: number;
  endUs: number;
}

export interface ViewState {
  datums: number[];                 // timestamps in microseconds, sorted ascending
  zoomRange: ZoomRange | null;
}

export type ViewStateListener = (state: ViewState) => void;

/** How many previous zoom ranges we remember for `popZoom`. Bounded so a long
 *  session of drag-zooming can't grow the stack without limit; 32 is far more
 *  levels than anyone walks back by hand, and evicting the oldest is harmless
 *  (the bottom of the stack is the least interesting history). */
const ZOOM_STACK_CAP = 32;

/** Value equality for zoom ranges. `null` (full view) is a real value here,
 *  not "unset" — it compares equal only to another null. */
function sameZoom(a: ZoomRange | null, b: ZoomRange | null): boolean {
  if (a === null || b === null) return a === b;
  return a.startUs === b.startUs && a.endUs === b.endUs;
}

export class ViewStateEmitter {
  #state: ViewState = { datums: [], zoomRange: null };
  #listeners = new Set<ViewStateListener>();
  /** Undo history for the zoom: each entry is the zoomRange that was active
   *  BEFORE a setZoom/resetZoom replaced it. `null` entries are legitimate —
   *  they mean "the full view", which is what you want to come back to after
   *  zooming in from an unzoomed chart. */
  #zoomStack: Array<ZoomRange | null> = [];

  subscribe(cb: ViewStateListener): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  get(): ViewState { return this.#state; }

  /** Replace the entire state. Used internally by the focused setters
   *  below; exposed so a future "reset everything" button can call it. */
  set(state: ViewState): void {
    this.#state = state;
    // Snapshot first: a listener may subscribe/unsubscribe during its own
    // callback, and mutating the Set mid-iteration would skip or double-fire.
    for (const cb of [...this.#listeners]) cb(state);
  }

  setZoom(range: ZoomRange | null): void {
    // Treat zero/negative-width ranges as "no zoom" — guards drag-zoom
    // interactions where the user accidentally clicks without dragging.
    const next = range && range.endUs > range.startUs ? range : null;
    // Redundant set: nothing changed, so don't push a duplicate onto the undo
    // stack (which would make `U` appear to do nothing) and don't notify.
    // Same no-op-is-silent convention the datum mutators below follow.
    if (sameZoom(next, this.#state.zoomRange)) return;
    this.#zoomStack.push(this.#state.zoomRange);
    if (this.#zoomStack.length > ZOOM_STACK_CAP) this.#zoomStack.shift();
    this.set({ ...this.#state, zoomRange: next });
  }

  /** Clear the zoom back to the full view. Goes through setZoom, so it lands
   *  on the undo stack like any other zoom change and `popZoom` can undo it. */
  resetZoom(): void { this.setZoom(null); }

  /** Step back one level of zoom history. Returns false (and changes nothing)
   *  when there's no history left, so a caller can distinguish "undid" from
   *  "nothing to undo". Does NOT push — undoing is not itself a zoom change,
   *  otherwise U would ping-pong between two ranges forever. */
  popZoom(): boolean {
    if (this.#zoomStack.length === 0) return false;
    const prev = this.#zoomStack.pop()!;
    // Entries are only pushed when they differ from what replaced them, so
    // `prev` is always a real change from the current range.
    this.set({ ...this.#state, zoomRange: prev });
    return true;
  }

  /** Depth of the zoom undo history. Exposed for tests and for UI that wants
   *  to disable a "zoom out" affordance when there's nothing to go back to. */
  zoomStackDepth(): number { return this.#zoomStack.length; }

  addDatum(timeUs: number): void {
    // Dedupe within 1µs and keep sorted so renderers can binary-search.
    const datums = this.#state.datums;
    if (datums.some((t) => Math.abs(t - timeUs) < 1)) return;
    const next = [...datums, timeUs].sort((a, b) => a - b);
    this.set({ ...this.#state, datums: next });
  }

  removeDatum(timeUs: number): void {
    const next = this.#state.datums.filter((t) => Math.abs(t - timeUs) >= 1);
    if (next.length === this.#state.datums.length) return;
    this.set({ ...this.#state, datums: next });
  }

  clearDatums(): void {
    if (this.#state.datums.length === 0) return;
    this.set({ ...this.#state, datums: [] });
  }
}
