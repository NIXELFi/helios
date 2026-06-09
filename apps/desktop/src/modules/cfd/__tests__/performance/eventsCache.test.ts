import { describe, it, expect } from "vitest";

import { cachedTrialEvents, _eventsCacheSize } from "../../lib/performance/eventsCache";
import type { EventScores } from "../../lib/performance";

const fake = (n: number) => ({ totalPoints: n } as EventScores);

describe("cachedTrialEvents", () => {
  it("computes once per (ctx, trial) key and serves repeats from cache", () => {
    let calls = 0;
    const compute = () => { calls++; return fake(1); };
    const a = cachedTrialEvents("ctx1", "s1:0", compute);
    const b = cachedTrialEvents("ctx1", "s1:0", compute);
    expect(calls).toBe(1);
    expect(b).toBe(a); // same object — no recompute on state-identity churn
    cachedTrialEvents("ctx1", "s1:1", compute);
    expect(calls).toBe(2); // different trial → compute
  });

  it("clears when the context (vehicle/baseline) changes", () => {
    let calls = 0;
    const compute = () => { calls++; return fake(2); };
    cachedTrialEvents("ctxA", "s2:0", compute);
    cachedTrialEvents("ctxB", "s2:0", compute); // new vehicle/baseline → recompute
    expect(calls).toBe(2);
    expect(_eventsCacheSize()).toBe(1); // old context dropped
  });
});
