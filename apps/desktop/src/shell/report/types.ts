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
  module: string | null;
  app_version: string | null;
  os: string | null;
  breadcrumbs: Breadcrumb[];
  last_error: LastError | null;
  screenshot_path: string | null;
  status: "new" | "triaged" | "fixed";
}
