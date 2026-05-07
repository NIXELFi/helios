/* Coordination emitter for "click on the GPS track to pick a coordinate"
 * flows. The Lap Config dialog calls `begin()`, the GPS Track widget
 * subscribes and on the next click projects pixel → lat/lon → `emitResult()`.
 *
 * Modeled after CursorEmitter / ViewStateEmitter — tiny pub/sub so consumers
 * can react without React re-renders. There is at most one active pick at a
 * time. `requestId` lets the caller distinguish their result from someone
 * else's if multiple consumers ever queue.
 */

export interface GpsPickRequest {
  /** Caller-provided id. Echoed back on `result` so the requestor can
   *  ignore picks they didn't initiate. */
  requestId: string;
  /** Hint shown to the user while the picker is armed (e.g. "Click on the
   *  track to set start-finish line"). */
  prompt: string;
}

export interface GpsPickResult {
  requestId: string;
  lat: number;
  lon: number;
}

export type GpsPickerStateListener = (state: GpsPickRequest | null) => void;
export type GpsPickerResultListener = (result: GpsPickResult) => void;

export class GpsPickerEmitter {
  #request: GpsPickRequest | null = null;
  #state = new Set<GpsPickerStateListener>();
  #results = new Set<GpsPickerResultListener>();

  subscribeState(cb: GpsPickerStateListener): () => void {
    this.#state.add(cb);
    return () => this.#state.delete(cb);
  }

  subscribeResult(cb: GpsPickerResultListener): () => void {
    this.#results.add(cb);
    return () => this.#results.delete(cb);
  }

  get(): GpsPickRequest | null { return this.#request; }

  begin(request: GpsPickRequest): void {
    this.#request = request;
    for (const cb of this.#state) cb(request);
  }

  cancel(): void {
    if (!this.#request) return;
    this.#request = null;
    for (const cb of this.#state) cb(null);
  }

  /** Called by the GPS widget after projecting a click back to lat/lon.
   *  Closes the picker and notifies result listeners. */
  emitResult(lat: number, lon: number): void {
    const req = this.#request;
    if (!req) return;
    const result: GpsPickResult = { requestId: req.requestId, lat, lon };
    this.#request = null;
    for (const cb of this.#state) cb(null);
    for (const cb of this.#results) cb(result);
  }
}
