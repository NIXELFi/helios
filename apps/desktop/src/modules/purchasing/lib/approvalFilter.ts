// Filters for the Approvals page: which waiting requests to show, and in what
// order. Pure (tests in __tests__/approvalFilter.test.ts).

import { itemCost, type Item, type Priority } from "./api";

export type Waiting = "" | "1d" | "3d" | "14d";
export type MyVote = "" | "todo" | "voted";
export type ApprovalSort = "" | "oldest" | "newest" | "biggest" | "smallest";

export interface ApprovalFilter {
  q: string;
  car: string;          // project id
  subteam: string;      // subteam id
  priority: Priority | "";
  requester: string;    // requester name
  vendor: string;
  waiting: Waiting;     // waiting at least this long
  vote: MyVote;         // whether I've voted yet
  sort: ApprovalSort;   // "" = mine to do first, then priority, then oldest
}
export const NO_FILTER: ApprovalFilter = { q: "", car: "", subteam: "", priority: "", requester: "", vendor: "", waiting: "", vote: "", sort: "" };

const WAITINGS: readonly Waiting[] = ["", "1d", "3d", "14d"];
const VOTES: readonly MyVote[] = ["", "todo", "voted"];
const SORTS: readonly ApprovalSort[] = ["", "oldest", "newest", "biggest", "smallest"];
const PRIORITIES: readonly (Priority | "")[] = ["", "HIGH", "Medium", "Low"];

/** A filter read back from storage: anything that isn't a known value is dropped, so a stale or odd entry can't hide the queue or crash the page. */
export function sanitizeFilter(raw: unknown): ApprovalFilter {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NO_FILTER;
  const r = raw as Record<string, unknown>;
  const text = (k: keyof ApprovalFilter) => (typeof r[k] === "string" ? (r[k] as string) : "");
  const oneOf = <T extends string>(k: keyof ApprovalFilter, allowed: readonly T[]): T => (allowed as readonly string[]).includes(r[k] as string) ? (r[k] as T) : allowed[0]!;
  return {
    q: text("q"), car: text("car"), subteam: text("subteam"), requester: text("requester"), vendor: text("vendor"),
    priority: oneOf("priority", PRIORITIES), waiting: oneOf("waiting", WAITINGS), vote: oneOf("vote", VOTES), sort: oneOf("sort", SORTS),
  };
}

export const WAITING_LABEL: Record<Exclude<Waiting, "">, string> = { "1d": "over a day", "3d": "over 3 days", "14d": "over 14 days" };
const WAITING_HOURS: Record<Exclude<Waiting, "">, number> = { "1d": 24, "3d": 72, "14d": 14 * 24 };
const PRIORITY_ORDER = { HIGH: 0, Medium: 1, Low: 2 } as const;

export interface Waiter { i: Item; hours: number; voted: boolean }

/** True if any filter is set (the sort doesn't count). */
export const isFiltered = (f: ApprovalFilter) => (Object.keys(f) as (keyof ApprovalFilter)[]).some((k) => k !== "sort" && f[k] !== "");

export function filterApprovals<T extends Waiter>(xs: T[], f: ApprovalFilter): T[] {
  const q = f.q.trim().toLowerCase();
  const out = xs.filter(({ i, hours, voted }) =>
    (!q || `${i.code} ${i.title} ${i.vendor ?? ""} ${i.part_number} ${i.requester_name} ${i.notes} ${i.justification}`.toLowerCase().includes(q))
    && (!f.car || i.item_allocations.some((a) => a.project_id === f.car))
    && (!f.subteam || i.item_allocations.some((a) => a.subteam_id === f.subteam))
    && (!f.priority || i.priority === f.priority)
    && (!f.requester || i.requester_name === f.requester)
    && (!f.vendor || (i.vendor ?? "") === f.vendor)
    && (!f.waiting || hours >= WAITING_HOURS[f.waiting])
    && (!f.vote || (f.vote === "voted") === voted));
  const by: Record<ApprovalSort, (a: T, b: T) => number> = {
    "": (a, b) => Number(a.voted) - Number(b.voted) || PRIORITY_ORDER[a.i.priority] - PRIORITY_ORDER[b.i.priority] || b.hours - a.hours,
    oldest: (a, b) => b.hours - a.hours,
    newest: (a, b) => a.hours - b.hours,
    biggest: (a, b) => itemCost(b.i) - itemCost(a.i),
    smallest: (a, b) => itemCost(a.i) - itemCost(b.i),
  };
  return out.sort(by[f.sort]);
}
