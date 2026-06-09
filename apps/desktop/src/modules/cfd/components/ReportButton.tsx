// One-click engineering-report export, shared by every screen header. Saves a
// self-contained light-theme HTML document (open → print to PDF). `only`
// scopes it (e.g. Compare passes the pinned ids); omitted = the full master
// report covering every study.

import { useState } from "react";

import { useCfd } from "../state/CfdContext";
import { exportMasterReport } from "../lib/export/exportReport";

interface Props {
  only?: string[];
  label?: string;
  title?: string;
}

export function ReportButton({ only, label = "Report (PDF)", title }: Props) {
  const { state } = useCfd();
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    try {
      const path = await exportMasterReport(
        { studies: state.studies, vehicleConfig: state.vehicleConfig, referenceBaseline: state.referenceBaseline },
        only,
        title,
      );
      setMsg(path == null ? "Cancelled" : `Saved → ${path.split(/[\\/]/).pop()} — open & print to PDF`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setMsg(null), 5000);
  }

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void run()}
        title="Export a numbered, print-ready engineering report (HTML — open in a browser and print to PDF)"
        className="rounded-sm border border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
      >
        {label}
      </button>
      {msg && <span role="status" className="text-[10px] text-[#D8DCE2]">{msg}</span>}
    </span>
  );
}
