import { describe, expect, it } from "vitest";
import { applyFileEvent, applyVersionEvent, REFETCH, type RowEvent } from "../apply-events";
import type { VaultFile, Version } from "../types";

function file(p: Partial<VaultFile> = {}): VaultFile {
  return {
    id: "f1",
    vault_id: "v1",
    folder_id: null,
    name: "a.sldprt",
    latest_version_id: null,
    created_at: "t",
    deleted_at: null,
    ...p,
  };
}
function version(p: Partial<Version> = {}): Version {
  return {
    id: "ver1",
    file_id: "f1",
    version_num: 1,
    sha256: "sha1",
    size_bytes: 10,
    author_id: null,
    comment: null,
    parent_version_id: null,
    revision: null,
    properties: null,
    created_at: "t",
    ...p,
  };
}

const V = "v1";
const live = (f: VaultFile) => f.deleted_at == null;
const deleted = (f: VaultFile) => f.deleted_at != null;
const inFolder = (folder: string) => (f: VaultFile) => f.folder_id === folder && f.deleted_at == null;

function ev<T = VaultFile>(eventType: RowEvent<T>["eventType"], next: T | null, old: Partial<T> | null = null): RowEvent<T> {
  return { eventType, new: next, old };
}

describe("applyFileEvent", () => {
  it("INSERT adds a new live file to the live list", () => {
    const list = [file({ id: "a" })];
    const out = applyFileEvent(list, ev("INSERT", file({ id: "b", name: "b.sldprt" })), { vaultId: V, belongs: live });
    expect(out).not.toBe(REFETCH);
    expect((out as VaultFile[]).map((f) => f.id).sort()).toEqual(["a", "b"]);
  });

  it("ignores a payload from another vault (files RLS is not vault-scoped) — same reference", () => {
    const list = [file({ id: "a" })];
    const out = applyFileEvent(list, ev("INSERT", file({ id: "x", vault_id: "OTHER" })), { vaultId: V, belongs: live });
    expect(out).toBe(list); // no-op, no re-render
  });

  it("UPDATE replaces the row in place (rename)", () => {
    const list = [file({ id: "a", name: "old.sldprt" })];
    const out = applyFileEvent(list, ev("UPDATE", file({ id: "a", name: "new.sldprt" }), { id: "a" }), { vaultId: V, belongs: live });
    expect((out as VaultFile[])[0]!.name).toBe("new.sldprt");
  });

  it("carries the existing embedded latest forward on a files UPDATE (payload has no join)", () => {
    const list = [file({ id: "a", latest: { ...version(), id: "vA" } as VaultFile["latest"] })];
    const out = applyFileEvent(list, ev("UPDATE", file({ id: "a", name: "renamed.sldprt", latest: null }), { id: "a" }), {
      vaultId: V,
      belongs: live,
    });
    expect((out as VaultFile[])[0]!.latest?.id).toBe("vA");
  });

  it("soft-delete (deleted_at set) REMOVES from the live list", () => {
    const list = [file({ id: "a" }), file({ id: "b" })];
    const out = applyFileEvent(list, ev("UPDATE", file({ id: "a", deleted_at: "now" }), { id: "a" }), { vaultId: V, belongs: live });
    expect((out as VaultFile[]).map((f) => f.id)).toEqual(["b"]);
  });

  it("soft-delete ADDS to the recycle-bin list (the dual-list move)", () => {
    const recycle: VaultFile[] = [];
    const out = applyFileEvent(recycle, ev("UPDATE", file({ id: "a", deleted_at: "now" }), { id: "a" }), { vaultId: V, belongs: deleted });
    expect((out as VaultFile[]).map((f) => f.id)).toEqual(["a"]);
  });

  it("restore (deleted_at null) removes from recycle and adds back to live", () => {
    const recycle = [file({ id: "a", deleted_at: "now" })];
    const live1 = applyFileEvent(recycle, ev("UPDATE", file({ id: "a", deleted_at: null }), { id: "a" }), { vaultId: V, belongs: deleted });
    expect((live1 as VaultFile[]).map((f) => f.id)).toEqual([]);
    const liveList: VaultFile[] = [];
    const live2 = applyFileEvent(liveList, ev("UPDATE", file({ id: "a", deleted_at: null }), { id: "a" }), { vaultId: V, belongs: live });
    expect((live2 as VaultFile[]).map((f) => f.id)).toEqual(["a"]);
  });

  it("move-out-of-folder removes the row from that folder's list", () => {
    const folderList = [file({ id: "a", folder_id: "A" })];
    const out = applyFileEvent(folderList, ev("UPDATE", file({ id: "a", folder_id: "B" }), { id: "a" }), {
      vaultId: V,
      belongs: inFolder("A"),
    });
    expect((out as VaultFile[]).map((f) => f.id)).toEqual([]);
  });

  it("DELETE removes by old.id", () => {
    const list = [file({ id: "a" }), file({ id: "b" })];
    const out = applyFileEvent(list, ev<VaultFile>("DELETE", null, { id: "a" }), { vaultId: V, belongs: live });
    expect((out as VaultFile[]).map((f) => f.id)).toEqual(["b"]);
  });

  it("DELETE with no identifiable old row → REFETCH", () => {
    const list = [file({ id: "a" })];
    expect(applyFileEvent(list, ev("DELETE", null, null), { vaultId: V, belongs: live })).toBe(REFETCH);
  });

  it("INSERT/UPDATE with no new row → REFETCH", () => {
    const list = [file({ id: "a" })];
    expect(applyFileEvent(list, ev<VaultFile>("UPDATE", null, { id: "a" }), { vaultId: V, belongs: live })).toBe(REFETCH);
  });

  it("DELETE of a row not present → same reference (no-op)", () => {
    const list = [file({ id: "a" })];
    const out = applyFileEvent(list, ev<VaultFile>("DELETE", null, { id: "zzz" }), { vaultId: V, belongs: live });
    expect(out).toBe(list);
  });
});

