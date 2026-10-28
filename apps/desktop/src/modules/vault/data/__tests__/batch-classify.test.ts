import { describe, it, expect } from "vitest";
import {
  activeLockMap,
  classifyCheckIn,
  classifyCheckOut,
  planCheckIn,
  planCheckOut,
  type ClassifyCtx,
} from "../batch-classify";
import type { Lock, VaultFile, Version } from "../types";
import type { LocalFile } from "../useLocalFolderScan";

const ME = "me";
const ALICE = "alice";

function file(id: string, name = `${id}.sldprt`, latest_version_id: string | null = `v-${id}`): VaultFile {
  return { id, vault_id: "vault", folder_id: null, name, latest_version_id, created_at: "x" };
}
function version(fileId: string, sha: string): Version {
  return {
    id: `v-${fileId}`, file_id: fileId, version_num: 1, sha256: sha, size_bytes: 1, author_id: ME,
    comment: null, parent_version_id: null, revision: null, properties: null, created_at: "x",
  } as Version;
}
function local(name: string, sha: string, readonly?: boolean): LocalFile {
  return { basename: name, relativePath: name, absolutePath: `/v/${name}`, sha256: sha, sizeBytes: 1, readonly };
}
function lock(fileId: string, user: string, released_at: string | null = null): Lock {
  return { id: `l-${fileId}-${user}`, file_id: fileId, user_id: user, acquired_at: "2026-10-28T00:00:00Z", released_at, force_released_by: null };
}

function ctx(opts: { locals?: LocalFile[] | null; versions?: Version[]; locks?: Lock[] }): ClassifyCtx {
  const versionsByFileId = new Map<string, Version[]>();
  for (const v of opts.versions ?? []) versionsByFileId.set(v.file_id, [v]);
  return {
    localFiles: opts.locals === undefined ? [] : opts.locals,
    versionsByFileId,
    folders: [],
    lockByFile: activeLockMap(opts.locks ?? []),
    currentUserId: ME,
  };
}

describe("activeLockMap", () => {
  it("ignores released locks", () => {
    const m = activeLockMap([lock("a", ALICE, "2026-10-01"), lock("b", ALICE)]);
    expect(m.has("a")).toBe(false);
    expect(m.get("b")?.user_id).toBe(ALICE);
  });
});

describe("classifyCheckOut", () => {
  it("skips files checked out to me or to someone else", () => {
    const c = ctx({ versions: [version("a", "aa"), version("b", "bb")], locks: [lock("a", ME), lock("b", ALICE)] });
    expect(classifyCheckOut(file("a"), c).kind).toBe("mine");
    const other = classifyCheckOut(file("b"), c);
    expect(other.kind).toBe("other");
    if (other.kind === "other") expect(other.lock.user_id).toBe(ALICE);
  });

  it("keeps a writable local copy that differs from the vault (possible unsaved work)", () => {
    const c = ctx({ versions: [version("a", "aa")], locals: [local("a.sldprt", "edited", false)] });
    expect(classifyCheckOut(file("a"), c).kind).toBe("local-edits");
  });

  it("treats an unknown read-only bit as writable, like bulk Get Latest", () => {
    const c = ctx({ versions: [version("a", "aa")], locals: [local("a.sldprt", "edited", undefined)] });
    expect(classifyCheckOut(file("a"), c).kind).toBe("local-edits");
  });

  it("checks out a read-only stale copy, a synced copy, or a missing one", () => {
    const c = ctx({
      versions: [version("a", "aa"), version("b", "bb"), version("c", "cc")],
      locals: [local("a.sldprt", "old", true), local("b.sldprt", "bb", false)],
    });
    expect(classifyCheckOut(file("a"), c).kind).toBe("eligible");
    expect(classifyCheckOut(file("b"), c).kind).toBe("eligible");
    expect(classifyCheckOut(file("c"), c).kind).toBe("eligible");
  });
});

