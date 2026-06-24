import type {
  Activity,
  Block,
  BuildRecord,
  CalendarEvent,
  Milestone,
  Page,
  Project,
  Subsystem,
  Subteam,
  TaskComment,
  TaskDependency,
  TaskLink,
  TaskRow,
  TeamRole,
  User,
  Vendor,
} from "@helios/pm-ui";
import type { BaselineOrg, ProjectData } from "./pmStore";
import type { SupabaseClient } from "@helios/auth";

// Live data layer. Every read hits the `pm` Postgres schema in Supabase,
// RLS-scoped to the signed-in member. The shapes returned here match exactly
// what the store + views consume, so nothing downstream changed when the old
// in-memory seed was replaced. The seed data now lives in the database — see
// infra/pdm-supabase/supabase/migrations + Helios-PM/scripts/seed.

// Loosely typed so any supabase-js PostgrestResponse / rpc response is accepted
// without fighting its inferred row types; we own the shape via the <T> arg.
function unwrap<T>(
  res: { data: unknown; error: { message: string } | null },
  what: string,
): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return (res.data ?? []) as T;
}

// Postgres numeric columns can serialize as strings in some setups; coerce so
// the views (which expect numbers) never see a stringified value.
const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

export interface Workspace {
  projects: Project[];
  projectData: Record<string, ProjectData>;
  baselineOrg: BaselineOrg;
  // The signed-in user's PM team role per project (admin/lead/engineer/viewer).
  roles: Record<string, TeamRole>;
}

