import { describe, expect, it } from "vitest";
import { classifyMissing, emptyLedger, recordEntry, removeEntry, parseLedger } from "../sync-ledger";

describe("sync-ledger core", () => {
  it("records and removes entries by normalized relpath", () => {
    let l = recordEntry(emptyLedger(), "Chassis/frame.sldprt", "abc");
    expect(l.entries["chassis/frame.sldprt"]).toMatchObject({ sha256: "abc" });
    l = removeEntry(l, "CHASSIS/frame.sldprt");
    expect(Object.keys(l.entries)).toHaveLength(0);
  });
  it("parseLedger tolerates corrupt input (safe empty)", () => {
    expect(parseLedger("not json").entries).toEqual({});
    expect(parseLedger('{"entries": 5}').entries).toEqual({});
    expect(parseLedger('{"entries":{"a":{"sha256":"x","recordedAt":"t"}}}').entries.a!.sha256).toBe("x");
  });
  it("classifyMissing: only in-vault + in-ledger + missing-locally counts", () => {
    const ledger = recordEntry(emptyLedger(), "a/x.sldprt", "s1");
    // present locally → not deleted
    expect(classifyMissing(ledger, "a/x.sldprt", true)).toBe("present");
    // missing + in ledger → locally deleted
    expect(classifyMissing(ledger, "a/x.sldprt", false)).toBe("locally-deleted");
    // missing + NOT in ledger → never downloaded
    expect(classifyMissing(ledger, "a/y.sldprt", false)).toBe("never-downloaded");
  });
});
