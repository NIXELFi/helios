import type { SupabaseClient } from "@helios/auth";
import { can, markNotificationsRead } from "../lib/api";
import type { PurchasingData } from "../lib/usePurchasing";
import { Button, Empty } from "../components/ui";

const KIND_STYLE: Record<string, string> = {
  ready: "bg-helios-info/15 text-helios-info",
  approved: "bg-asu-gold/15 text-asu-gold",
  denied: "bg-helios-danger/15 text-helios-danger",
  shipped: "bg-sky-500/15 text-sky-300",
  delivered: "bg-helios-success/15 text-helios-success",
  reimbursement: "bg-violet-500/15 text-violet-300",
};

export function InboxView({
  client, data, reload, go,
}: {
  client: SupabaseClient;
  data: PurchasingData;
  reload: () => Promise<void>;
  go: (view: "approvals" | "orders" | "parts" | "reimbursements" | "myreimb") => void;
}) {
  const { notifications, caps } = data;
  const exec = can(caps, "purchasing.approve");
  if (!notifications.length) {
    return <Empty>Nothing yet. You'll get a note here (and a desktop notification) when a request needs approval, is approved, ships or is delivered, or when a reimbursement is decided or paid.</Empty>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button kind="ghost" onClick={() => void markNotificationsRead(client).then(reload)}>Mark all read</Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-helios-line bg-helios-panel">
        {notifications.map((n) => (
          <div key={n.id} className={`flex items-start gap-3 border-b border-helios-line px-4 py-3 ${n.read_at ? "" : "bg-asu-gold/[0.06]"}`}>
            <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${KIND_STYLE[n.kind] ?? "bg-helios-strip text-helios-dim"}`}>{n.kind}</span>
            <div className="flex-1 text-sm">
              {n.message}
              <div className="text-[11px] text-helios-muted">{new Date(n.created_at).toLocaleString()}</div>
            </div>
            {n.kind === "ready" && exec && <Button kind="ghost" onClick={() => go("approvals")}>Review</Button>}
            {n.kind === "approved" && can(caps, "purchasing.order") && <Button kind="ghost" onClick={() => go("orders")}>Order</Button>}
            {n.kind === "reimbursement" && (can(caps, "finance.edit") && n.message.includes("asked to be reimbursed")
              ? <Button kind="ghost" onClick={() => go("reimbursements")}>Review</Button>
              : <Button kind="ghost" onClick={() => go("myreimb")}>View</Button>)}
          </div>
        ))}
      </div>
    </div>
  );
}
