import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Subteam, TaskRow, User } from "@helios/pm-ui";
import { ownerOptions, partitionBySubteam, usersInSubteam, useOwnerOptions } from "../ownerScope";

const DAQ: Subteam = { id: "st-daq", name: "Data Acquisition", code: "DAQ", slug: "daq", color: null } as Subteam;
const AERO: Subteam = { id: "st-aero", name: "Aero", code: "AE", slug: "aero", color: null } as Subteam;

const alex: User = { id: "u-alex", name: "Alex", email: null, subteam_ids: [DAQ.id] };
const bo: User = { id: "u-bo", name: "Bo", email: null, subteam_ids: [AERO.id] };
// No membership row at all — the common case (only 41 of 107 have one).
const cy: User = { id: "u-cy", name: "Cy", email: null };
const di: User = { id: "u-di", name: "Di", email: null };
const USERS = [alex, bo, cy, di];

function task(id: string, subteams: Subteam[], ownerId: string | null, coOwnerIds: string[] = []): TaskRow {
  return {
    id, subteam_id: subteams[0]!.id, subteam: subteams[0]!, subteams,
    owner_id: ownerId,
    owner: ownerId ? USERS.find((u) => u.id === ownerId) ?? null : null,
    owners: [...(ownerId ? [USERS.find((u) => u.id === ownerId)!] : []),
             ...coOwnerIds.map((i) => USERS.find((u) => u.id === i)!)],
  } as unknown as TaskRow;
}

describe("usersInSubteam", () => {
  it("includes people with an explicit membership row", () => {
    expect(usersInSubteam(USERS, [], DAQ.id)).toEqual(new Set(["u-alex"]));
  });

  it("also includes people who own or co-own a task in that subteam", () => {
    // Membership data is sparse, so ownership is the second signal: Cy owns a
    // DAQ task and Di co-owns it, so both belong at the top of a DAQ picker.
    const tasks = [task("t1", [DAQ], cy.id, [di.id])];
    expect(usersInSubteam(USERS, tasks, DAQ.id)).toEqual(new Set(["u-alex", "u-cy", "u-di"]));
  });

  it("counts a SECONDARY subteam membership on the task, not just the primary", () => {
    const tasks = [task("t1", [AERO, DAQ], cy.id)];
    expect(usersInSubteam(USERS, tasks, DAQ.id).has("u-cy")).toBe(true);
  });

  it("is empty without a subteam in scope", () => {
    expect(usersInSubteam(USERS, [task("t1", [DAQ], cy.id)], null).size).toBe(0);
  });
});

describe("partitionBySubteam", () => {
  it("keeps the directory's own order inside each half", () => {
    const { inTeam, others } = partitionBySubteam(USERS, new Set(["u-di", "u-alex"]));
    expect(inTeam.map((u) => u.name)).toEqual(["Alex", "Di"]);
    expect(others.map((u) => u.name)).toEqual(["Bo", "Cy"]);
  });
});

describe("ownerOptions", () => {
  it("floats the subteam's people to the top under a named heading", () => {
    const opts = ownerOptions(USERS, [task("t1", [DAQ], cy.id)], DAQ.id, DAQ.name);
    expect(opts.map((o) => o.label)).toEqual(["Alex", "Cy", "Bo", "Di"]);
    expect(opts[0]!.group).toBe("Data Acquisition · this subteam");
    expect(opts[2]!.group).toBe("Everyone else");
  });

  it("never drops anyone — cross-subteam assignment stays possible", () => {
    const opts = ownerOptions(USERS, [], DAQ.id, DAQ.name);
    expect(new Set(opts.map((o) => o.value))).toEqual(new Set(USERS.map((u) => u.id)));
  });

  it("degrades to a flat, ungrouped list with no subteam in scope", () => {
    const opts = ownerOptions(USERS, [], null, null);
    expect(opts.map((o) => o.label)).toEqual(["Alex", "Bo", "Cy", "Di"]);
    expect(opts.every((o) => o.group === undefined)).toBe(true);
  });

  it("stays flat when the scope would put EVERYONE in one bucket", () => {
    // A heading with nothing under the other one is noise, not information.
    const everyone = new Set(USERS.map((u) => u.id));
    const all = USERS.map((u) => ({ ...u, subteam_ids: [DAQ.id] }));
    expect(usersInSubteam(all, [], DAQ.id)).toEqual(everyone);
    expect(ownerOptions(all, [], DAQ.id, DAQ.name).every((o) => o.group === undefined)).toBe(true);
  });
});

describe("useOwnerOptions", () => {
  // Review of the first cut: the views memoised on the tasks slice, so every
  // inline edit handed every memo'd Table row a fresh options array.
  it("keeps the same options reference when a task edit doesn't change who is in the subteam", () => {
    const users = [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Alex", email: null },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Bo", email: null },
    ] as unknown as User[];
    const t1 = { id: "t1", subteam_id: "st1", subteams: [], owner_id: users[0]!.id, owners: [], title: "a" } as unknown as TaskRow;
    const tasks1 = [t1];
    const { result, rerender } = renderHook(
      ({ tasks }) => useOwnerOptions(users, tasks, "st1", "DAQ"),
      { initialProps: { tasks: tasks1 } },
    );
    const first = result.current;
    expect(first.map((o) => o.label)).toEqual(["Alex", "Bo"]);

    // Same owner, new title, new array: an ordinary edit.
    rerender({ tasks: [{ ...t1, title: "b" } as unknown as TaskRow] });
    expect(result.current).toBe(first);

    // Bo picks up work on the subteam: membership changed, options rebuilt.
    rerender({ tasks: [t1, { ...t1, id: "t2", owner_id: users[1]!.id } as unknown as TaskRow] });
    expect(result.current).not.toBe(first);
  });
});
