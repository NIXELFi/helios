import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconBuildingBank, IconCheckbox, IconChartPie, IconFileInvoice, IconInbox, IconLayoutDashboard, IconListDetails,
  IconAlertTriangle, IconBook2, IconCloudUpload, IconMap2, IconReceipt2, IconScale, IconTable, IconTruckDelivery, type TablerIcon,
} from "@tabler/icons-react";
import { useHeliosAuth, userDisplayName } from "../../auth/AuthShell";
import { useModuleLive } from "../../shell/module-activity";
import { can } from "./lib/api";
import { usePurchasing } from "./lib/usePurchasing";
import { Flash } from "./components/ui";
import { PartsView } from "./views/PartsView";
import { ApprovalsView } from "./views/ApprovalsView";
import { OrdersView } from "./views/OrdersView";
import { BudgetsView } from "./views/BudgetsView";
import { InboxView } from "./views/InboxView";
import { useFinance } from "./finance/useFinance";
import { OverviewView, type FinanceView } from "./finance/views/OverviewView";
import { BalancesView } from "./finance/views/BalancesView";
import { LedgerView } from "./finance/views/LedgerView";
import { ReimbursementsView } from "./finance/views/ReimbursementsView";
import { DiscrepanciesView } from "./finance/views/DiscrepanciesView";
import { AccountsView } from "./finance/views/AccountsView";
import { MyReimbursementsView } from "./finance/views/MyReimbursementsView";
import type { FinanceProps } from "./finance/views/shared";
import { ImportView } from "./finance/views/ImportView";
import { ExecGuide, MemberGuide, useGuideAnchor } from "./views/GuideView";

type PurchasingView = "parts" | "approvals" | "orders" | "budgets" | "myreimb" | "inbox" | "guide";
type View = PurchasingView | FinanceView | "import" | "execguide";
const PROJECT_KEY = "helios:purchasing:project";
const VIEW_KEY = "helios:purchasing:view";
const FINANCE_VIEWS: string[] = ["overview", "balances", "ledger", "reimbursements", "discrepancies", "accounts", "import", "execguide"];

const SUBTITLE: Record<View, string> = {
  parts: "The team's parts list: add parts when you know you'll need them, send them for approval when the design is settled.",
  approvals: "Oldest and highest priority first. Each card shows what approving does to the subteam's budget.",
  orders: "Approved parts waiting to be bought, and everything on its way.",
  budgets: "Budget, spent, committed and planned per budget line.",
  myreimb: "Paid for something the team needed? Ask to be paid back here, with the receipt.",
  inbox: "Requests, approvals, shipments, deliveries and reimbursements that involve you.",
  guide: "How buying a part works, step by step, and how to get paid back.",
  import: "Upload bank, card and Square exports and invoice lists. Execs only.",
  execguide: "The weekly routine and the rules behind the numbers. Execs only.",
  overview: "What the team can actually spend, the card, and what needs attention.",
  balances: "This week's balances for every account, and how they compare with the ledger.",
  ledger: "Every statement line and hand-entered transaction, with running totals.",
  reimbursements: "Everyone the team owes money, per person, with their receipts.",
  discrepancies: "Anything that doesn't add up, with the lines and documents behind it.",
  accounts: "The accounts the ledger tracks.",
};

/**
 * Agora (purchasing and finance): the parts list that replaces the Airtable cost
 * tracker, exec approvals, orders and tracking, per-subteam budgets,
 * reimbursement requests, and (execs only) the ledger. Every rule is enforced
 * by the purchasing and finance schemas' RPCs and RLS; this UI only decides
 * which controls to offer.
 */
