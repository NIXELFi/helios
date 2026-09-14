import { describe, expect, it } from "vitest";
import type { TaskHistoryRow } from "@pm/lib/productivityMetrics";
import {
  countExportableEvents,
  csvField,
  taskHistoryFileName,
  taskHistoryToCsv,
} from "@pm/lib/taskHistoryCsv";

function row(over: Partial<TaskHistoryRow> = {}): TaskHistoryRow {
  return {
    activity_id: "a1",
    event_time: "2026-01-05T10:00:00Z",
    action: "completed",
    task_id: "t1",
    task_title: "Mount the wing",
    subteam_id: "st-1",
    subteam_name: "Aero",
    status_from: "active",
    status_to: "done",
    actor_id: null,
    actor_name: null,
    task_created_at: "2026-01-01T00:00:00Z",
    due_date: "2026-01-06",
    task_status_now: "done",
    estimate_days: 2,
    actual_days: 4,
    ...over,
  };
}

describe("csvField", () => {
  it("leaves a plain value alone", () => {
    expect(csvField("Aero")).toBe("Aero");
  });

  it("renders null and undefined as an empty field", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("quotes a value containing a comma", () => {
    expect(csvField("wing, left")).toBe('"wing, left"');
  });

  it("doubles embedded quotes", () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes a value containing a newline", () => {
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("quotes values with leading or trailing whitespace so they survive a round trip", () => {
    expect(csvField("  padded ")).toBe('"  padded "');
  });

  it("renders numbers unquoted", () => {
    expect(csvField(4)).toBe("4");
    expect(csvField(0)).toBe("0");
  });
});

describe("taskHistoryToCsv", () => {
  it("emits a header and one CRLF-terminated line per row", () => {
    const csv = taskHistoryToCsv([row(), row({ task_id: "t2" })]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(4); // header + 2 rows + trailing ""
    expect(lines[3]).toBe("");
    expect(lines[0]).toBe(
      "event_time,action,task_id,task_title,subteam,status_from,status_to,task_created_at,task_due_date,task_status_now,estimate_days,actual_days",
    );
    expect(lines[1]).toBe(
      "2026-01-05T10:00:00Z,completed,t1,Mount the wing,Aero,active,done,2026-01-01T00:00:00Z,2026-01-06,done,2,4",
    );
  });

  it("OMITS the actor column entirely when the server returned no actors", () => {
    const csv = taskHistoryToCsv([row()]);
    expect(csv).not.toContain("actor");
    expect(csv.split("\r\n")[0]!.split(",")).toHaveLength(12);
  });

  it("includes the actor column when actors came back", () => {
    const csv = taskHistoryToCsv([row({ actor_id: "u1", actor_name: "Ada Lovelace" })]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("status_to,actor,task_created_at");
    expect(lines[1]).toContain(",Ada Lovelace,");
  });

  it("falls back to the actor id when the name is missing", () => {
    const csv = taskHistoryToCsv([row({ actor_id: "u1", actor_name: null })]);
    expect(csv.split("\r\n")[1]).toContain(",u1,");
  });

  it("honours an explicit includeActor override", () => {
    const withActors = taskHistoryToCsv([row({ actor_id: "u1", actor_name: "Ada" })], {
      includeActor: false,
    });
    expect(withActors).not.toContain("Ada");
    const withoutActors = taskHistoryToCsv([row()], { includeActor: true });
    expect(withoutActors.split("\r\n")[0]).toContain(",actor,");
  });

  it("escapes a task title containing commas, quotes and newlines", () => {
    const csv = taskHistoryToCsv([row({ task_title: 'Fix "wing", then\ntest it' })]);
    expect(csv.split("\r\n")[1]).toContain('"Fix ""wing"", then\ntest it"');
  });

  it("emits only the header for an empty window", () => {
    const csv = taskHistoryToCsv([]);
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(1);
  });

  it("leaves null numeric columns empty rather than writing 'null'", () => {
    const csv = taskHistoryToCsv([row({ estimate_days: null, actual_days: null })]);
    expect(csv.split("\r\n")[1]!.endsWith("done,,")).toBe(true);
  });
});

describe("taskHistoryToCsv — synthetic open rows", () => {
  // The CSV is an EVENT LOG. The RPC's synthetic `open` rows are a live
  // snapshot of what is still open, not something that happened, so they are
  // dropped rather than exported as events with an invented action.
  it("omits open rows", () => {
    const csv = taskHistoryToCsv([
      row({ action: "open", task_id: "t9", event_time: "2026-01-02T00:00:00Z" }),
      row({ action: "completed", task_id: "t1" }),
    ]);
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(2); // header + the one real event
    expect(csv).not.toContain("t9");
    expect(csv).not.toContain("open");
  });

  it("emits only the header when every row is an open row", () => {
    const csv = taskHistoryToCsv([row({ action: "open", task_id: "t9" })]);
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(1);
  });

  it("does not let an open row's actor decide the actor column", () => {
    // An open row never carries an actor, so a window whose only actor-bearing
    // rows are open rows must not sprout an empty actor column.
    const csv = taskHistoryToCsv([
      row({ action: "open", task_id: "t9", actor_id: "u1", actor_name: "Ada" }),
      row({ action: "completed", task_id: "t1" }),
    ]);
    expect(csv.split("\r\n")[0]).not.toContain("actor");
  });

  it("counts only real events", () => {
    expect(
      countExportableEvents([
        row({ action: "open", task_id: "t9" }),
        row({ action: "completed", task_id: "t1" }),
        row({ action: "created", task_id: "t2" }),
      ]),
    ).toBe(2);
    expect(countExportableEvents([row({ action: "open", task_id: "t9" })])).toBe(0);
  });
});

describe("taskHistoryFileName", () => {
  it("slugs the scope label", () => {
    expect(taskHistoryFileName("Aero & Comp", "2026-06-01", "2026-09-14")).toBe(
      "task-history-aero-comp-2026-06-01_2026-09-14.csv",
    );
  });

  it("falls back to all-teams at project scope", () => {
    expect(taskHistoryFileName(null, "2026-06-01", "2026-09-14")).toBe(
      "task-history-all-teams-2026-06-01_2026-09-14.csv",
    );
  });
});