describe("applyVersionEvent", () => {
  it("patches the embedded latest on a newer-version INSERT (check-in)", () => {
    const list = [file({ id: "f1", latest_version_id: "v0", latest: { ...version({ version_num: 1 }) } as VaultFile["latest"] })];
    const out = applyVersionEvent(list, ev("INSERT", version({ id: "v2", file_id: "f1", version_num: 2, sha256: "shaNEW" })));
    expect(out[0]!.latest_version_id).toBe("v2");
    expect(out[0]!.latest?.sha256).toBe("shaNEW");
    expect(out[0]!.latest?.version_num).toBe(2);
  });

  it("excludes properties from the embedded latest", () => {
    const list = [file({ id: "f1" })];
    const out = applyVersionEvent(list, ev("INSERT", version({ id: "v2", version_num: 2, properties: [{ name: "x", value: "y" }] })));
    expect((out[0]!.latest as Record<string, unknown>).properties).toBeUndefined();
  });

  it("ignores an older/equal version (own-echo / dup / reorder safe) — same reference", () => {
    const list = [file({ id: "f1", latest: { ...version({ version_num: 3 }) } as VaultFile["latest"] })];
    const out = applyVersionEvent(list, ev("INSERT", version({ id: "vX", version_num: 3 })));
    expect(out).toBe(list);
  });

  it("no-ops when the file is not in this list — same reference", () => {
    const list = [file({ id: "other" })];
    const out = applyVersionEvent(list, ev("INSERT", version({ file_id: "f1", version_num: 2 })));
    expect(out).toBe(list);
  });

  it("ignores non-INSERT version events — same reference", () => {
    const list = [file({ id: "f1" })];
    expect(applyVersionEvent(list, ev("UPDATE", version({ version_num: 2 })))).toBe(list);
  });
});
