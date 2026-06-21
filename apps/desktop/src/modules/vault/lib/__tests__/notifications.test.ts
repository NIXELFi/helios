/**
 * TDD: tests for notifications.ts — written BEFORE implementation.
 *
 * Covers:
 *   - eventToNotification maps each event kind → correct Notification
 *   - eventToNotification returns null for unwatched files
 *   - defensive handling of malformed / partial payloads
 *   - mergeNotifications: prepend, dedupe by id, cap
 *   - unreadCount
 */
import { describe, expect, test } from "vitest";
import {
  eventToNotification,
  mergeNotifications,
  unreadCount,
  type Notification,
  type RealtimePayload,
} from "../notifications";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WATCHED = new Set(["file-A", "file-B"]);
const AT = "2026-06-19T10:00:00.000Z";

/** Minimal valid versions INSERT payload (check-in) */
function versionInsert(fileId: string, actorId?: string): RealtimePayload {
  return {
    table: "versions",
    eventType: "INSERT",
    new: { id: "ver1", file_id: fileId, author_id: actorId ?? null, created_at: AT },
    old: null,
  };
}

/** Minimal locks INSERT payload (check-out) */
function lockInsert(fileId: string, userId: string): RealtimePayload {
  return {
    table: "locks",
    eventType: "INSERT",
    new: { id: "lk1", file_id: fileId, user_id: userId, acquired_at: AT, released_at: null, force_released_by: null },
    old: null,
  };
}

/** Locks UPDATE with released_at set → normal unlock */
function lockRelease(fileId: string, userId: string): RealtimePayload {
  return {
    table: "locks",
    eventType: "UPDATE",
    new: { id: "lk1", file_id: fileId, user_id: userId, acquired_at: AT, released_at: AT, force_released_by: null },
    old: { id: "lk1", file_id: fileId, user_id: userId, acquired_at: AT, released_at: null, force_released_by: null },
  };
}

/** Locks UPDATE with force_released_by set → force-unlock */
function lockForceRelease(fileId: string, byUserId: string): RealtimePayload {
  return {
    table: "locks",
    eventType: "UPDATE",
    new: { id: "lk1", file_id: fileId, user_id: "u1", acquired_at: AT, released_at: AT, force_released_by: byUserId },
    old: { id: "lk1", file_id: fileId, user_id: "u1", acquired_at: AT, released_at: null, force_released_by: null },
  };
}

/** Files UPDATE: deleted_at set → deleted */
function fileDelete(fileId: string, deletedBy?: string): RealtimePayload {
  return {
    table: "files",
    eventType: "UPDATE",
    new: { id: fileId, name: "frame.SLDPRT", deleted_at: AT, deleted_by: deletedBy ?? null },
    old: { id: fileId, name: "frame.SLDPRT", deleted_at: null, deleted_by: null },
  };
}

/** Files UPDATE: deleted_at cleared → restored */
function fileRestore(fileId: string, deletedBy?: string): RealtimePayload {
  return {
    table: "files",
    eventType: "UPDATE",
    new: { id: fileId, name: "frame.SLDPRT", deleted_at: null, deleted_by: deletedBy ?? null },
    old: { id: fileId, name: "frame.SLDPRT", deleted_at: AT, deleted_by: null },
  };
}

function ctx(fileName?: string) {
  return { fileNames: new Map([["file-A", fileName ?? "frame.SLDPRT"], ["file-B", "assy.SLDASM"]]) };
}

// ---------------------------------------------------------------------------
// eventToNotification — correct kind per event type
// ---------------------------------------------------------------------------

describe("eventToNotification — versions INSERT → checked_in", () => {
  test("returns a checked_in notification for a watched file", () => {
    const n = eventToNotification(versionInsert("file-A", "u1"), WATCHED, ctx(), AT);
    expect(n).not.toBeNull();
    expect(n!.kind).toBe("checked_in");
    expect(n!.fileId).toBe("file-A");
    expect(n!.fileName).toBe("frame.SLDPRT");
    expect(n!.actorId).toBe("u1");
    expect(n!.at).toBe(AT);
    expect(n!.read).toBe(false);
  });

  test("id is stable across identical payloads (deterministic)", () => {
    const n1 = eventToNotification(versionInsert("file-A"), WATCHED, ctx(), AT);
    const n2 = eventToNotification(versionInsert("file-A"), WATCHED, ctx(), AT);
    expect(n1!.id).toBe(n2!.id);
  });
});

