import { describe, expect, it, vi } from "vitest";
import { publishVaultEvent, subscribeVaultEvents, vaultEventSubscriberCount } from "../vault-events";

describe("vault-events bus", () => {
  it("fans one published event out to every subscriber of that vault", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeVaultEvents("v1", a);
    const offB = subscribeVaultEvents("v1", b);
    const payload = { eventType: "INSERT", new: { id: "f1" }, old: null };
    publishVaultEvent("v1", "files", payload);
    expect(a).toHaveBeenCalledWith("files", payload);
    expect(b).toHaveBeenCalledWith("files", payload);
    offA();
    offB();
  });

  it("stops delivering after unsubscribe, and unsubscribing twice is safe", () => {
    const h = vi.fn();
    const off = subscribeVaultEvents("v1", h);
    off();
    off();
    publishVaultEvent("v1", "versions", {});
    expect(h).not.toHaveBeenCalled();
    expect(vaultEventSubscriberCount("v1")).toBe(0);
  });

  it("isolates vaults — a subscriber never sees another vault's events", () => {
    const one = vi.fn();
    const two = vi.fn();
    const off1 = subscribeVaultEvents("v1", one);
    const off2 = subscribeVaultEvents("v2", two);
    publishVaultEvent("v2", "locks", { id: "l1" });
    expect(one).not.toHaveBeenCalled();
    expect(two).toHaveBeenCalledTimes(1);
    off1();
    off2();
  });

  it("publishing with no subscribers is a no-op (the feed can connect first)", () => {
    expect(() => publishVaultEvent("nobody", "folders", {})).not.toThrow();
  });

  it("a subscriber that mounted BEFORE the feed connected still receives events", () => {
    // The bus is independent of the channel, so ordering never matters: this is
    // the guarantee that lets BrowseScreen subscribe before VaultHome's feed
    // has finished joining the realtime topic.
    const early = vi.fn();
    const off = subscribeVaultEvents("v9", early);
    publishVaultEvent("v9", "files", { id: "x" }); // "feed connects" afterwards
    expect(early).toHaveBeenCalledTimes(1);
    off();
  });

  it("one throwing subscriber does not stop the others", () => {
    const boom = vi.fn(() => {
      throw new Error("subscriber blew up");
    });
    const ok = vi.fn();
    const off1 = subscribeVaultEvents("v3", boom);
    const off2 = subscribeVaultEvents("v3", ok);
    expect(() => publishVaultEvent("v3", "files", {})).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
    off1();
    off2();
  });

  it("drops the vault's entry once the last subscriber leaves (no unbounded map)", () => {
    const off = subscribeVaultEvents("v4", vi.fn());
    expect(vaultEventSubscriberCount("v4")).toBe(1);
    off();
    expect(vaultEventSubscriberCount("v4")).toBe(0);
  });
});
