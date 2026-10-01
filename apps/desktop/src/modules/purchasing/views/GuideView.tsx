import { useEffect, type ReactNode } from "react";
import { Card } from "../components/ui";

/**
 * Plain-English guides with a clickable process map. Every box on the map
 * jumps to its step, and every step has a button that opens the page where
 * it happens. "member" is for everyone; "exec" is shown only to execs.
 */

type Go = (view: string, anchor?: string) => void;
interface Step {
  id: string; title: string; tag?: string; tone?: string;
  who: string; what: ReactNode; page?: [string, string];   // [view, button label]
}

const TONE: Record<string, string> = {
  plan: "border-helios-line bg-helios-strip", ready: "border-helios-info/50 bg-helios-info/10", exec: "border-asu-gold/60 bg-asu-gold/10",
  move: "border-sky-500/40 bg-sky-500/10", you: "border-helios-success/60 bg-helios-success/10", done: "border-helios-success/40 bg-helios-success/5",
  money: "border-violet-400/50 bg-violet-500/10", side: "border-helios-line bg-transparent",
};

function ProcessMap({ steps, prefix, branches }: { steps: Step[]; prefix: string; branches?: Record<string, string[]> }) {
  const jump = (id: string) => document.getElementById(`${prefix}-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <div className="flex flex-wrap items-start gap-y-3">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-start">
          <div className="flex flex-col items-center gap-1">
            <button onClick={() => jump(s.id)} title={`Go to: ${s.title}`}
              className={`w-[132px] rounded-lg border px-2 py-2 text-left transition hover:-translate-y-0.5 hover:border-asu-gold ${TONE[s.tone ?? "plan"]}`}>
              <div className="text-[10px] font-bold uppercase tracking-wider text-helios-dim">{i + 1}. {s.who}</div>
              <div className="text-[13px] font-semibold leading-tight">{s.title}</div>
              {s.tag && <div className="mt-0.5 text-[11px] text-helios-dim">{s.tag}</div>}
            </button>
            {branches?.[s.id]?.map((b) => (
              <button key={b} onClick={() => jump(b.toLowerCase().replace(/[^a-z]+/g, "-"))}
                className={`w-[132px] rounded-md border border-dashed px-2 py-1 text-left text-[11px] text-helios-dim hover:border-asu-gold ${TONE.side}`}>&gt; {b}</button>
            ))}
          </div>
          {i < steps.length - 1 && <div className="mx-1 mt-6 text-helios-muted" aria-hidden>&gt;</div>}
        </div>
      ))}
    </div>
  );
}

function StepCard({ s, n, prefix, go }: { s: Step; n: number; prefix: string; go: Go }) {
  return (
    <div id={`${prefix}-${s.id}`} className={`scroll-mt-4 rounded-lg border p-4 ${TONE[s.tone ?? "plan"]}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-helios-dim">Step {n} | {s.who}</div>
          <div className="text-base font-semibold">{s.title}{s.tag && <span className="ml-2 text-sm font-normal text-helios-dim">({s.tag})</span>}</div>
        </div>
        {s.page && <button className="rounded-md border border-asu-gold px-3 py-1 text-sm font-semibold text-asu-gold hover:bg-asu-gold/10" onClick={() => go(s.page![0])}>{s.page[1]}</button>}
      </div>
      <div className="mt-2 space-y-1 text-sm leading-relaxed">{s.what}</div>
    </div>
  );
}

function Extra({ id, prefix, title, children }: { id: string; prefix: string; title: string; children: ReactNode }) {
  return (
    <div id={`${prefix}-${id}`} className="scroll-mt-4">
      <Card><b>{title}</b><div className="mt-2 space-y-1.5 text-sm leading-relaxed">{children}</div></Card>
    </div>
  );
}

// ------------------------------------------------------------------ members

