// Engineering-report entry point, shared by every screen header. Opens the
// report composer (pick studies → print to PDF / save HTML). `defaultOnly`
// pre-checks that screen's natural scope — e.g. the open study on a results
// screen, the pinned set on Compare; everything is still pickable in the
// dialog.

import { useState } from "react";

import { ReportDialog } from "./ReportDialog";

interface Props {
  defaultOnly?: string[];
  label?: string;
  title?: string;
}

export function ReportButton({ defaultOnly, label = "Report (PDF)", title }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Compose a numbered engineering report (pick studies, then print to PDF)"
        className="rounded-sm border border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
      >
        {label}
      </button>
      {/* Mounted only while open — screens render this button inside contexts
          that tests stub without state. */}
      {open && <ReportDialog open onClose={() => setOpen(false)} defaultSelected={defaultOnly} title={title} />}
    </>
  );
}
