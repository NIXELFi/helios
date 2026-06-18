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

export class ViewStateEmitter {
  #state: ViewState = { datums: [], zoomRange: null };
  #listeners = new Set<ViewStateListener>();

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
    this.set({ ...this.#state, zoomRange: next });
  }

  resetZoom(): void { this.setZoom(null); }

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
