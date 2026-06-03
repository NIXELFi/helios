import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums — mirror the SQL enums in docs/pm/migrations/001-pm-initial-schema.sql.
// NOTE 2026-05: terminology shift. The original spec used "subsystem" for the
// top-level org unit (Chassis, Suspension, …). That role is now Subteam, and
// Subsystem is a finer-grained unit nested under each subteam (e.g. the
// Chassis subteam has Front bulkhead, Main hoop, and Mounts subsystems).
// The SQL artifact under docs/pm/migrations/ still uses the old naming and
// needs to be brought in line by the backend owner — see docs/pm/README.md.
// ---------------------------------------------------------------------------

export const taskStatus = z.enum([
  "not_started",
  "in_progress",
  "needs_review",
  "blocked",
  "done",
]);
export type TaskStatus = z.infer<typeof taskStatus>;
export const TASK_STATUSES: readonly TaskStatus[] = [
  "not_started",
  "in_progress",
  "needs_review",
  "blocked",
  "done",
];

export const taskPriority = z.enum(["low", "medium", "high", "critical"]);
export type TaskPriority = z.infer<typeof taskPriority>;
export const TASK_PRIORITIES: readonly TaskPriority[] = ["low", "medium", "high", "critical"];

export const taskType = z.enum([
  "part",
  "drawing",
  "simulation",
  "assembly",
  "analysis",
  "test",
  "general",
]);
export type TaskType = z.infer<typeof taskType>;
export const TASK_TYPES: readonly TaskType[] = [
  "part",
  "drawing",
  "simulation",
  "assembly",
  "analysis",
  "test",
  "general",
];

export const teamRole = z.enum(["admin", "lead", "engineer", "viewer"]);
export type TeamRole = z.infer<typeof teamRole>;

export const depType = z.enum(["FS", "SS", "FF", "SF"]);
export type DepType = z.infer<typeof depType>;

export const linkType = z.enum([
  "designs",
  "validates",
  "manufactures",
  "tests",
  "reviews",
]);
export type LinkType = z.infer<typeof linkType>;

export const milestoneType = z.enum([
  "design_review",
  "integration",
  "validation",
  "gate",
  "comp_event",
]);
export type MilestoneType = z.infer<typeof milestoneType>;

export const activityAction = z.enum([
  "created",
  "updated",
  "deleted",
  "status_changed",
  "linked",
  "unlinked",
  "completed",
  "reviewed",
]);
export type ActivityAction = z.infer<typeof activityAction>;

export const blockType = z.enum([
  "text",
  "h1",
  "h2",
  "h3",
  "list_item",
  "todo",
  "callout",
  "divider",
  "image",
  "code",
  "embed_view",
  "embed_part",
]);
export type BlockType = z.infer<typeof blockType>;

export const pageType = z.enum([
  "doc",
  "design_review",
  "post_mortem",
  "meeting_notes",
  "generic",
]);
export type PageType = z.infer<typeof pageType>;

// ---------------------------------------------------------------------------
// Org entities
// ---------------------------------------------------------------------------

export const project = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
});
export type Project = z.infer<typeof project>;

export const subteam = z.object({
  id: z.string().uuid(),
  name: z.string(),
  code: z.string(),
  slug: z.string(), // URL-friendly identifier, e.g. "aero-design"
  color: z.string().nullable(),
});
export type Subteam = z.infer<typeof subteam>;

export const subsystem = z.object({
  id: z.string().uuid(),
  subteam_id: z.string().uuid(),
  parent_subsystem_id: z.string().uuid().nullable(),
  name: z.string(),
  code: z.string(),
  // color usually inherits from subteam; only set if subsystem needs a custom hue
  color: z.string().nullable(),
});
export type Subsystem = z.infer<typeof subsystem>;

export const user = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email().nullable(),
});
export type User = z.infer<typeof user>;

// ---------------------------------------------------------------------------
// Task entities
// ---------------------------------------------------------------------------

export const task = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  subteam_id: z.string().uuid(),
  subsystem_id: z.string().uuid().nullable(),
  parent_task_id: z.string().uuid().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  type: taskType,
  status: taskStatus,
  priority: taskPriority,
  owner_id: z.string().uuid().nullable(),
  start_date: z.string().nullable(),
  due_date: z.string().nullable(),
  estimate_days: z.number().nullable(),
  mrl: z.number().int().min(1).max(9).nullable(),
  on_critical_path: z.boolean(),
});
export type Task = z.infer<typeof task>;

export const taskRow = task.extend({
  // The PRIMARY subteam (mirrors subteam_id). Unchanged semantics so every
  // existing single-chip view keeps reading `subteam`/`subteam_id`.
  subteam: subteam,
  // The FULL membership list (primary first). A task can belong to multiple
  // subteams; the first entry is always the primary (id === subteam_id).
  subteams: z.array(subteam),
  subsystem: subsystem.nullable(),
  owner: user.nullable(),
});
export type TaskRow = z.infer<typeof taskRow>;

