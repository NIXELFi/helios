import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the Tauri fs plugin so the IO half is unit-testable without a desktop
// shell. The factory is hoisted, so declare the mocks here and reach them via
// the imported (mocked) bindings below.
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppLocalData: "AppLocalData" },
  mkdir: vi.fn(),
  writeTextFile: vi.fn(),
  readTextFile: vi.fn(),
}));

import { mkdir, writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import {
  classifyMissing,
  emptyLedger,
  loadLedger,
  recordEntry,
  removeEntry,
  parseLedger,
  saveLedger,
} from "../sync-ledger";

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

describe("sync-ledger IO (ENOENT regression)", () => {
  const mkdirMock = vi.mocked(mkdir);
  const writeMock = vi.mocked(writeTextFile);
  const readMock = vi.mocked(readTextFile);

  beforeEach(() => {
    mkdirMock.mockReset().mockResolvedValue(undefined);
    writeMock.mockReset().mockResolvedValue(undefined);
    readMock.mockReset();
  });

  it("saveLedger creates the dir (recursive) BEFORE writing — the os-error-2 fix", async () => {
    await saveLedger("v1", recordEntry(emptyLedger(), "a/x", "s"));
    expect(mkdirMock).toHaveBeenCalledWith("sync-ledgers", {
      baseDir: "AppLocalData",
      recursive: true,
    });
    expect(writeMock).toHaveBeenCalledWith(
      "sync-ledgers/sync-ledger-v1.json",
      expect.any(String),
      { baseDir: "AppLocalData" },
    );
    // mkdir must run before the write, or the write hits a missing directory.
    expect(mkdirMock.mock.invocationCallOrder[0]!).toBeLessThan(
      writeMock.mock.invocationCallOrder[0]!,
    );
  });

  it("saveLedger never throws on an IO failure (best-effort)", async () => {
    mkdirMock.mockRejectedValue(new Error("No such file or directory (os error 2)"));
    await expect(saveLedger("v1", emptyLedger())).resolves.toBeUndefined();
  });

  it("loadLedger falls back to the legacy root path when the subdir file is absent", async () => {
    readMock.mockImplementation((path: unknown) => {
      if (path === "sync-ledgers/sync-ledger-v1.json") return Promise.reject(new Error("missing"));
      if (path === "sync-ledger-v1.json")
        return Promise.resolve('{"entries":{"a":{"sha256":"x","recordedAt":"t"}}}');
      return Promise.reject(new Error("nope"));
    });
    const l = await loadLedger("v1");
    expect(l.entries.a?.sha256).toBe("x");
  });
});
