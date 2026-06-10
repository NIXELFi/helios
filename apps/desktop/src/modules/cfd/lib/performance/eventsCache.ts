// Cross-render cache for per-trial FSAE event scores. computeEvents runs three
// physics sims (~3 ms after the vCorner memo; was ~50 ms before), and the
// optimization results screen needs it for EVERY trial — recomputing the whole
// study on each state-identity churn (a live trial landing, a rehydrate) is
// what froze the app on large studies. Trials are immutable once done, so the
// result is cached by CONTENT key, not object identity: re-renders and reducer
// rebuilds hit the cache, and only genuinely new trials pay for a sim.
//
// `ctxKey` is everything the score depends on besides the trial itself
// (serialized vehicle + baseline): when it changes, every entry is stale, so
// the whole cache drops. One context is live at a time, which also bounds
// memory without an LRU.

import type { EventScores } from "./events";

const cache = new Map<string, EventScores>();
let cacheCtx: string | null = null;

export function cachedTrialEvents(
  ctxKey: string,
  trialKey: string,
  compute: () => EventScores,
): EventScores {
  if (ctxKey !== cacheCtx) {
    cache.clear();
    cacheCtx = ctxKey;
  }
  let hit = cache.get(trialKey);
  if (hit === undefined) {
    hit = compute();
    cache.set(trialKey, hit);
  }
  return hit;
}

/** Test seam. */
export function _eventsCacheSize(): number {
  return cache.size;
}