describe("eventToNotification — locks INSERT → checked_out", () => {
  test("returns checked_out notification with actorId = user_id", () => {
    const n = eventToNotification(lockInsert("file-A", "u2"), WATCHED, ctx(), AT);
    expect(n).not.toBeNull();
    expect(n!.kind).toBe("checked_out");
    expect(n!.actorId).toBe("u2");
  });
});

describe("eventToNotification — locks UPDATE released_at set → unlocked", () => {
  test("returns unlocked notification", () => {
    const n = eventToNotification(lockRelease("file-A", "u1"), WATCHED, ctx(), AT);
    expect(n).not.toBeNull();
    expect(n!.kind).toBe("unlocked");
    expect(n!.actorId).toBe("u1");
  });
});

describe("eventToNotification — locks UPDATE force_released_by set → force_unlocked", () => {
  test("returns force_unlocked notification with actorId = force_released_by", () => {
    const n = eventToNotification(lockForceRelease("file-A", "admin1"), WATCHED, ctx(), AT);
    expect(n).not.toBeNull();
    expect(n!.kind).toBe("force_unlocked");
    expect(n!.actorId).toBe("admin1");
  });
});

describe("eventToNotification — files UPDATE deleted_at set → deleted", () => {
  test("returns deleted notification", () => {
    const n = eventToNotification(fileDelete("file-A"), WATCHED, ctx(), AT);
    expect(n).not.toBeNull();
    expect(n!.kind).toBe("deleted");
    expect(n!.fileName).toBe("frame.SLDPRT");
  });

  test("actorId is deleted_by from the row when present", () => {
    const n = eventToNotification(fileDelete("file-A", "admin-1"), WATCHED, ctx(), AT);
    expect(n).not.toBeNull();
    expect(n!.actorId).toBe("admin-1");
  });

  test("actorId is null when deleted_by is absent", () => {
    const n = eventToNotification(fileDelete("file-A"), WATCHED, ctx(), AT);
    expect(n).not.toBeNull();
    expect(n!.actorId).toBeNull();
  });
});