export const taskDependency = z.object({
  predecessor_id: z.string().uuid(),
  successor_id: z.string().uuid(),
  dep_type: depType,
  lag_days: z.number(),
});
export type TaskDependency = z.infer<typeof taskDependency>;

export const milestone = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  name: z.string(),
  target_date: z.string(),
  type: milestoneType,
  description: z.string().nullable(),
});
export type Milestone = z.infer<typeof milestone>;

// A calendar event is not a task: it has no start/end (a single day), can be
// tagged to one, many, or all subteams, and carries free-text type tags.
export const calendarEvent = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  title: z.string(),
  date: z.string(), // single ISO day (YYYY-MM-DD)
  all_subteams: z.boolean(), // when true, subteam_ids is ignored
  subteam_ids: z.array(z.string().uuid()),
  type_tags: z.array(z.string()), // free-text tags
  description: z.string().nullable(),
});
export type CalendarEvent = z.infer<typeof calendarEvent>;

export const activity = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  actor_id: z.string().uuid().nullable(),
  action: activityAction,
  target_type: z.string(),
  target_id: z.string().uuid(),
  target_name: z.string().nullable(),
  // Subteam IDs touched by this event (1+ for cross-team links)
  subteam_ids: z.array(z.string().uuid()),
  payload: z.unknown().nullable(),
  created_at: z.string(),
});
export type Activity = z.infer<typeof activity>;

export const page = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  // Pages can belong to the project as a whole (null subteam_id) or to a subteam
  subteam_id: z.string().uuid().nullable(),
  title: z.string(),
  icon: z.string().nullable(),
  type: pageType,
  parent_page_id: z.string().uuid().nullable(),
  order_key: z.string(),
});
export type Page = z.infer<typeof page>;

export const block = z.object({
  id: z.string().uuid(),
  page_id: z.string().uuid(),
  parent_block_id: z.string().uuid().nullable(),
  order_key: z.string(),
  type: blockType,
  props: z.record(z.string(), z.unknown()),
});
export type Block = z.infer<typeof block>;

// ---------------------------------------------------------------------------
// Build workspace (manufacturing workflow) entities
// ---------------------------------------------------------------------------

export const vendorCategory = z.enum([
  "machining",
  "sheet_metal",
  "waterjet",
  "laser",
  "3d_print",
  "composites",
  "fasteners",
  "other",
]);
export type VendorCategory = z.infer<typeof vendorCategory>;
export const VENDOR_CATEGORIES: readonly VendorCategory[] = [
  "machining",
  "sheet_metal",
  "waterjet",
  "laser",
  "3d_print",
  "composites",
  "fasteners",
  "other",
];

export const vendorStatus = z.enum(["active", "preferred", "inactive"]);
export type VendorStatus = z.infer<typeof vendorStatus>;
export const VENDOR_STATUSES: readonly VendorStatus[] = ["active", "preferred", "inactive"];

// Machining-specific capability detail (e.g. CNC mill/lathe, tool changer, axis count).
export const machiningCapability = z.object({
  types: z.array(z.string()),
  features: z.array(z.string()),
  axis_count: z.number().int().nullable(),
});
export type MachiningCapability = z.infer<typeof machiningCapability>;

export const vendor = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  name: z.string(),
  category: vendorCategory,
  contact_name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  location: z.string().nullable(),
  processes: z.array(z.string()),
  machining: machiningCapability.nullable(),
  lead_time_days: z.number().int().nullable(),
  status: vendorStatus,
  notes: z.string().nullable(),
});
export type Vendor = z.infer<typeof vendor>;

export const commentKind = z.enum(["general", "drawing_review"]);
export type CommentKind = z.infer<typeof commentKind>;

export const taskComment = z.object({
  id: z.string().uuid(),
  task_id: z.string().uuid(),
  author_id: z.string().uuid().nullable(),
  body: z.string(),
  created_at: z.string(),
  kind: commentKind,
});
export type TaskComment = z.infer<typeof taskComment>;

// Placeholder for Vault file state. Replaced by a real Vault link later.
export const fileRef = z.object({
  name: z.string(),
  present: z.boolean(),
});
export type FileRef = z.infer<typeof fileRef>;

export const drawingReview = z.enum(["not_submitted", "pending", "pass", "fail"]);
export type DrawingReview = z.infer<typeof drawingReview>;

// One per part-type task — tracks the part file, drawing (pdf) file, and review.
export const buildRecord = z.object({
  task_id: z.string().uuid(),
  part_file: fileRef.nullable(),
  drawing_file: fileRef.nullable(),
  drawing_review: drawingReview,
});
export type BuildRecord = z.infer<typeof buildRecord>;
