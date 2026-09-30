import { describe, it, expect } from "vitest";
import {
  buildWorkspace,
  fetchTaskRowsByIds,
  fetchWorkspaceRaw,
  loadWorkspace,
  type RawWorkspace,
} from "../data";
import { RAW_FIXTURE, stubClient } from "./fixtures/pm-raw";
import GOLDEN from "./fixtures/pm-workspace-golden.json";

/**
 * `loadWorkspace` was split into `fetchWorkspaceRaw` (the ~17 reads) and
 * `buildWorkspace` (the pure transform) so PM can rebuild the workspace from a
 * cached RawWorkspace + a realtime payload instead of re-pulling everything.
 *
 * `pm-workspace-golden.json` was captured from the PRE-SPLIT `loadWorkspace`
 * running against this same fixture, so these assertions prove the refactor is
 * behaviour-preserving rather than comparing the new code against itself.
 */
describe("workspace split", () => {
  it("fetchWorkspaceRaw returns the un-transformed rows", async () => {
    const { client } = stubClient();
    const raw = await fetchWorkspaceRaw(client);
    expect(raw.projectsRaw).toEqual(RAW_FIXTURE.projects);
    expect(raw.subteams).toEqual(RAW_FIXTURE.subteams);
    expect(raw.subsystems).toEqual(RAW_FIXTURE.subsystems);
    expect(raw.users).toEqual(RAW_FIXTURE.list_directory);
    expect(raw.tasksRaw).toEqual(RAW_FIXTURE.tasks);
    // dependencies stay UNTOUCHED here — the lag_days/dep_type map moved into
    // buildWorkspace so the raw cache is a faithful copy of the server rows.
    expect(raw.depsRaw).toEqual(RAW_FIXTURE.task_dependencies);
    expect(raw.milestones).toEqual(RAW_FIXTURE.milestones);
    expect(raw.pages).toEqual(RAW_FIXTURE.pages);
    expect(raw.blocks).toEqual(RAW_FIXTURE.blocks);
    expect(raw.vendors).toEqual(RAW_FIXTURE.vendors);
    expect(raw.comments).toEqual(RAW_FIXTURE.task_comments);
    expect(raw.links).toEqual(RAW_FIXTURE.task_links);
    expect(raw.build).toEqual(RAW_FIXTURE.build_records);
    expect(raw.events).toEqual(RAW_FIXTURE.calendar_events);
    expect(raw.activity).toEqual(RAW_FIXTURE.activity);
    expect(raw.rolesRaw).toEqual(RAW_FIXTURE.my_team_roles);
    expect(raw.hiddenSubteamsRaw).toEqual(RAW_FIXTURE.project_hidden_subteams);
  });

  it("buildWorkspace(raw) equals what loadWorkspace produced before the split", async () => {
    const { client } = stubClient();
    const raw = await fetchWorkspaceRaw(client);
    expect(JSON.parse(JSON.stringify(buildWorkspace(raw)))).toEqual(GOLDEN);
  });

  it("loadWorkspace still produces the same workspace", async () => {
    const { client } = stubClient();
    expect(JSON.parse(JSON.stringify(await loadWorkspace(client)))).toEqual(GOLDEN);
  });

  it("buildWorkspace is pure — a second call gives an equal result", async () => {
    const { client } = stubClient();
    const raw = await fetchWorkspaceRaw(client);
    const a = buildWorkspace(raw);
    const b = buildWorkspace(raw);
    expect(JSON.parse(JSON.stringify(b))).toEqual(JSON.parse(JSON.stringify(a)));
  });

  it("hidden-subteams read failing degrades to 'nothing hidden'", async () => {
    const { client } = stubClient({ ...RAW_FIXTURE, project_hidden_subteams: [] });
    const raw = await fetchWorkspaceRaw(client);
    expect(raw.hiddenSubteamsRaw).toEqual([]);
    expect(buildWorkspace(raw).projectData["p-1"]!.hiddenSubteams).toEqual([]);
  });

  it("fetchTaskRowsByIds asks for exactly the requested ids", async () => {
    const { client, calls } = stubClient();
    const rows = await fetchTaskRowsByIds(client, ["t-1", "t-3"]);
    expect(calls).toContain("from:tasks");
    expect(calls).toContain("in:id:t-1,t-3");
    // the stub serves the whole table; what matters is the query shape + unwrap
    expect(rows).toEqual(RAW_FIXTURE.tasks);
  });

  it("fetchTaskRowsByIds short-circuits on an empty id list", async () => {
    const { client, calls } = stubClient();
    expect(await fetchTaskRowsByIds(client, [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("the raw cache round-trips through JSON (it is what the snapshot path holds)", async () => {
    const { client } = stubClient();
    const raw = await fetchWorkspaceRaw(client);
    const clone = JSON.parse(JSON.stringify(raw)) as RawWorkspace;
    expect(JSON.parse(JSON.stringify(buildWorkspace(clone)))).toEqual(GOLDEN);
  });
});
