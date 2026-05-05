export type CursorListener = (timeUs: number) => void;

/**
 * Pub/sub cursor — bypasses React state to allow 100 Hz cursor moves
 * without triggering component re-renders. Widgets subscribe via ref
 * and update their canvas imperatively.
 */
export class CursorEmitter {
  #listeners = new Set<CursorListener>();
  #last = 0;

  subscribe(cb: CursorListener): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  emit(timeUs: number): void {
    this.#last = timeUs;
    for (const cb of this.#listeners) cb(timeUs);
  }

  get(): number { return this.#last; }
}
