/** Microsecond tolerance for "is the cursor on this boundary?". The cursor is
 *  written as a rounded integer µs while lap boundaries are exact, so we treat
 *  anything within EPS_US of a boundary as sitting on it. Used symmetrically
 *  for both `[` and `]` so stepping is never sticky on one side. */
const EPS_US = 1000; // 1 ms

/**
 * Compute the cursor target for a `[`/`]` lap-boundary step on the primary
 * session.
 *
 * @param boundariesUs  Lap start times in µs, assumed ascending.
 * @param sessionStartUs  Session extent start; `[` clamps here when the cursor
 *   sits before the first lap boundary so the user can always rewind home.
 * @param cursorUs  Current cursor position in µs.
 * @param dir  "next" (`]`) or "prev" (`[`).
 * @returns the µs to emit, or null when there is nowhere to move.
 */
export function stepToLapBoundary(
  boundariesUs: number[],
  sessionStartUs: number,
  cursorUs: number,
  dir: "next" | "prev",
): number | null {
  if (boundariesUs.length === 0) return null;
  if (dir === "next") {
    // First boundary strictly ahead of the cursor (beyond the epsilon window,
    // so resting exactly on a boundary still advances).
    for (const b of boundariesUs) {
      if (b > cursorUs + EPS_US) return b;
    }
    return null;
  }
  // prev: last boundary strictly behind the cursor.
  let target: number | null = null;
  for (const b of boundariesUs) {
    if (b < cursorUs - EPS_US) target = b;
    else break;
  }
  if (target !== null) return target;
  // No earlier boundary. If the session extends before the first boundary and
  // the cursor isn't already at the session start, clamp home so `[` is never
  // a dead key on the opening segment.
  if (cursorUs > sessionStartUs + EPS_US) return sessionStartUs;
  return null;
}