const PART_STEPS: Step[] = [
  { id: "planned", title: "Not ready to order", tag: "Planned", tone: "plan", who: "You",
    what: <><p>Add the part to your subteam's tab as soon as you know you'll need it, even if the design isn't final. Nothing gets bought yet. This is the team's forecast.</p>
      <p>Type it into the blank row, paste rows from Excel or a Mouser/Digikey cart, or <b>Upload CSV</b> (an Airtable export works). Include the link, part number and quantity.</p></>,
    page: ["parts", "Open the parts list"] },
  { id: "ready", title: "Ready to order", tone: "ready", who: "You",
    what: <><p>When the design is settled and the part is priced, change its status to <b>Ready to order</b>. That sends it to the execs and they get a notification with your name on it.</p>
      <p>Changed your mind? Move it back to Not ready, or Cancel it. You can edit it until it's approved.</p></>,
    page: ["parts", "Open the parts list"] },
  { id: "approval", title: "Two execs approve", tone: "exec", who: "Execs",
    what: <><p>Two different execs must approve before anything is bought. If an exec asked for it, their own approval doesn't count. One "deny" stops it, and you're told why in your Inbox.</p>
      <p>Nothing to do but wait. Stuck for days? Ask in person; the approval queue shows how long it's waited.</p></>,
    page: ["inbox", "Open your inbox"] },
  { id: "ordered", title: "Ordered", tone: "move", who: "Execs",
    what: <p>An exec (usually the CFO or President) buys it and records the order number. The part now counts as money committed from your budget.</p> },
  { id: "shipped", title: "Shipped", tone: "move", who: "Execs",
    what: <p>When tracking is added you get a notification with the tracking number.</p>, page: ["inbox", "Open your inbox"] },
  { id: "delivered", title: "Delivered", tone: "move", who: "Carrier",
    what: <p>The carrier says it arrived. Packages go to the team's delivery person, who is notified every time something is delivered. <b>Delivered is not the same as in your hands.</b></p> },
  { id: "received", title: "Received", tone: "you", who: "You",
    what: <><p>When you <b>physically have the part</b>, set its status to <b>Received</b>. One click. It's the only way the team knows the part made it from the doorstep to the shop. Parts go missing in that gap.</p></>,
    page: ["parts", "Open the parts list"] },
  { id: "reconciled", title: "Reconciled", tone: "done", who: "Execs",
    what: <><p>The execs have matched what was paid to the line on the bank or card statement. That's the money side finished. <b>You don't do anything here.</b></p></> },
];

const REIMB_STEPS: Step[] = [
  { id: "buy", title: "Buy it yourself", tone: "plan", who: "You",
    what: <p>Only when it's urgent and an exec has said OK (for example on a competition trip). Keep the receipt: a photo is fine.</p> },
  { id: "ask", title: "Get reimbursed", tone: "you", who: "You",
    what: <p>Agora &gt; <b>Get reimbursed</b>: the amount, what it was for, your subteam, and the receipt (photo or PDF). The execs are notified. Only you and the execs can see it.</p>,
    page: ["myreimb", "Open Get reimbursed"] },
  { id: "check", title: "An exec checks it", tone: "exec", who: "Execs",
    what: <p>They look at the receipt and approve it or decline it with a reason. Until then you can add more receipts or withdraw it.</p> },
  { id: "paid", title: "Paid by check", tone: "done", who: "Execs",
    what: <p>You get a check. The request shows <b>Paid</b> with the check number, and you get a notification.</p>, page: ["myreimb", "See your requests"] },
];

export function MemberGuide({ go }: { go: Go }) {
  const p = "g-m";
  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <Card>
        <b>Buying a part: the whole journey</b>
        <p className="mb-3 text-xs text-helios-dim">Click any box to jump to it. Green boxes are the ones where it's your move.</p>
        <ProcessMap steps={PART_STEPS} prefix={p} branches={{ ready: ["Cancelled"], approval: ["Denied"], ordered: ["Backordered"] }} />
      </Card>
      <div className="flex flex-col gap-3">{PART_STEPS.map((s, i) => <StepCard key={s.id} s={s} n={i + 1} prefix={p} go={go} />)}</div>

      <Extra id="received-vs-reconciled" prefix={p} title="Received vs Reconciled: what's the difference?">
        <p><b>Received</b> = the <i>part</i> is done. You have it in your hands. You click it.</p>
        <p><b>Reconciled</b> = the <i>money</i> is done. The execs have matched the charge to the bank or card statement, so the books are right. Execs do it; it's never your job.</p>
        <p>A part can be Received but not yet Reconciled (the statement hasn't come in). That's normal.</p>
      </Extra>
      <Extra id="cancelled" prefix={p} title="The side roads">
        <p><b>Cancelled</b>: you don't need it after all (while it's Not ready or Ready).</p>
        <p id={`${p}-denied`}><b>Denied</b>: an exec said no. The reason is in your Inbox. Fix it and set it back to Ready to ask again.</p>
        <p id={`${p}-backordered`}><b>Backordered</b>: bought, but the vendor is waiting on stock.</p>
        <p><b>Already have</b>: it turned out the shop had one.</p>
      </Extra>

      <Card>
        <b>Paid with your own money? Getting paid back</b>
        <p className="mb-3 text-xs text-helios-dim">Click any box to jump to it.</p>
        <ProcessMap steps={REIMB_STEPS} prefix={p} />
      </Card>
      <div className="flex flex-col gap-3">{REIMB_STEPS.map((s, i) => <StepCard key={s.id} s={s} n={i + 1} prefix={p} go={go} />)}</div>

      <Extra id="budget" prefix={p} title="Your subteam's budget">
        <p>Agora &gt; Budgets shows <b>your subteam only</b>. Nobody else's budget is visible to you, and yours isn't visible to other subteams.</p>
        <p><b>Budget</b>: what you were given this season. <b>Spent</b>: charged already. <b>Committed</b>: approved or ordered, not charged yet.
          <b> Planned</b>: parts still Not ready or Ready. <b>Remaining</b> = Budget - Spent - Committed. <b>After planned</b> = Remaining - Planned: if it's negative, the parts you plan to buy won't fit.</p>
        <p>Click a line to see every part and charge in it.</p>
        <button className="text-asu-gold hover:underline" onClick={() => go("budgets")}>Open Budgets</button>
      </Extra>
      <Extra id="tips" prefix={p} title="Tips">
        <p>Everyone can see the whole parts list, so check another subteam isn't already buying the same thing.</p>
        <p>One row per part. Put the link and the manufacturer part number in: they're how the order gets matched to its email and invoice.</p>
        <p>Big list of small parts (DAQ boards!)? Copy them from the Mouser or Digikey cart and paste into the blank row, or upload the CSV.</p>
      </Extra>
    </div>
  );
}

// -------------------------------------------------------------------- execs

const WEEK_STEPS: Step[] = [
  { id: "download", title: "Download the exports", tone: "plan", who: "CFO",
    what: <>
      <p><b>Chase checking</b>: chase.com &gt; the account &gt; Download account activity &gt; CSV, from the last download date.</p>
      <p><b>SAE card</b>: the card's CSV export (PaymentNet or chase.com). If it's a full statement, note its closing date.</p>
      <p><b>Square</b>: Square Dashboard &gt; Transactions &gt; Export &gt; Transactions CSV. That covers dues, invoices that were paid, and sales.</p>
      <p><b>Invoices</b>: a CSV with Vendor, Date, Order #, Total works; or attach PDFs to ledger lines later.</p></> },
  { id: "upload", title: "Upload them", tone: "exec", who: "CFO",
    what: <>
      <p>Finance &gt; <b>Upload files</b>. Drop each file in. Helios recognises Chase checking, Chase card and Square files; for anything else, pick which column is the date, amount and description.</p>
      <p>The preview shows what each line will do: <b>new</b>, <b>already in the ledger</b> (skipped, so nothing counts twice), <b>clears a check</b>, or <b>confirms the autopay</b>. Fix categories there if you like, then press Import.</p>
      <p>The same file can't be imported twice.</p></>,
    page: ["import", "Open Upload files"] },
  { id: "tidy", title: "Tidy new lines", tone: "exec", who: "CFO",
    what: <>
      <p>Ledger &gt; tick <b>Needs attention</b>. For each line: set the category and the subteam split (a shared purchase can be split across cars and subteams).</p>
      <p>Charges of <b>$300 or more need an invoice</b> (handbook rule): open the line and attach the PDF or photo.</p></>,
    page: ["ledger", "Open the Ledger"] },
  { id: "balances", title: "Enter this week's balances", tone: "exec", who: "CFO",
    what: <>
      <p>Weekly balances &gt; click each number and type this week's figure: <b>Chase</b> (from the bank), <b>SAE card available credit</b> (from PaymentNet: it's how pending charges show up), Square, cash box, ASU accounts.</p>
      <p>Nothing is overwritten: every entry is kept. If the Chase number doesn't match what the ledger computes, the difference shows as "unexplained".</p></>,
    page: ["balances", "Open Weekly balances"] },
  { id: "discrepancies", title: "Clear the discrepancies", tone: "exec", who: "CFO",
    what: <><p>Discrepancies lists anything that doesn't add up: a charge with no invoice, an invoice with no charge, a possible duplicate, an amount that differs, a balance that doesn't tie out. Fix it, or mark it resolved with a note (e.g. "two hotel rooms").</p></>,
    page: ["discrepancies", "Open Discrepancies"] },
  { id: "reimburse", title: "Reimbursements", tone: "money", who: "CFO",
    what: <><p>Review new requests (look at the receipt), approve or decline. To pay: tick one person's rows, enter the check number, keep <b>Write the check into the ledger</b> on. The check then counts against Available until it clears.</p></>,
    page: ["reimbursements", "Open Reimbursements"] },
  { id: "meeting", title: "Read the Overview", tone: "done", who: "All execs",
    what: <><p>For the meeting: <b>Available to spend</b> (the real number, not the bank balance), <b>card credit used</b> this cycle, and Needs attention.</p></>,
    page: ["overview", "Open the Overview"] },
];

const BUY_STEPS: Step[] = [
  { id: "approve", title: "Approve (2 execs)", tone: "exec", who: "Execs",
    what: <p>Approvals shows each request with the requester's name and what it does to the subteam's budget. Two different execs must approve; the requester's own approval doesn't count.</p>,
    page: ["approvals", "Open Approvals"] },
  { id: "order", title: "Buy it", tone: "exec", who: "CFO / President",
    what: <p>Orders & tracking: tick the parts bought together, enter the order number, the total actually charged and how it was paid. If a member paid, put their name in "Member who paid" and add a reimbursement.</p>,
    page: ["orders", "Open Orders"] },
  { id: "track", title: "Add tracking", tone: "move", who: "CFO",
    what: <p>Paste the tracking number (the carrier is detected). The delivery person and the requester are notified. Mark Delivered when it lands; the delivery person is told again.</p>, page: ["orders", "Open Orders"] },
  { id: "match", title: "Match the charge", tone: "money", who: "CFO",
    what: <p>When the charge shows up on an uploaded statement, open the ledger line: the part appears under "Could be". Attach it. A Received part becomes Reconciled.</p>, page: ["ledger", "Open the Ledger"] },
];

export function ExecGuide({ go }: { go: Go }) {
  const p = "g-e";
  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <Card>
        <b>The weekly routine (before the exec meeting)</b>
        <p className="mb-3 text-xs text-helios-dim">About 15 minutes a week. Click a box to jump to it; each step has a button to the page.</p>
        <ProcessMap steps={WEEK_STEPS} prefix={p} />
      </Card>
      <div className="flex flex-col gap-3">{WEEK_STEPS.map((s, i) => <StepCard key={s.id} s={s} n={i + 1} prefix={p} go={go} />)}</div>

      <Card>
        <b>A purchase, exec side</b>
        <p className="mb-3 text-xs text-helios-dim">The member side is in "How it works".</p>
        <ProcessMap steps={BUY_STEPS} prefix={p} />
      </Card>
      <div className="flex flex-col gap-3">{BUY_STEPS.map((s, i) => <StepCard key={s.id} s={s} n={i + 1} prefix={p} go={go} />)}</div>

      <Extra id="rules" prefix={p} title="How the money is counted">
        <p><b>Money counts once, on the statement line where it moved.</b> A card purchase counts on the card. The monthly card payment from Chase is a <i>transfer</i> (it pays for things already counted), never spending. Square payouts into Chase are transfers too: the dues were counted when they were paid into Square.</p>
        <p>Invoices, parts and emails never add money. They're evidence attached to a statement line.</p>
        <p><b>Available to spend</b> = Chase balance - card owed - pending card charges - checks written but not cashed - reimbursements owed. The bank balance alone overstates it.</p>
        <p><b>The card limit</b> is per billing cycle and resets when a statement closes, even though Chase pays the bill about 28 days later.</p>
        <p>A <b>check</b> counts when it's written and clears when it hits the bank.</p>
      </Extra>
      <Extra id="who" prefix={p} title="Who sees what">
        <p>Only the six execs see Finance (this section), all budgets, and all reimbursements.</p>
        <p>Members see the whole parts list, <b>only their own subteam's budget</b>, and only their own reimbursement requests.</p>
        <p>Only execs can upload statements. Only the last four digits of any account or card number are stored.</p>
      </Extra>
      <Extra id="statuses" prefix={p} title="Received vs Reconciled">
        <p><b>Received</b>: the requester has the part in hand (they click it). <b>Reconciled</b>: the charge for it is matched to a statement line (you do it, by attaching the part to the ledger line). The first is about the part, the second about the money.</p>
      </Extra>
    </div>
  );
}

/** Scroll to an anchor when the guide opens from a "?" link elsewhere. */
export function useGuideAnchor(anchor: string | null) {
  useEffect(() => {
    if (!anchor) return;
    const t = window.setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ block: "start" }), 50);
    return () => window.clearTimeout(t);
  }, [anchor]);
}
