import { useState } from "react";
import { useHeliosAuth } from "../../auth/AuthShell";
import type { ReportDraft, ReportDiagnostics } from "./types";

export const REPORT_BUCKET = "report-attachments";

/** Files a report: optionally uploads a screenshot to Storage first, then
 *  inserts the row into support.reports. The app's Supabase client defaults to
 *  the `pdm` schema, so we override per-call with `.schema("support")`. */
export function useSubmitReport() {
  const { client, user } = useHeliosAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(draft: ReportDraft, diag: ReportDiagnostics, screenshot: Blob | null): Promise<boolean> {
    if (!client || !user) {
      setError("You must be signed in to file a report.");
      return false;
    }
    setSubmitting(true);
    setError(null);
    try {
      let screenshot_path: string | null = null;
      if (screenshot) {
        const key = `${crypto.randomUUID()}.png`;
        const { error: upErr } = await client.storage
          .from(REPORT_BUCKET)
          .upload(key, screenshot, { contentType: "image/png" });
        if (upErr) {
          setError(`Screenshot upload failed: ${upErr.message}`);
          return false;
        }
        screenshot_path = key;
      }
      const { error: insErr } = await (client as any)
        .schema("support")
        .from("reports")
        .insert({
          kind: draft.kind,
          severity: draft.severity,
          title: draft.title.trim(),
          what_doing: draft.what_doing.trim() || null,
          details: draft.details.trim() || null,
          module: diag.module,
          app_version: diag.app_version,
          os: diag.os,
          breadcrumbs: diag.breadcrumbs,
          last_error: diag.last_error,
          screenshot_path,
        });
      if (insErr) {
        setError(insErr.message);
        return false;
      }
      return true;
    } finally {
      setSubmitting(false);
    }
  }

  return { submit, submitting, error };
}
