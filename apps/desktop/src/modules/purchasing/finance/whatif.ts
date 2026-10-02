// "What if?": rough effect of big possible expenses (and money coming in) on
// what the team can spend. Nothing here touches the books; it starts from the
// same figures as the Overview and applies each ticked line in order. Pure.

/** Where the money comes from or goes: checking (cash or check), a card, or another account. */
export type PaidFrom = "checking" | `card:${number}` | `account:${number}`;

export interface WhatIfLine {
  id: string;
  label: string;
  cents: number;                // always positive; direction says which way
  direction: "out" | "in";
  paidFrom: PaidFrom;
  budgetLine: string | null;    // a BudgetRow key (spending only)
  on: boolean;
}

export interface WhatIfStart {
  available: number | null;                                      // the Overview's Available (null: no bank balance yet)
  cards: Record<number, { name: string; remaining: number }>;    // what's left on each card this cycle
  accounts: Record<number, { name: string; balance: number | null }>;
  budgets: Record<string, { name: string; remaining: number }>;  // budget - spent - committed
}

export interface WhatIfStep {
  line: WhatIfLine;
  available: number | null;
  card: { name: string; remaining: number } | null;      // the card it was paid with, after it
  account: { name: string; balance: number | null } | null;
  budget: { name: string; remaining: number } | null;
  warnings: string[];
}

const usd = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Apply each ticked line in order. Spending from checking or a card lowers
 * Available (a card charge is money owed from checking); spending from
 * another account (dean's funding, the gift account) lowers that account
 * instead. Money in raises whichever it lands in.
 */
export function runWhatIf(start: WhatIfStart, lines: WhatIfLine[], cushion = 0): WhatIfStep[] {
  let available = start.available;
  const cards = Object.fromEntries(Object.entries(start.cards).map(([k, v]) => [k, { ...v }])) as WhatIfStart["cards"];
  const accounts = Object.fromEntries(Object.entries(start.accounts).map(([k, v]) => [k, { ...v }])) as WhatIfStart["accounts"];
  const budgets = Object.fromEntries(Object.entries(start.budgets).map(([k, v]) => [k, { ...v }])) as WhatIfStart["budgets"];
  const steps: WhatIfStep[] = [];

  for (const line of lines) {
    if (!line.on || !(line.cents > 0)) continue;
    const sign = line.direction === "out" ? -1 : 1;
    const warnings: string[] = [];
    const [kind, idText] = line.paidFrom.split(":") as ["checking" | "card" | "account", string | undefined];
    const id = Number(idText);
    let card: WhatIfStep["card"] = null;
    let account: WhatIfStep["account"] = null;
    let budget: WhatIfStep["budget"] = null;

    if (kind === "account") {
      const a = accounts[id];
      if (a) {
        a.balance = a.balance === null ? null : a.balance + sign * line.cents;
        account = { ...a };
        if (a.balance === null) warnings.push(`${a.name} has no balance entered, so there's no telling whether it covers this`);
        else if (a.balance < 0) warnings.push(`${a.name} would be ${usd(-a.balance)} short`);
      }
    } else {
      if (available !== null) available += sign * line.cents;
      if (kind === "card") {
        const c = cards[id];
        if (c) {
          c.remaining += sign * line.cents;
          card = { ...c };
          if (c.remaining < 0) warnings.push(`${usd(-c.remaining)} over ${c.name}'s limit this cycle: split it across cycles or pay another way`);
        }
      }
    }

    if (line.direction === "out" && line.budgetLine && budgets[line.budgetLine]) {
      const b = budgets[line.budgetLine]!;
      b.remaining -= line.cents;
      budget = { ...b };
      if (b.remaining < 0) warnings.push(`${b.name} would be ${usd(-b.remaining)} over budget`);
    }

    if (kind !== "account") {
      if (available === null) warnings.push("No bank balance entered yet, so Available is unknown");
      else if (available < 0) warnings.push(`Available would be ${usd(available)}: the team can't afford this yet`);
      else if (available < cushion) warnings.push(`Available would drop below your ${usd(cushion)} cushion`);
    }
    steps.push({ line, available, card, account, budget, warnings });
  }
  return steps;
}

/** A plain-text summary to paste into the exec meeting notes. */
export function whatIfText(start: WhatIfStart, steps: WhatIfStep[]): string {
  const out = [`What if? Starting from Available ${start.available === null ? "unknown" : usd(start.available)}`];
  for (const s of steps) {
    const after = s.account ? `${s.account.name} ${s.account.balance === null ? "unknown" : usd(s.account.balance)}` : `Available ${s.available === null ? "unknown" : usd(s.available)}`;
    out.push(`- ${s.line.direction === "out" ? "Spend" : "Receive"} ${usd(s.line.cents)}: ${s.line.label || "(no name)"} -> ${after}${s.warnings.length ? ` (${s.warnings.join("; ")})` : ""}`);
  }
  return out.join("\n");
}
