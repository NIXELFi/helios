# Purchasing and finance in Helios

Design, 2026-09-28. Author: Ralf Petitt (CFO), drafted with Claude.
Status: **for review by Nick** before any code.

## Why

Purchasing today is a Slack message, an Airtable row, the CFO's inbox and a
card statement, joined by hand. Requests get missed, nothing checks a
subteam's budget, and the CFO is the only link between a request and the
charge that paid for it.

A standalone prototype (`sdm-purchasing-tool`, Python + SQLite, run locally by
the CFO since 2026-09-28) fixed this and is already the CFO's source of truth.
It proved the rules below against real data: all 439 Airtable rows, four
Chase checking statements and three card statements, every one reconciled to
the cent. This spec moves it into Helios so it gets real sign-in, reaches
every lead and exec, and lives next to Projects and the Vault.

It is a rewrite in Helios's stack (Postgres RPCs + React), not a port: the
prototype's rules, data and tests are the spec.

## Scope

**Phase A: Purchasing** (team-facing)
- Parts sheet replacing Airtable: a tab per subteam, spreadsheet-style
  editing, paste rows from Excel / Airtable / Mouser and Digikey carts.
- Requests and two-exec approval with the effect on the subteam's budget.
- Orders (several items per vendor order), tracking, delivered, received.
- Budgets per budget line: budget, spent, committed, planned, remaining.
- Notifications: Helios inbox + desktop notification. **No Slack**: ASU's
  Slack doesn't allow the integration yet, so the hook is left for later.

**Phase B: Finance** (execs only)
- Ledger of the Chase checking account and the SAE card(s), fed by
  statement PDFs that are refused unless they add up to their own totals.
- Available-to-spend, card cycle headroom, weekly balance check-ins with
  history, reimbursements owed per person, discrepancy list, CSV export.
- Matching of invoices, order emails and requests to statement lines.

**Not in scope:** email ingestion, Slack `/buy` command, in-kind sponsor
tracking, ASU dean's/gift account feeds. The data model must not block them.

## Mapping onto Helios

| Purchasing concept | Helios |
|---|---|
| Car (IC / EV) | `pm.projects`: SDM27 is IC, SDM27e is EV (confirmed) |
| Subteam | `pm.subteams` (existing list: DAQ, ENG, AED, AEM, PAL, …) |
| Who can do what | `pm.capabilities` + `pm.has_capability()` |
| People / sign-in | `auth.users` via existing Helios auth |
| Vendor | free text normalised on save, optional FK to `pm.vendors` |
| Slack | not used for now (ASU Slack doesn't allow it yet); `notify.outbox` later |
| Desktop alerts | `@tauri-apps/plugin-notification` (already a dependency) |
| Audit trail | new `purchasing.events` (every field change: who, when, old, new) |

**Shared items.** Some purchases serve both cars (e.g. a chassis tube order
for IC and EV). Every item and every ledger charge carries one or more
allocations of *(project, subteam, percent)* summing to 100. The default is
one allocation at 100%, so the common case looks like no splitting at all.

**Budget lines, not subteams.** A budget line belongs to a season and a
project and covers one or more subteams. This handles Aero: one Aero budget
covers both Aero Design and Aero Manufacturing (Aero Design rarely spends,
since its work is conceptual). Performance Analysis is similar and sits on
the vehicle dynamics side. Spend on a subteam that no budget line covers is
shown as "no budget line", never dropped.

## Permissions

New capabilities, checked in every RPC and RLS policy (never only in the UI):

| Capability | Scope | Lets you |
|---|---|---|
| `purchasing.view` | subteam | see items and budgets for that subteam |
| `purchasing.request` | subteam | add items, send for approval, confirm receipt |
| `purchasing.approve` | org | approve / deny requests |
| `purchasing.order` | org | record orders, tracking, delivered |
| `finance.view` | org | see the ledger, balances, reimbursements |
| `finance.edit` | org | edit ledger rows, enter balances, import statements |

Grants: Owner and Executive get all. **Any team member can request**: Lead,
VP and Engineer get `purchasing.view` + `purchasing.request` in their
subteam; Viewer gets `purchasing.view`. Nothing is bought without exec
approval, and every item records who entered it: the approval card and the
exec notification both name the requester. Requesters can't set order,
payment or tracking fields.

**Executive must be exactly the six execs**: Ralf Petitt (CFO), Hayden Enke
(President), Daniel Germaine (Chief Engineer), Cole Diefenderfer (EV
Mechanical Chief), Chris Truong (COO), Adrian Rodriguez (EV Electrical Chief).
Whoever holds Owner also sees finance; the CFO has confirmed that's fine.

**Who sees what** (CFO, 2026-09-29):

- The **parts list is open to the whole team**, as it was in Airtable: any
  member sees every subteam's parts. They add and edit parts only for their
  own subteam.
- **Budgets are not**: a member only gets the budget lines for their own
  subteam ("we don't want anyone getting jealous"). Budgets come from a
  `security definer` RPC that filters by capability, never a client-side
  filter, and the `budget_lines` table itself is exec-only.
- **Money is exec-only**: the ledger, balances, accounts, discrepancies and
  the reimbursement list. RLS returns nothing to anyone else.
- **Any member can request a reimbursement** and attach receipts (photos or
  PDFs in a private `receipts` bucket). They see only their own requests and
  receipts, and can change receipts only until an exec has decided.

## Data model (Phase A)

New schema `purchasing`. Amounts are integer cents.

- `seasons (id, name, starts_on, ends_on)`: set by an exec.
- `budget_lines (id, season_id, project_id, name, amount_cents)` and
  `budget_line_subteams (budget_line_id, subteam_id)`.
- `items`: code (`SDM-0142`), title, status, priority, requester, vendor,
  product_url, part_number, quantity, unit_price, tax_shipping_estimate,
  total_estimate, needed_by, justification, notes, helios_ref (optional link
  to a Vault part or PM task), vendor_order_id, actual_total, payment account,
  tracking number, carrier, tracking status, and a timestamp per state.
  Airtable's "DATE NEEDED" is kept raw in its own column (its meaning is
  unconfirmed).