// Fetch the entire workspace (all projects + the shared org) in one shot and
// assemble the per-project working sets the store hydrates from.
export async function loadWorkspace(client: SupabaseClient): Promise<Workspace> {
  const sb = client.schema("pm");
  const [
    projectsR,
    subteamsR,
    subsystemsR,
    dirR,
    tasksR,
    depsR,
    milestonesR,
    pagesR,
    blocksR,
    vendorsR,
    commentsR,
    linksR,
    buildR,
    eventsR,
    activityR,
    rolesR,
  ] = await Promise.all([
    sb.from("projects").select("id,name,description,car_code").order("car_code"),
    sb.from("subteams").select("id,name,code,slug,color").order("sort_order"),
    sb
      .from("subsystems")
      .select("id,subteam_id,parent_subsystem_id,name,code,color")
      .order("display_order"),
    sb.rpc("list_directory"),
    sb
      .from("tasks")
      .select(
        "id,project_id,subteam_id,subsystem_id,parent_task_id,title,description,type,status,priority,owner_id,start_date,due_date,estimate_days,mrl,on_critical_path,created_by," +
          // Pin the PRIMARY subteam embed to the direct tasks.subteam_id FK.
          // task_subteams adds a SECOND tasks->subteams path, so an unqualified
          // `subteams` embed is ambiguous ("more than one relationship found").
          "subteam:subteams!tasks_subteam_id_fkey(id,name,code,slug,color)," +
          "subsystem:subsystems(id,subteam_id,parent_subsystem_id,name,code,color)," +
          "task_subteams(subteam_id,is_primary,subteam:subteams(id,name,code,slug,color))," +
          // Owner ids only (auth.users can't be embedded cross-schema); the User
          // objects are resolved client-side from the directory, like owner.
          "task_owners(owner_id,is_primary)",
      ),
    sb.from("task_dependencies").select("predecessor_id,successor_id,dep_type,lag_days"),
    sb
      .from("milestones")
      .select("id,project_id,name,target_date,type,description")
      .order("target_date"),
    sb
      .from("pages")
      .select("id,project_id,subteam_id,title,icon,type,parent_page_id,order_key"),
    sb.from("blocks").select("id,page_id,parent_block_id,order_key,type,props"),
    sb
      .from("vendors")
      .select(
        "id,project_id,name,category,contact_name,email,phone,website,location,processes,machining,lead_time_days,status,notes",
      ),
    sb.from("task_comments").select("id,task_id,author_id,body,kind,created_at"),
    sb.from("task_links").select("id,task_id,url,label,created_at,created_by"),
    sb.from("build_records").select("task_id,part_file,drawing_file,drawing_review"),
    sb
      .from("calendar_events")
      .select("id,project_id,title,date,all_subteams,subteam_ids,type_tags,description,recurrence,recurrence_end"),
    sb
      .from("activity")
      .select(
        "id,project_id,actor_id,action,target_type,target_id,target_name,subteam_ids,payload,created_at",
      )
      .order("created_at", { ascending: false })
      .limit(250),
    sb.rpc("my_team_roles"),
  ]);

  // Per-project DISPLAY hides for the sidebar nav list (server-wide default).
  // World-readable; absence of a row = the subteam is shown. This does NOT
  // affect task data, membership, or permissions — only what the sidebar lists.
  //
  // FAIL-SOFT (intentionally OUTSIDE the strict Promise.all above): if the
  // migration that creates pm.project_hidden_subteams has not been applied yet,
  // this read errors with "relation does not exist". We must NOT let that throw
  // out of loadWorkspace — that would take down the ENTIRE PM workspace over a
  // display-only filter. So we await it on its own, default to [] on any error,
  // and treat the absence as "nothing hidden". Every other read stays strict.
  const hiddenSubteamsR = await sb
    .from("project_hidden_subteams")
    .select("project_id,subteam_id")
    .then(
      (res) => res,
      () => ({ data: [] as Array<{ project_id: string; subteam_id: string }>, error: null }),
    );

  const projectsRaw = unwrap<
    Array<{ id: string; name: string; description: string | null; car_code: string }>
  >(projectsR, "projects");
  const subteams = unwrap<Subteam[]>(subteamsR, "subteams");
  const subsystems = unwrap<Subsystem[]>(subsystemsR, "subsystems");
  const users = unwrap<User[]>(dirR, "list_directory");
  const tasksRaw = unwrap<Array<Record<string, unknown>>>(tasksR, "tasks");
  const deps = unwrap<Array<Record<string, unknown>>>(depsR, "dependencies").map(
    (d) =>
      ({
        predecessor_id: d.predecessor_id as string,
        successor_id: d.successor_id as string,
        dep_type: d.dep_type as TaskDependency["dep_type"],
        lag_days: num(d.lag_days) ?? 0,
      }) satisfies TaskDependency,
  );
  const milestones = unwrap<Milestone[]>(milestonesR, "milestones");
  const pages = unwrap<Page[]>(pagesR, "pages");
  const blocks = unwrap<Block[]>(blocksR, "blocks");
  const vendors = unwrap<Vendor[]>(vendorsR, "vendors");
  const comments = unwrap<TaskComment[]>(commentsR, "task_comments");
  const links = unwrap<TaskLink[]>(linksR, "task_links");
  const build = unwrap<BuildRecord[]>(buildR, "build_records");
  const events = unwrap<CalendarEvent[]>(eventsR, "calendar_events");
  const rolesRaw = unwrap<Array<{ project_id: string; team_role: TeamRole }>>(
    rolesR,
    "my_team_roles",
  );
  const roles: Record<string, TeamRole> = {};
  for (const r of rolesRaw) roles[r.project_id] = r.team_role;
  const activity = unwrap<Activity[]>(activityR, "activity");
  // Do NOT route through unwrap (which throws on res.error): a PostgREST error
  // here (e.g. the table not yet migrated) must degrade to "nothing hidden".
  const hiddenSubteamsRaw = (hiddenSubteamsR.error
    ? []
    : hiddenSubteamsR.data ?? []) as Array<{
    project_id: string;
    subteam_id: string;
  }>;

  const userById = new Map(users.map((u) => [u.id, u]));

  // Stitch the joined subteam/subsystem (PostgREST embeds) + the owner (resolved
  // from the directory, since auth.users can't be embedded cross-schema).
  const tasks: TaskRow[] = tasksRaw.map((t) => {
    const ownerId = (t.owner_id as string | null) ?? null;
    const primary = t.subteam as Subteam;
    // The nested membership rows (task_subteams) carry an embedded subteam each;
    // order them primary-first so views can render the primary chip up front.
    const memberships = ((t.task_subteams as Array<Record<string, unknown>> | null) ?? [])
      .map((m) => ({
        is_primary: Boolean(m.is_primary),
        subteam: m.subteam as Subteam | null,
      }))
      .filter((m): m is { is_primary: boolean; subteam: Subteam } => m.subteam != null);
    memberships.sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
    // Fall back to the embedded primary subteam if a task has no membership rows
    // (should not happen post-backfill, but keep reads resilient).
    const subteams =
      memberships.length > 0 ? memberships.map((m) => m.subteam) : [primary];
    // Owner membership rows carry just ids; resolve each to a directory User and
    // order primary-first so the detail sheet renders the primary owner up front.
    const ownerRows = ((t.task_owners as Array<Record<string, unknown>> | null) ?? [])
      .map((o) => ({
        is_primary: Boolean(o.is_primary),
        user: userById.get(o.owner_id as string) ?? null,
      }))
      .filter((o): o is { is_primary: boolean; user: User } => o.user != null);
    ownerRows.sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
    const owners = ownerRows.map((o) => o.user);
    return {
      id: t.id as string,
      project_id: t.project_id as string,
      subteam_id: t.subteam_id as string,
      subsystem_id: (t.subsystem_id as string | null) ?? null,
      parent_task_id: (t.parent_task_id as string | null) ?? null,
      title: t.title as string,
      description: (t.description as string | null) ?? null,
      type: t.type as TaskRow["type"],
      status: t.status as TaskRow["status"],
      priority: t.priority as TaskRow["priority"],
      owner_id: ownerId,
      start_date: (t.start_date as string | null) ?? null,
      due_date: (t.due_date as string | null) ?? null,
      estimate_days: num(t.estimate_days),
      mrl: num(t.mrl),
      on_critical_path: Boolean(t.on_critical_path),
      created_by: (t.created_by as string | null) ?? null,
      subteam: primary,
      subteams,
      subsystem: (t.subsystem as Subsystem | null) ?? null,
      owner: ownerId ? userById.get(ownerId) ?? null : null,
      owners,
    };
  });

  const taskProject = new Map(tasks.map((t) => [t.id, t.project_id]));
  const pageProject = new Map(pages.map((p) => [p.id, p.project_id]));

  const projects: Project[] = projectsRaw.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description ?? null,
  }));

  const baselineOrg: BaselineOrg = { subteams, subsystems, users };

  // Server-hidden subteam ids grouped per project (display-only).
  const hiddenByProject = new Map<string, string[]>();
  for (const h of hiddenSubteamsRaw) {
    const arr = hiddenByProject.get(h.project_id) ?? [];
    arr.push(h.subteam_id);
    hiddenByProject.set(h.project_id, arr);
  }

  const projectData: Record<string, ProjectData> = {};
  for (const p of projectsRaw) {
    const pid = p.id;
    projectData[pid] = {
      tasks: tasks.filter((t) => t.project_id === pid),
      subteams: subteams.map((x) => ({ ...x })),
      subsystems: subsystems.map((x) => ({ ...x })),
      users: users.map((x) => ({ ...x })),
      dependencies: deps.filter((d) => taskProject.get(d.predecessor_id) === pid),
      milestones: milestones.filter((m) => m.project_id === pid),
      pages: pages.filter((pg) => pg.project_id === pid),
      blocks: blocks.filter((b) => pageProject.get(b.page_id) === pid),
      activity: activity.filter((a) => a.project_id === pid),
      vendors: vendors.filter((v) => v.project_id === pid),
      comments: comments.filter((c) => taskProject.get(c.task_id) === pid),
      links: links.filter((l) => taskProject.get(l.task_id) === pid),
      buildRecords: build.filter((br) => taskProject.get(br.task_id) === pid),
      events: events.filter((e) => e.project_id === pid),
      hiddenSubteams: hiddenByProject.get(pid) ?? [],
    };
  }

  return { projects, projectData, baselineOrg, roles };
}
