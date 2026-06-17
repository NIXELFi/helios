import type { Breadcrumb, LastError } from "../../lib/breadcrumbs";

export type ReportKind = "bug" | "feature";

export interface ReportDraft {
  kind: ReportKind;
  severity: string;
  title: string;
  what_doing: string;
  details: string;
}

export interface ReportDiagnostics {
  module: string;
  app_version: string;
  os: string;
  breadcrumbs: Breadcrumb[];
  last_error: LastError | null;
}

export interface ReportRow extends ReportDraft {
  id: string;
  created_at: string;
  reporter_id: string;
  /** Submitter identity, denormalized at insert time (the viewer's
   *  `authenticated` role can't read auth.users for other users). Null on rows
   *  filed before this was added — rendered as "Unknown". */
  reporter_name: string | null;
  reporter_subteam: string | null;
  reporter_email: string | null;
  module: string | null;
  app_version: string | null;
  os: string | null;
  breadcrumbs: Breadcrumb[];
  last_error: LastError | null;
  screenshot_path: string | null;
  status: "new" | "triaged" | "fixed";
  /** Admin triage note describing how the report was resolved. Visible to the
   *  reporter too (they can read their own row), so keep it factual. */
  admin_note: string | null;
}