- `item_allocations (item_id, project_id, subteam_id, percent)`.
- `approvals (item_id, user_id, decision, note, at)`, one per exec per item.
- `settings`: approvals required (2), whether a requester's own approval
  counts (no), delivery person (set by an exec), Slack amounts shown (no).
- `notifications (user_id, item_id, kind, message, created_at, read_at)`.
- `events`: audit log for every change.

### States

```
PLANNED -> READY -> APPROVED -> ORDERED -> SHIPPED -> DELIVERED -> RECEIVED -> RECONCILED
 ("Not ready")  |              (BACKORDERED)
                +-> DENIED / CANCELLED          HAVE ("already have it", no spend)
```

Transitions happen only through RPCs. Requesters (any member): PLANNED <->
READY, cancel planned items, confirm RECEIVED. Execs may set any state
(logged).

### Rules carried over from the prototype

- **Approval:** two distinct executives; the requester's own approval
  doesn't count; one deny stops it. Resubmitting clears old decisions.
- **Budget:** Spent = charges in the ledger by allocation + ordered items
  paid outside the ledger (ASU funds, a member's card). Committed = approved
  or ordered items whose charge hasn't been matched yet. Planned = PLANNED +
  READY. Remaining = budget - spent - committed. An item whose charge is
  matched counts once, through the ledger.
- **Waiting too long:** a HIGH item unapproved after 24 h, or any after 72 h,
  is nudged; over 14 days is flagged.
- **Paying with a member's card** when recording an order creates a
  reimbursement for them.
- **Delivery person** (whoever packages are shipped to) is notified when
  tracking is added and on every delivery.

### Paste and bulk actions

Pasting a block of cells into the blank row opens a preview that maps each
column (headers from Airtable, Excel, Mouser and Digikey carts are recognised;
manufacturer part numbers beat distributor ones). One RPC creates all rows
and sends **one** notification for the batch. Bulk actions: send for
approval, approve, record order (shared order number and total split across
items), add tracking, move tab, duplicate, copy as TSV, delete (planning rows
only; later states are cancelled, never deleted).

### Tracking

A pg_cron job every 3 hours calls an Edge Function that asks 17TRACK (one API
key, all carriers) about undelivered tracking numbers and marks items
DELIVERED. Key stored as a Supabase vault secret; with no key the job no-ops
and delivery is marked by hand. Amazon "TBA" numbers aren't covered.

## Data model (Phase B, finance)

New schema `finance`, readable only with `finance.view`:

- `accounts`: Chase checking, each card (last four digits only, holder,
  cycle limit, paid-from account), Square, cash box, ASU accounts, GoFundMe.
- `statements`: account, period, opening/ending balance, totals, sha256.
- `transactions`: account, date, posted, cleared, signed amount, kind
  (charge / credit / deposit / withdrawal / check / transfer / fee), category,
  vendor, reference, status (posted / expected), transfer group.
- `transaction_allocations (transaction_id, project_id, subteam_id, cents)`.
- `evidence`: invoices and order emails, linked to at most one transaction.
- `balance_entries`: append-only; measure = balance or available_credit.
- `reimbursements`: one row per receipt, grouped by person in the UI.
  Status: requested (a member asked) → owed (an exec checked the receipts)
  or denied → paid (check number, and optionally the check written into the
  ledger as uncashed). Requested and owed both count against Available.
- `reimbursement_receipts` + the private `receipts` storage bucket
  (`<reimbursement id>/<file>`), 10 MB, images and PDFs only.
- `discrepancy_resolutions`: an exec's decision on a flag, keyed so it
  survives recomputation.
- Statement PDFs in a private storage bucket readable only with
  `finance.view`.

### Rules carried over from the prototype

- **Counting rule:** money counts once, on the statement line where it moved.
  The card autopay from checking is a transfer, never spending. Invoices,
  requests and emails are evidence, never money.
- **Autopay timing:** checking pays a card statement about 28 days after it
  closes. Until the real autopay
  arrives on a checking statement, an *expected* one is recorded.
- **Card cycle limit:** the card's limit resets when each statement closes.
  Credit used = charges posted this cycle + pending authorizations. Pending
  authorizations come from PaymentNet's "available credit", entered weekly.
- **Available** = confirmed bank balance - card owed - pending
  authorizations - uncashed checks - reimbursements owed. Unconfirmed
  balances never drive it.
- **Reconciliation:** only statement-fed accounts; confirmed balances; the
  latest entry per day; a gap after the last statement says so.
- **Statement import:** the PDFs' text comes out scrambled, so rows are
  rebuilt from word positions. Parsing runs in the desktop app; the parsed
  rows are sent to an RPC that recomputes the totals and refuses the
  statement if it doesn't add up. Only last-four digits are stored.

## UI

A new **Purchasing** module in the sidebar next to PM, with the PM look:
Parts (subteam tabs) · Approvals · Orders & tracking · Budgets · Get
reimbursed · Inbox. Execs also get a **Finance · execs only** section in the
same module's sidebar: Overview (Available, bank, card owed, uncashed checks,
reimbursements owed, card headroom, pipeline, needs attention) · Weekly
balances (click the balance to type this week's number; history) · Ledger
(filters, running balance, edit a line, split it across subteams, attach
invoices and parts) · Reimbursements (review requests, per-person totals, pay
by check) · Discrepancies (resolve with a note) · Accounts.

The ledger maths (Available, card headroom, reconciliation, discrepancies)
is a pure TypeScript module (`modules/purchasing/finance/ledger.ts`,
`discrepancies.ts`) ported from the prototype with its tests.

## Moving the existing data

A one-time import script reads the prototype's SQLite database and loads
items (keeping their SDM codes), approvals, notifications, budgets, ledger
transactions, statements, balances, reimbursements, resolutions and the audit
history. After the CFO checks the import report, the prototype becomes
read-only and Airtable is frozen.

## Testing

- RLS/RPC tests in `infra/pdm-supabase/tests/` against the local stack:
  leads never see another subteam's rows or any finance row; requesters
  can't approve; one deny stops; budget maths; the counting rule; card cycle
  headroom; statement refusal when totals don't match.
- The prototype's 43 tests are rewritten as the acceptance list.
- UI tests with Vitest for the sheet (paste mapping, keyboard movement).

## Delivery

1. This spec reviewed by Nick.
2. Phase A as a PR: migrations (new timestamped files only), RPCs, tests,
   module UI, CHANGELOG entry under `[Unreleased]`. Deployed to the dev
   Supabase project with made-up data.
3. The team tries it on dev; then production and the data import.
4. Phase B the same way.

## Open questions

1. **Dev server:** is it a separate Supabase project? Will Nick deploy
   migrations from PRs, or should we get push access to dev only?
2. **Performance Analysis:** does PA get its own budget line, share one with
   vehicle dynamics / Suspension, or have none?

Settled: SDM27 = IC and SDM27e = EV; any member can request (exec approval
still required); no Slack until ASU allows it.

## Before the PR: local proof of concept

Before asking Nick for anything, the purchasing module is built against a
**local** copy of Helios (the public repo plus a throwaway Supabase stack in
Docker with made-up data) to check how it plugs into auth, roles, subteams,
projects and the sidebar. Nothing touches the hosted Supabase project.

Result (2026-09-29): the module runs against a local stack. DB tests
(`tests/purchasing.test.ts`) cover member requests, subteam isolation, the
two-exec rule, order splitting, delivery notifications, budget scope and the
audit trail. Demo data: `scripts/seed-purchasing-demo.ts` (localhost only).

Phase B result (2026-09-29): finance runs against the same local stack
(`20261001010000_finance_schema.sql`, `tests/finance.test.ts`). The CFO's
real ledger was imported locally with `scripts/import-sdm-ledger.ts` (reads
an export made by the prototype's `python -m sdm.export_helios`; localhost
only). Every dashboard figure matches the prototype to the cent.

Not built yet: statement PDF import inside Helios (statements are still
parsed by the prototype and brought over with the export), and the CFO
handbook page.

Found while testing: `tests/end-to-end.test.ts` orders `pdm.audit_log` by
`ts` only; `check_in` and `lock_released` share a transaction timestamp, so
after other tests have deleted rows the order can flip. It passes on a fresh
database. Ordering by `(ts, id)` would make it stable.

### Deploying to a hosted project

- Apply `20261001000000_purchasing_schema.sql` and
  `20261001010000_finance_schema.sql` (in that order) **before** exposing the
  schemas: PostgREST won't start if an exposed schema doesn't exist yet.
- Add `purchasing` and `finance` to **Exposed schemas** in the dashboard (API settings);
  `config.toml` only covers local stacks. Without it every call returns null.
- Set `purchasing.settings.delivery_person_id` to the delivery person's user id.
- In Phase A "spent" comes from recorded orders (`actual_total`). Once the
  ledger lands in Phase B it comes from statement lines instead.
