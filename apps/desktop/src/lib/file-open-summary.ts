import type { Workspace } from "../workspaces/types";

export type PerFileResult =
  | { kind: "valid"; filename: string; workspaces: Workspace[] }
  | { kind: "invalid"; filename: string; reason: string };

export interface FileOpenSummary {
  title: string;
  body: string;
  isAlert: boolean;
}

const MAX_LABELS_INLINE = 8;
const MAX_FILENAMES_INLINE = 6;

export function formatFileOpenSummary(perFile: PerFileResult[]): FileOpenSummary {
  const valid = perFile.filter((r): r is Extract<PerFileResult, { kind: "valid" }> => r.kind === "valid");
  const invalid = perFile.filter((r): r is Extract<PerFileResult, { kind: "invalid" }> => r.kind === "invalid");

  if (valid.length === 0) {
    // Alert mode — every file failed
    return {
      isAlert: true,
      title: "Could not open",
      body: invalid.map((r) => `"${r.filename}": ${r.reason}`).join("\n"),
    };
  }

  const totalWorkspaces = valid.reduce((n, f) => n + f.workspaces.length, 0);
  let title: string;
  let body: string;

  if (valid.length === 1) {
    const f = valid[0]!;
    if (f.workspaces.length === 1) {
      title = `Import workspace from ${f.filename}?`;
    } else {
      title = `Import ${f.workspaces.length} workspaces from ${f.filename}?`;
    }
    const labels = f.workspaces.map((w) => `"${w.label}"`);
    if (labels.length <= MAX_LABELS_INLINE) {
      body = labels.join(", ");
    } else {
      const head = labels.slice(0, 2);
      body = `${head.join(", ")}, and ${labels.length - head.length} more`;
    }
  } else {
    title = `Import ${totalWorkspaces} workspaces from ${valid.length} files?`;
    const filenames = valid.map((f) => f.filename);
    if (filenames.length <= MAX_FILENAMES_INLINE) {
      body = filenames.join(" · ");
    } else {
      const head = filenames.slice(0, 2);
      body = `${head.join(" · ")} · and ${filenames.length - head.length} more`;
    }
  }

  if (invalid.length > 0) {
    body += `\n(${invalid.length} file(s) skipped — not valid Helios bundles)`;
  }

  return { isAlert: false, title, body };
}