describe("eventToNotification — files UPDATE deleted_at cleared → restored", () => {
  test("returns restored notification", () => {
    const n = eventToNotification(fileRestore("file-A"), WATCHED, ctx(), AT);
    expect(n).not.toBeNull();
    expect(n!.kind).toBe("restored");
  });

  test("actorId is deleted_by from the row when present", () => {
    const n = eventToNotification(fileRestore("file-A", "admin-2"), WATCHED, ctx(), AT);
    expect(n).not.toBeNull();
    expect(n!.actorId).toBe("admin-2");
  });

  test("actorId is null when deleted_by is absent", () => {
    const n = eventToNotification(fileRestore("file-A"), WATCHED, ctx(), AT);
    expect(n).not.toBeNull();
    expect(n!.actorId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// eventToNotification — returns null for unwatched files
// ---------------------------------------------------------------------------

describe("eventToNotification — returns null for unwatched files", () => {
  test("versions INSERT for an unwatched file → null", () => {
    expect(eventToNotification(versionInsert("file-UNKNOWN"), WATCHED, ctx(), AT)).toBeNull();
  });

  test("locks INSERT for an unwatched file → null", () => {
    expect(eventToNotification(lockInsert("file-UNKNOWN", "u1"), WATCHED, ctx(), AT)).toBeNull();
  });

  test("files UPDATE for an unwatched file → null", () => {
    expect(eventToNotification(fileDelete("file-UNKNOWN"), WATCHED, ctx(), AT)).toBeNull();
  });

  test("empty watch set always returns null", () => {
    expect(eventToNotification(versionInsert("file-A"), new Set(), ctx(), AT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// eventToNotification — locks UPDATE where nothing interesting changed → null
// ---------------------------------------------------------------------------

describe("eventToNotification — locks UPDATE no-op", () => {
  test("returns null when neither released_at nor force_released_by changed", () => {
    const payload: RealtimePayload = {
      table: "locks",
      eventType: "UPDATE",
      // Only acquired_at changed — nothing notification-worthy
      new: { id: "lk1", file_id: "file-A", user_id: "u1", acquired_at: AT, released_at: null, force_released_by: null },
      old: { id: "lk1", file_id: "file-A", user_id: "u1", acquired_at: "earlier", released_at: null, force_released_by: null },
    };
    expect(eventToNotification(payload, WATCHED, ctx(), AT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// eventToNotification — defensive on malformed payloads
// ---------------------------------------------------------------------------

describe("eventToNotification — defensive on malformed payloads", () => {
  test("returns null when new row is null on a versions INSERT", () => {
    const bad: RealtimePayload = { table: "versions", eventType: "INSERT", new: null, old: null };
    expect(eventToNotification(bad, WATCHED, ctx(), AT)).toBeNull();
  });

  test("returns null when file_id is missing from versions row", () => {
    const bad: RealtimePayload = {
      table: "versions",
      eventType: "INSERT",
      new: { id: "ver1" }, // no file_id
      old: null,
    };
    expect(eventToNotification(bad, WATCHED, ctx(), AT)).toBeNull();
  });

  test("returns null for unknown table", () => {
    const bad: RealtimePayload = {
      table: "unknown_table",
      eventType: "INSERT",
      new: { id: "x", file_id: "file-A" },
      old: null,
    };
    expect(eventToNotification(bad, WATCHED, ctx(), AT)).toBeNull();
  });

  test("returns null when payload itself is null-ish (guard against unexpected callers)", () => {
    // TypeScript won't allow null directly, but test defensive cast
    expect(eventToNotification(null as unknown as RealtimePayload, WATCHED, ctx(), AT)).toBeNull();
  });

  test("returns null for files UPDATE with no id field", () => {
    const bad: RealtimePayload = {
      table: "files",
      eventType: "UPDATE",
      new: { name: "x.SLDPRT", deleted_at: AT }, // no id
      old: null,
    };
    expect(eventToNotification(bad, WATCHED, ctx(), AT)).toBeNull();
  });

  test("falls back to 'unknown file' when ctx has no name mapping for the fileId", () => {
    const noNames = { fileNames: new Map<string, string>() };
    const n = eventToNotification(versionInsert("file-A"), WATCHED, noNames, AT);
    expect(n).not.toBeNull();
    expect(n!.fileName).toBe("file-A"); // falls back to id
  });
});

// ---------------------------------------------------------------------------
// mergeNotifications
// ---------------------------------------------------------------------------

function makeNotif(id: string, read = false): Notification {
  return { id, fileId: "file-A", kind: "checked_in", fileName: "a.sldprt", actorId: null, at: AT, read };
}

describe("mergeNotifications", () => {
  test("prepends incoming notification to the front of the list", () => {
    const existing = [makeNotif("n1"), makeNotif("n2")];
    const incoming = makeNotif("n3");
    const result = mergeNotifications(existing, [incoming], 50);
    expect(result[0]!.id).toBe("n3");
    expect(result).toHaveLength(3);
  });

  test("deduplicates by id — keeps existing position for already-present items", () => {
    const existing = [makeNotif("n1"), makeNotif("n2")];
    const dup = makeNotif("n1"); // already in list
    const result = mergeNotifications(existing, [dup], 50);
    // Should still be length 2, n1 not duplicated
    expect(result.filter((n) => n.id === "n1")).toHaveLength(1);
    expect(result).toHaveLength(2);
  });

  test("caps to N items (newest first)", () => {
    const existing = Array.from({ length: 48 }, (_, i) => makeNotif(`n${i}`));
    const incoming = [makeNotif("new1"), makeNotif("new2"), makeNotif("new3")];
    const result = mergeNotifications(existing, incoming, 50);
    expect(result).toHaveLength(50);
    // incoming come first
    expect(result[0]!.id).toBe("new1");
    expect(result[1]!.id).toBe("new2");
    expect(result[2]!.id).toBe("new3");
  });

  test("empty existing + single incoming → list of one", () => {
    const result = mergeNotifications([], [makeNotif("n1")], 50);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("n1");
  });

  test("multiple incoming are prepended in order (first incoming item is at index 0)", () => {
    const result = mergeNotifications([], [makeNotif("a"), makeNotif("b"), makeNotif("c")], 50);
    expect(result.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// unreadCount
// ---------------------------------------------------------------------------

describe("unreadCount", () => {
  test("returns 0 for empty list", () => {
    expect(unreadCount([])).toBe(0);
  });

  test("counts only unread items", () => {
    const list = [makeNotif("n1", false), makeNotif("n2", true), makeNotif("n3", false)];
    expect(unreadCount(list)).toBe(2);
  });

  test("returns 0 when all are read", () => {
    const list = [makeNotif("n1", true), makeNotif("n2", true)];
    expect(unreadCount(list)).toBe(0);
  });

  test("returns full length when all are unread", () => {
    const list = [makeNotif("n1"), makeNotif("n2"), makeNotif("n3")];
    expect(unreadCount(list)).toBe(3);
  });
});