describe("classifyCheckIn", () => {
  it("never checks in a read-only differing copy that isn't checked out (it's stale, not an edit)", () => {
    const c = ctx({ versions: [version("a", "new")], locals: [local("a.sldprt", "old", true)] });
    expect(classifyCheckIn(file("a"), c, true).kind).toBe("nothing");
  });

  it("checks in a writable edit that isn't checked out, taking the lock first", () => {
    const c = ctx({ versions: [version("a", "aa")], locals: [local("a.sldprt", "edited", false)] });
    expect(classifyCheckIn(file("a"), c, false)).toEqual({ kind: "eligible", changed: true, needsLock: true });
  });

  it("checks in my changed checkout without re-locking", () => {
    const c = ctx({ versions: [version("a", "aa")], locals: [local("a.sldprt", "edited", false)], locks: [lock("a", ME)] });
    expect(classifyCheckIn(file("a"), c, false)).toEqual({ kind: "eligible", changed: true, needsLock: false });
  });

  it("releases my unchanged checkout only when asked", () => {
    const c = ctx({ versions: [version("a", "aa")], locals: [local("a.sldprt", "aa", false)], locks: [lock("a", ME)] });
    expect(classifyCheckIn(file("a"), c, false).kind).toBe("mine-unchanged");
    expect(classifyCheckIn(file("a"), c, true)).toEqual({ kind: "eligible", changed: false, needsLock: false });
  });

  it("flags my checkout with no local copy", () => {
    const c = ctx({ versions: [version("a", "aa")], locals: [], locks: [lock("a", ME)] });
    expect(classifyCheckIn(file("a"), c, true).kind).toBe("mine-no-local");
  });

  it("checks in a never-checked-in draft I hold", () => {
    const c = ctx({ locals: [local("d.sldprt", "draft", false)], locks: [lock("d", ME)] });
    expect(classifyCheckIn(file("d", "d.sldprt", null), c, true)).toEqual({ kind: "eligible", changed: true, needsLock: false });
  });

  it("separates someone else's checkout from one I also edited locally", () => {
    const c = ctx({
      versions: [version("a", "aa"), version("b", "bb")],
      locals: [local("a.sldprt", "edited", false), local("b.sldprt", "bb", true)],
      locks: [lock("a", ALICE), lock("b", ALICE)],
    });
    expect(classifyCheckIn(file("a"), c, true)).toMatchObject({ kind: "other", hasLocalEdits: true });
    expect(classifyCheckIn(file("b"), c, true)).toMatchObject({ kind: "other", hasLocalEdits: false });
  });
});

describe("planCheckOut / planCheckIn", () => {
  it("buckets a folder for the pre-flight prompt", () => {
    const files = [file("a"), file("b"), file("c"), file("d")];
    const c = ctx({
      versions: files.map((f) => version(f.id, f.id + f.id)),
      locals: [local("d.sldprt", "edited", false)],
      locks: [lock("a", ME), lock("b", ALICE)],
    });
    const plan = planCheckOut(files, c);
    expect(plan.eligible.map((f) => f.id)).toEqual(["c"]);
    expect(plan.mine.map((f) => f.id)).toEqual(["a"]);
    expect(plan.others.map((r) => [r.file.id, r.lock.user_id])).toEqual([["b", ALICE]]);
    expect(plan.localEdits.map((f) => f.id)).toEqual(["d"]);
  });

  it("counts changed vs unchanged and lists blockers", () => {
    const files = [file("a"), file("b"), file("c"), file("d"), file("e")];
    const c = ctx({
      versions: files.map((f) => version(f.id, f.id + f.id)),
      locals: [
        local("a.sldprt", "edited", false), // mine, changed
        local("b.sldprt", "bb", false), // mine, unchanged
        local("c.sldprt", "edited", false), // alice holds it, I edited
        local("e.sldprt", "ee", true), // synced, untouched
      ],
      locks: [lock("a", ME), lock("b", ME), lock("c", ALICE), lock("d", ME)],
    });
    const plan = planCheckIn(files, c);
    expect(plan.eligible.map((f) => f.id)).toEqual(["a", "b"]);
    expect(plan.changed).toBe(1);
    expect(plan.unchanged).toBe(1);
    expect(plan.blocked.map((r) => r.file.id)).toEqual(["c"]);
    expect(plan.mineNoLocal.map((f) => f.id)).toEqual(["d"]);
    expect(plan.others).toEqual([]);
  });
});
