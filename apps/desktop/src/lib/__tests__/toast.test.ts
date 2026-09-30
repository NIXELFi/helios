import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTO_DISMISS_MS, ERROR_DISMISS_MS, createToastStore, type ToastItem } from "../toast";

describe("createToastStore", () => {
  afterEach(() => { vi.useRealTimers(); });

  const watch = (store: ReturnType<typeof createToastStore>) => {
    let last: ToastItem[] = [];
    store.subscribe((items) => { last = items; });
    return () => last;
  };

  it("auto-dismisses ordinary toasts, errors later than the rest", () => {
    vi.useFakeTimers();
    const s = createToastStore();
    const items = watch(s);
    s.toast("saved");
    s.toast("broke", "error");
    expect(items().map((i) => i.message)).toEqual(["saved", "broke"]);
    vi.advanceTimersByTime(AUTO_DISMISS_MS);
    expect(items().map((i) => i.message)).toEqual(["broke"]);
    vi.advanceTimersByTime(ERROR_DISMISS_MS);
    expect(items()).toEqual([]);
  });

  it("keeps a sticky toast until it is dismissed", () => {
    vi.useFakeTimers();
    const s = createToastStore();
    const items = watch(s);
    const id = s.toast("offline", "error", { sticky: true });
    vi.advanceTimersByTime(60_000);
    expect(items()).toHaveLength(1);
    expect(items()[0]!.sticky).toBe(true);
    s.dismiss(id);
    expect(items()).toEqual([]);
  });

  it("does not stack the same message twice", () => {
    const s = createToastStore();
    const items = watch(s);
    const a = s.toast("could not read the archive", "error", { sticky: true });
    const b = s.toast("could not read the archive", "error", { sticky: true });
    expect(b).toBe(a);
    expect(items()).toHaveLength(1);
    s.reset();
  });

  it("keeps each module's queue to itself", () => {
    const vault = createToastStore();
    const sim = createToastStore();
    const v = watch(vault);
    const m = watch(sim);
    sim.toast("Sent to simulator");
    expect(m()).toHaveLength(1);
    expect(v()).toEqual([]);
    sim.reset();
  });
});
