import type { ReactNode } from "react";
import type { SupabaseClient } from "@helios/auth";
import type { PurchasingData } from "../../lib/usePurchasing";
import type { FinanceData } from "../useFinance";
import type { Account, TxnAllocation } from "../ledger";
import { fmtCents } from "../../lib/money";

/** What every finance page gets. */
export interface FinanceProps {
  client: SupabaseClient;
  fin: FinanceData;
  pur: PurchasingData;
  reload: () => Promise<void>;
  flash: (msg: string, error?: boolean) => void;
  me: string;                                   // the signed-in exec's name, for "entered by"
  openTxn: (id: number) => void;                // jump to a ledger line
}

export async function attempt(flash: FinanceProps["flash"], reload: () => Promise<void>, label: string, fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); await reload(); if (label) flash(label); return true; }
  catch (e) { flash(e instanceof Error ? e.message : String(e), true); return false; }
}

/** "SDM27 Data AQ", "Team Operations", "" */
export function whereLabel(pur: PurchasingData) {
  return (projectId: string | null, subteamId: string | null): string => {
    const car = projectId ? pur.projects.find((p) => p.id === projectId)?.car_code ?? "?" : "Team";
    const st = subteamId ? pur.subteams.find((s) => s.id === subteamId)?.name ?? "?" : "";
    return st ? `${car} ${st}` : "";
  };
}

export const shortDate = (d: string | null) => {
  if (!d) return "";
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, day ?? 1).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
};

export const accountLabel = (a: Account | undefined) => (a ? `${a.name}${a.last4 && !a.name.includes(a.last4) ? ` ••${a.last4}` : ""}` : "?");

export function Tile({ label, value, note, hero }: { label: string; value: ReactNode; note?: ReactNode; hero?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${hero ? "border-asu-gold/60 bg-asu-gold/10" : "border-helios-line bg-helios-panel"}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-helios-dim">{label}</div>
      <div className={`mt-1 font-semibold tabular-nums ${hero ? "text-3xl text-asu-gold" : "text-2xl"}`}>{value}</div>
      {note && <div className="mt-1 text-xs text-helios-dim">{note}</div>}
    </div>
  );
}

export function Badge({ tone = "plain", children, title }: { tone?: "good" | "bad" | "warn" | "plain" | "info"; children: ReactNode; title?: string }) {
  const style = {
    good: "bg-helios-success/15 text-helios-success",
    bad: "bg-helios-danger/15 text-helios-danger",
    warn: "bg-asu-gold/15 text-asu-gold",
    info: "bg-helios-info/15 text-helios-info",
    plain: "bg-helios-strip text-helios-dim",
  }[tone];
  return <span title={title} className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold ${style}`}>{children}</span>;
}

export function Money({ cents, signed }: { cents: number | null | undefined; signed?: boolean }) {
  if (cents === null || cents === undefined) return <span className="text-helios-muted">—</span>;
  return <span className={`tabular-nums ${signed ? (cents < 0 ? "text-helios-danger" : cents > 0 ? "text-helios-success" : "") : ""}`}>{fmtCents(cents)}</span>;
}

export function Bar({ fraction, level }: { fraction: number; level: "ok" | "warn" | "danger" }) {
  const color = level === "danger" ? "bg-helios-danger" : level === "warn" ? "bg-asu-gold" : "bg-helios-success";
  return (
    <div className="h-2 overflow-hidden rounded-full bg-helios-strip">
      <div className={`h-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, fraction * 100)).toFixed(1)}%` }} />
    </div>
  );
}

/** A small line of balance history. */
export function Sparkline({ points }: { points: [string, number][] }) {
  if (points.length < 2) return null;
  const vals = points.map((p) => p[1]);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const t0 = Date.parse(points[0]![0]), t1 = Date.parse(points.at(-1)![0]), tspan = t1 - t0 || 1;
  const xy = points.map(([d, v]) => `${(((Date.parse(d) - t0) / tspan) * 300).toFixed(1)},${(52 - ((v - lo) / span) * 48).toFixed(1)}`).join(" ");
  return (
    <div>
      <svg viewBox="0 0 300 56" preserveAspectRatio="none" className="h-14 w-full" role="img" aria-label="Balance history">
        <polyline points={xy} fill="none" stroke="rgb(var(--asu-gold))" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[10px] text-helios-muted"><span>{shortDate(points[0]![0])}</span><span>{shortDate(points.at(-1)![0])}</span></div>
    </div>
  );
}

export const input = "rounded-md border border-helios-line bg-helios-strip px-2 py-1 text-sm";

/** Car + subteam pickers for a split share. */
export function WherePicker({ pur, value, onChange }: {
  pur: PurchasingData; value: Pick<TxnAllocation, "project_id" | "subteam_id">;
  onChange: (v: Pick<TxnAllocation, "project_id" | "subteam_id">) => void;
}) {
  return (
    <>
      <select className={`${input} min-w-0 flex-1`} value={value.project_id ?? ""} onChange={(e) => onChange({ ...value, project_id: e.target.value || null })}>
        <option value="">Team (both cars)</option>
        {pur.projects.map((p) => <option key={p.id} value={p.id}>{p.car_code}</option>)}
      </select>
      <select className={`${input} min-w-0 flex-[2]`} value={value.subteam_id} onChange={(e) => onChange({ ...value, subteam_id: e.target.value })}>
        <option value="">Subteam…</option>
        {pur.subteams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </>
  );
}
