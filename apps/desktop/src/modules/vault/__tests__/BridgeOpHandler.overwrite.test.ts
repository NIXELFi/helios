import { describe, it, expect } from "vitest";
import { shouldSkipBridgeOverwrite } from "../BridgeOpHandler";

/**
 * Unit tests for the bridge getLatest overwrite guard.
 *
 * Guard semantics (mirrors useVaultDropImport.ts ~283-291 and useAutoSync.ts ~281-293):
 *   - file absent              → do NOT skip (safe to write, nothing to clobber)
 *   - file present, read-only  → do NOT skip (clean synced copy, safe to refresh)
 *   - file present, writable   → SKIP (may hold unsaved edits)
 */
describe("shouldSkipBridgeOverwrite", () => {
  it("skips when dest exists and is writable (may hold unsaved edits)", () => {
    expect(shouldSkipBridgeOverwrite(true, true)).toBe(true);
  });

  it("does NOT skip when dest exists but is read-only (clean synced copy)", () => {
    expect(shouldSkipBridgeOverwrite(true, false)).toBe(false);
  });

  it("does NOT skip when dest is absent (nothing to clobber)", () => {
    expect(shouldSkipBridgeOverwrite(false, false)).toBe(false);
  });

  it("does NOT skip when dest is absent even if writable flag is true (impossible in practice, but guard is sound)", () => {
    // destExists=false → guard returns false regardless of destWritable
    expect(shouldSkipBridgeOverwrite(false, true)).toBe(false);
  });
});