export function AgoraModule() {
  const { client, user } = useHeliosAuth();
  // On screen in a visible window? Like PM, a backgrounded Agora stops polling.
  const active = useModuleLive();
  const { data, loading, error, reload } = usePurchasing(client, active);
  const financeExec = can(data.caps, "finance.view");
  const fin = useFinance(client, active, financeExec);
  const [view, setView] = useState<View>(() => {
    try { return (localStorage.getItem(VIEW_KEY) as View) || "parts"; } catch { return "parts"; }
  });
  const [projectId, setProjectId] = useState<string | null>(() => {
    try { return localStorage.getItem(PROJECT_KEY) || null; } catch { return null; }
  });
  const [txnId, setTxnId] = useState<number | null>(null);
  const [flashMsg, setFlashMsg] = useState<{ text: string; error: boolean } | null>(null);
  const timer = useRef<number>();

  const flash = useCallback((text: string, isError = false) => {
    setFlashMsg({ text, error: isError });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFlashMsg(null), isError ? 7000 : 3000);
  }, []);
  const reloadAll = useCallback(async () => { await Promise.all([reload(), fin.reload()]); }, [reload, fin.reload]);

  useEffect(() => {
    try { if (projectId) localStorage.setItem(PROJECT_KEY, projectId); else localStorage.removeItem(PROJECT_KEY); } catch { /* private mode */ }
  }, [projectId]);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* private mode */ }
    scroller.current?.scrollTo({ top: 0 });
  }, [view]);
  // Forget a remembered car that no longer exists.
  useEffect(() => {
    if (projectId && data.projects.length && !data.projects.some((p) => p.id === projectId)) setProjectId(null);
  }, [data.projects, projectId]);

  const exec = can(data.caps, "purchasing.approve");
  const waiting = data.items.filter((i) => i.status === "READY").length;
  const toOrder = data.items.filter((i) => i.status === "APPROVED").length;
  const unread = data.notifications.filter((n) => !n.read_at).length;
  const toReview = fin.data.reimbursements.filter((r) => r.status === "requested").length;

  const nav: { id: View; label: string; Icon: TablerIcon; count?: number; show: boolean }[] = [
    { id: "parts", label: "Parts & requests", Icon: IconTable, show: true },
    { id: "approvals", label: "Approvals", Icon: IconCheckbox, count: waiting, show: exec },
    { id: "orders", label: "Orders & tracking", Icon: IconTruckDelivery, count: toOrder, show: can(data.caps, "purchasing.order") },
    { id: "budgets", label: "Budgets", Icon: IconChartPie, show: true },
    { id: "myreimb", label: "Get reimbursed", Icon: IconReceipt2, show: true },
    { id: "inbox", label: "Inbox", Icon: IconInbox, count: unread, show: true },
    { id: "guide", label: "How it works", Icon: IconMap2, show: true },
  ];
  const financeNav: { id: FinanceView | "import" | "execguide"; label: string; Icon: TablerIcon; count?: number }[] = [
    { id: "overview", label: "Overview", Icon: IconLayoutDashboard },
    { id: "balances", label: "Weekly balances", Icon: IconScale },
    { id: "ledger", label: "Ledger", Icon: IconListDetails },
    { id: "reimbursements", label: "Reimbursements", Icon: IconFileInvoice, count: toReview },
    { id: "discrepancies", label: "Discrepancies", Icon: IconAlertTriangle },
    { id: "import", label: "Upload files", Icon: IconCloudUpload },
    { id: "accounts", label: "Accounts", Icon: IconBuildingBank },
    { id: "execguide", label: "Exec guide", Icon: IconBook2 },
  ];
  // A finance page someone can't see (or a stale remembered one) falls back to the parts list.
  const isFinance = FINANCE_VIEWS.includes(view);
  const shown: View = isFinance && !financeExec ? "parts" : !isFinance && !nav.find((n) => n.id === view)?.show ? "parts" : view;
  const label = [...nav, ...financeNav].find((n) => n.id === shown)?.label;

  const openTxn = useCallback((id: number) => { setTxnId(id); setView("ledger"); }, []);
  const [anchor, setAnchor] = useState<string | null>(null);
  const go = useCallback((v: string, a?: string) => { setView(v as View); setAnchor(a ?? null); }, []);
  useGuideAnchor(anchor);
  const [partFocus, setPartFocus] = useState<{ q: string; n: number } | null>(null);
  const openPart = useCallback((code: string) => { setPartFocus((f) => ({ q: code, n: (f?.n ?? 0) + 1 })); setView("parts"); }, []);

  if (!client) return <div className="grid h-full place-items-center text-helios-dim">Sign in to use Agora.</div>;

  const fp: FinanceProps = {
    client, fin: fin.data, pur: data, reload: reloadAll, flash, me: userDisplayName(user) || user?.email || "exec", openTxn,
  };
  const navButton = (id: View, text: string, Icon: TablerIcon, count?: number) => (
    <button key={id} onClick={() => setView(id)}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13.5px] ${shown === id
        ? "bg-asu-gold/10 font-semibold text-asu-gold" : "text-helios-text hover:bg-helios-strip"}`}>
      <Icon size={16} stroke={1.6} />{text}
      {!!count && <span className="ml-auto rounded-full bg-asu-gold px-1.5 text-[11px] font-bold text-helios-on-gold">{count}</span>}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 bg-helios-base text-helios-text">
      <aside className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-helios-line bg-helios-panel/60 p-3">
        <div className="mb-2 px-2 text-[10px] font-bold uppercase tracking-[0.18em] text-helios-muted">Agora</div>
        {nav.filter((n) => n.show).map(({ id, label: l, Icon, count }) => navButton(id, l, Icon, count))}
        {financeExec && (
          <>
            <div className="mb-2 mt-4 px-2 text-[10px] font-bold uppercase tracking-[0.18em] text-helios-muted">Finance (execs only)</div>
            {financeNav.map(({ id, label: l, Icon, count }) => navButton(id, l, Icon, count))}
          </>
        )}
        <div className="mt-auto px-2 pt-4 text-[11px] leading-snug text-helios-muted">
          Anyone on a subteam can request parts. Nothing is bought without two exec approvals.
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-helios-line bg-helios-panel/40 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold">{label}</h1>
            <p className="text-xs text-helios-dim">{SUBTITLE[shown]}
              {shown === "parts" && <> <button className="text-asu-gold hover:underline" onClick={() => go("guide", "g-m-planned")}>What do the statuses mean?</button></>}</p>
          </div>
          {(shown === "parts" || shown === "budgets") && (
            <div className="flex items-center gap-1 rounded-lg border border-helios-line p-1 text-sm">
              <CarButton on={!projectId} onClick={() => setProjectId(null)}>Both cars</CarButton>
              {data.projects.map((p) => (
                <CarButton key={p.id} on={projectId === p.id} onClick={() => setProjectId(p.id)}>{p.car_code}</CarButton>
              ))}
            </div>
          )}
        </header>
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto p-6">
          <Flash message={error ?? fin.error} error />
          <Flash message={flashMsg?.text ?? null} error={flashMsg?.error} />
          {loading || (isFinance && financeExec && fin.loading) ? <div className="text-sm text-helios-dim">Loading...</div>
            : shown === "parts" ? <PartsView client={client} data={data} projectId={projectId} reload={reloadAll} flash={flash} focus={partFocus} />
            : shown === "approvals" ? <ApprovalsView client={client} data={data} userId={user?.id ?? null} reload={reloadAll} flash={flash} />
            : shown === "orders" ? <OrdersView client={client} data={data} reload={reloadAll} flash={flash} />
            : shown === "budgets" ? <BudgetsView client={client} data={data} projectId={projectId} openPart={openPart} openTxn={financeExec ? openTxn : undefined} />
            : shown === "myreimb" ? <MyReimbursementsView client={client} pur={data} mine={fin.data.reimbursements} userId={user?.id ?? null} reload={reloadAll} flash={flash} />
            : shown === "inbox" ? <InboxView client={client} data={data} reload={reloadAll} go={go} />
            : shown === "overview" ? <OverviewView {...fp} go={go} />
            : shown === "balances" ? <BalancesView {...fp} />
            : shown === "ledger" ? <LedgerView {...fp} selected={txnId} select={setTxnId} />
            : shown === "reimbursements" ? <ReimbursementsView {...fp} />
            : shown === "discrepancies" ? <DiscrepanciesView {...fp} />
            : shown === "import" ? <ImportView {...fp} />
            : shown === "guide" ? <MemberGuide go={go} />
            : shown === "execguide" ? <ExecGuide go={go} />
            : <AccountsView {...fp} />}
        </div>
      </main>
    </div>
  );
}

function CarButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`rounded-md px-3 py-1 ${on ? "bg-asu-gold font-semibold text-helios-on-gold" : "text-helios-dim hover:bg-helios-strip"}`}>
      {children}
    </button>
  );
}
