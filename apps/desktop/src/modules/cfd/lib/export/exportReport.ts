// Disk seam for the master engineering report: build → save-dialog → path.
// Kept apart from the pure builder so masterReport stays unit-testable.

import { buildMasterReportHtml } from "./masterReport";
import { saveTextFile, fileTimestamp } from "./io";
import type { Study } from "../../state/types";
import type { ReferenceBaseline, VehicleConfig } from "../performance/types";

export interface ReportState {
  studies: Record<string, Study>;
  vehicleConfig: VehicleConfig | null;
  referenceBaseline: ReferenceBaseline;
}

/** Build and save the report (full workspace, or scoped to `only` study ids).
 *  Returns the saved path, or null when the user cancels the dialog. */
export async function exportMasterReport(
  state: ReportState,
  only?: string[],
  title?: string,
): Promise<string | null> {
  const html = buildMasterReportHtml({
    generatedAt: new Date().toISOString(),
    studies: state.studies,
    vehicleConfig: state.vehicleConfig,
    referenceBaseline: state.referenceBaseline,
    only,
    title,
  });
  const stem = only?.length === 1 ? `helios-cfd-study-report-${fileTimestamp()}` : `helios-cfd-report-${fileTimestamp()}`;
  return saveTextFile(stem, "html", html);
}
