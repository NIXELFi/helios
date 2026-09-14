# Productivity view overhaul — proposal

Date: 2026-09-14. Design only; no code changed. Responds to Nick's read of the first cut: "the graphs can look much better, the drop down for subteams defaults to white windows bs, and overall this can be much more 'productive' and useful."

Paths below are relative to `apps/desktop/src/modules/pm/` unless noted.

## 1. Critique of the current view

### Unstyled / off-system controls
- `views/ProductivityViewClient.tsx:250-261` — subteam picker is a bare `<select>` with `bg-transparent`. Chromium WebView2 paints the popup natively, hence the white Windows list. The module already ships a portal-based styled picker: `components/ui/Select.tsx` (swatch dots, search, keyboard nav, groups) and it is what `TaskFilterBar.tsx:78-86` and `ActivityFilterBar.tsx:108-118` use. This view simply didn't use it.
- `:228-243` — custom-range `<input type="date">` uses `bg-transparent` where the house input is `filterInput` (`TaskFilterBar.tsx:249-251`: `bg-helios-base … focus:border-asu-gold`). Native date inputs are tolerated elsewhere (pm.css:44-50 restyles the picker glyph) so keep them, but on the house class.
- `:265-274` — "Stack by person" is a native checkbox. The house idiom for a two-state mode is the segmented pill (`TaskFilterBar.tsx:199-229` Dim/Hide; `SelectCheckbox.tsx` for boxes).
- `:206-222` — date presets are ad-hoc buttons; functional, but they don't match the segmented pill either.

### Charts
- Fixed `viewBox 0 0 760 200` scaled to `w-full` (`:383-386`, `:412-417`). Text set at `text-[10px]` inside a scaled viewBox scales with the panel, so labels are ~14 px on a wide window and ~7 px in the two-column grid. Every chart needs a measured pixel width, not a scaled viewBox.
- One y-axis label (the max, `:419-421`, `:506-508`), no gridlines, no zero label, no units. Bars have no hover state; the only affordance is an SVG `<title>` (`:441`) = native OS tooltip, one-second delay, white.
- Burn-up (`:488-524`) has **no x-axis labels at all**, no area fill, and two lines whose gap is the interesting quantity but is never labelled.
- X labels every `ceil(n/12)` weeks (`:445`), so a 16-week window labels weeks 0, 2, 4… with no visual tie to the bar. No "this week" marker.
- Series colours: `subteamColor` keyed by *name* (`:156-160`) with an index-based fallback palette (`:359-372`). By-person series therefore change colour whenever the set of people changes between windows.
- Cycle histogram and aging are HTML div bars in gold / maroon (`:542-555`, `:604-617`) while throughput is SVG — two rendering systems, two visual languages.
- Loading is a text `Notice` (`:281`) while the shell has `.helios-skeleton` (styles.css:82).

### Metrics that mislead on this team's data
- **Created vs completed** (`lib/productivityMetrics.ts:380-392`): ~320 of 430 tasks were inserted on 2026-06-02. Season-to-date, the "created" line is a vertical wall then flat; any shorter window excludes the wall and shows ~10 creations against 40 completions. Neither reading says anything about scope growth. Drop it.
- **Cycle time from `created_at`** (`:394-414`): for imported tasks `created_at` is the import date, so "cycle time" = days since June 2 for three quarters of the corpus. Median/p85 are artefacts. p85 is also a delivery-team statistic; volunteers with deadline-shaped work don't manage to a tail percentile. Replace with *time in status* (from `status_changed` events, which the RPC already returns via `status_to`/`event_time`) — that is real and un-walled.
- **Aging by creation** (`:431-442`): same wall — the 30+ bucket is "everything imported". Age should be measured from `status_since`/`updated_at`, and only for `blocked`, `needs_review`, and untouched `in_progress`.
- **On-time rate** (`:416-429`) mostly measures whether a due date was set and never re-planned. Useful only per subteam, alongside the "no due date" count as a data-hygiene number.
- **Per-person table** (`:445-503`; view `:622-665`) is sorted completions-desc — a leaderboard of volunteers. The "Open (created)" column is admitted wrong in its own subtitle (`:635`). Owners are in the store (`TaskRow.owners`, `packages/pm-ui/src/types.ts`); the RPC just doesn't join them.
- Header line (`:182-186`) is the only KPI and has no comparison, so nothing on the page answers "is this better or worse than last week".

## 2. Three directions

### A — Polish what exists
Keep the six panels; swap controls for `Select` and segmented pills; one measured-SVG chart system with gridlines, hover tooltips and a this-week marker; add a KPI header with vs-previous-window deltas. Cheapest, but the metrics keep the import-wall problems above and the page still doesn't tell anyone what to do on Monday.

```
+- Productivity ------------------------------------ [Export CSV] -+
| [4w][12w][Season][Custom]   Subteam v (styled)   [Subteam|Person]|
+- KPI  Completed 41 ^12   Open 240 v3   On-time 62% ^4  Blocked 9-+
+- Throughput / week (stacked, tooltip, gridlines) ----------------+
+- Burn-up ---------------+- Cycle time ---------------------------+
+- On-time ---------------+- Aging --------------------------------+
+- By person (table) ----------------------------------------------+
```
Metrics: as today, plus deltas.

### B — "Lead's Monday" (question-driven)
Rebuild the page around what a lead does after reading it: KPI tiles with sparklines and deltas; a week strip; an **Attention** column of clickable lists (slipping this week, stuck in review/blocked and for how long, stale in-progress); a **subteam comparison** strip; **workload balance** instead of a leaderboard. Every number is a link into Table/Board with the matching `?status=&team=&owner=&from=&to=` filters (`lib/filters.ts:53-65` parses exactly these). Person data stays behind the gate but is framed as balance, not ranking.

```
+- Productivity ----------------------------------- [Export CSV] --+
| [This week][4w][12w][Season][Custom >]   * Aero v   [Team|Person] |
+---------------+---------------+---------------+-------------------+
| COMPLETED     | DUE THIS WEEK | STUCK         | ON-TIME (4w)      |
| 14  ^6 vs 4w  | 23 . 9 unown. | 11 . 4 >14d   | 62%  ^4           |
| _.:|.=|:      | __.:|==       | ..::||        | ::.:::|           |
+---------------+---------------+---------------+-------------------+
| WEEKS  |#=_:##.=:=#|  stacked completions by subteam, <> milestones|
|        |           |  ^ this-week band, hover -> per-team tooltip  |
+--------------------------------+---------------------------------+
| ATTENTION                      | SUBTEAMS                        |
| > Slipping (due <= Sun, open)23| Aero    ######..  12 done . 3 st|
|   Front wing mould  Aero  Fri  | Chassis ####....   8 . 1 . 58%  |
|   Diff mount        PT    Thu  | PT      ###.....   5 . 4 . 40%  |
| > Needs review > 7 d         4 |  (sorted by stuck desc)         |
| > Blocked                    7 +---------------------------------+
| > In-progress, untouched 14d 9 | WORKLOAD (gated)                |
|   [open in Table ->]           | Kim     ########  9 open . 2 due|
|                                | Ana     ###.....  3 . 0         |
|                                | Unowned ######   31 open        |
+--------------------------------+---------------------------------+
```
Metrics: completions/week by subteam; due-this-week open (+ unowned count); stuck = `blocked` ∪ `needs_review` with time-in-status; stale = `in_progress` with no event for ≥ 14 d; on-time (windowed, per subteam); per-subteam open / done / stuck / on-time; workload = open + due-soon per owner, with Unowned as a first-class row.

### C — Season pacing
Milestone-centric: burndown of open tasks per upcoming milestone (`pm.task_milestones` exists, migration 20260602000000:317), per-subsystem % done against the milestone date, estimate-vs-actual accuracy, and a season-vs-last-season overlay by week-of-season. This is the page a chief engineer wants in February. But SDM26 is 110 tasks, also imported, and `actual_days` is sparsely filled, so today the overlay compares one real half-season against an artefact. Build it later, on real data.

```
+- Season ----------------------------------------------------------+
| MILESTONES  Design review <> Oct 3   open 61/140  #####...  -12   |
|             Chassis jig   <> Nov 14  open 22/38   ####....   -5   |
+- SUBSYSTEM vs milestone (heat strip: % done, red = behind pace) --+
+- SEASON OVERLAY  cum. done / week-of-season  SDM27 vs SDM26 ------+
+- ESTIMATE ACCURACY  actual/estimate scatter by subteam -----------+
```

## 3. Recommendation: B, with C's milestone diamonds on the week strip

Reasoning: the data window is 3.5 months with an import wall; every *flow* statistic (cycle time, burn-up, aging-by-creation) is contaminated, while every *state* question (what is due, what is stuck, who has too much) is answered exactly by data we already hold. B is also the only direction where the page has a verb: each list is a filtered link, so the natural next action is one click away. A leaves misleading numbers in place; C needs a second real season.

What each reader does differently: a team lead opens Stuck and Slipping and chases four people instead of scrolling the Board; a subteam lead sees their strip is red on stuck and clears reviews; a member sees their own row in Workload (own row always visible, others gated) and the Unowned pile they could pull from.

### Controls
- Subteam: `Select` (`components/ui/Select.tsx`), `size="sm"`, options `{ value: id, label: name, swatch: color }` plus `{ value: "", label: "All subteams" }`; `searchable` auto-enables past eight. Hidden inside `/team/[slug]` as now.
- Date presets and Team/Person: one shared `SegmentedControl` extracted from the Dim/Hide pill (`TaskFilterBar.tsx:199-229`) — `inline-flex rounded-md border border-helios-line bg-helios-base p-0.5`, active = `bg-helios-panel text-helios-text`. Add "This week" as the default preset.
- Custom dates: native date inputs on `filterInput`; reveal inline only when Custom is active (as now).
- Bar container: reuse the `FilterField` and bar-shell classes from `TaskFilterBar.tsx:60, 240-247`.

### Chart design rules (inline SVG only)
- **Measured, not scaled**: a `useMeasuredWidth` ResizeObserver hook; the SVG gets `width={w} height={h}` in px, text stays 10/11 px. (`BucketDonut` already sizes in px, `DashboardViewClient.tsx:800-847`.)
- **Colour**: subteam series = `subteam.color` keyed by *id* (fallback `#6B7280` like the chips, `TaskFilterBar.tsx:159`); status series = `STATUS_DOT` from `@helios/pm-ui`; tone = `helios-success/warn/danger/info` (tailwind.config:20-23); single-series bars = `asu-gold/70` as the dashboard histogram does. No private palette in the view — delete `FALLBACK_COLORS`.
- **Grid/axis**: three or four horizontal gridlines at `helios-line` 60 %, no vertical lines, solid baseline; y ticks right-aligned `tabular-nums text-[10px] text-helios-dim`; x labels on every Monday that fits (measure label width, skip evenly); the current week gets an `asu-gold/10` band; milestones as gold diamonds on the baseline, name on hover.
- **Typography**: numbers `font-mono tabular-nums` (JetBrains Mono is loaded); tile values `text-3xl font-semibold` like `MetricTile` (`:783-797`); panel titles keep the existing uppercase-tracking label.
- **Hover**: one `HoverTip` rendered with `createPortal` to `document.body` (pattern: `Select.tsx`; clamp like `TaskPeekCard.tsx:37-39`); a transparent full-height hit rect per week column; the tip lists series rows with swatches. Columns are focusable (`tabIndex`, `aria-label`) so keyboard users get the same tip.
- **States**: loading = panel-shaped `.helios-skeleton` blocks; empty = the `Empty` idiom (`DashboardViewClient.tsx:1197`) with a one-line reason ("No completions in this window"); error/unavailable as now.
- **Motion**: bar hover = opacity only, in `motion-safe:transition-opacity`; no entry animation.
- **Theme**: the PM root is dark-only (`pm.css:9 color-scheme: dark`); use tokens, never hex, so a light theme becomes a token swap.

### Shared primitives (`components/charts/`)
- `ChartFrame` — measured width, padding, gridlines, y ticks, x labels, this-week band, milestone markers; children receive `{ x, y, w, h }` scales.
- `StackedWeeks` — stacked columns per ISO week with per-series hover rows; used by the week strip and, single-series, by the tiles.
- `Sparkline` — 7–12 point mini area, no axes, last point dotted; 88×24 px inside KPI tiles.
- `BarStrip` — horizontal segmented bar (done / in progress / stuck / not started) with label and right-aligned numbers; replaces both div-bar panels and powers Subteams and Workload rows. Segments coloured by `STATUS_DOT`.
- `Delta` — `^6` / `v3` with tone and `vs previous {window}` in `text-helios-dim`.
- `HoverTip` — portal tooltip shared by all of the above.
- `KpiTile` — value, sub-line, `Delta`, `Sparkline`; the whole tile is a link.

### Drill-through
Build hrefs with `viewHref("table", teamSlug)` (`lib/nav.ts:74`) plus `filtersToParams` (`lib/filters.ts:70-82`). Slipping → `?status=not_started,in_progress,blocked,needs_review&to=<sunday>`; Stuck → `?status=blocked,needs_review`; a workload row → `?owner=<id>`; a subteam bar → `?team=<id>&mode=hide`. Table already parses all of these (`TableViewClient.tsx:172`).

## 4. Backlog

### MUST (one commit each)
1. Replace `<select>` with `Select` + swatches; date inputs onto `filterInput`. No metric change.
2. Extract `SegmentedControl` from the Dim/Hide pill; use it for presets and Team/Person; add "This week" as default.
3. `ChartFrame` + `useMeasuredWidth` + `HoverTip`; port Throughput onto it (gridlines, ticks, hover, this-week band). Delete `FALLBACK_COLORS`; colour by subteam id.
4. `KpiTile` + `Sparkline` + `Delta`; header row Completed / Due this week / Stuck / On-time. Metrics: `windowDeltas(rows, prevRows)` — needs a second RPC call for the previous window (same length, ending at `from`).
5. Attention lists (slipping, needs_review > 7 d, blocked, stale in-progress ≥ 14 d) with Table links. Metrics: `attentionLists(rows, tasks, now)`. **RPC: add `status_since timestamptz`** = max `activity.created_at` where `payload->>'to' = t.status`, else `t.updated_at`; and `task_updated_at`. Both on all three union branches.
6. Remove Burn-up and Cycle-time panels; keep on-time per subteam only. Trim `productivityMetrics.test.ts` to match.
7. `BarStrip`; Subteams panel (open / done / stuck / on-time, sorted stuck-desc) linking to `?team=`.

### SHOULD
8. Workload panel (gated) with Unowned as a row, sorted by open + due-soon, never by completions. **RPC: add `owner_ids uuid[]`** (`array_agg` from `pm.task_owners`, ungated — owners are public on the Board). Replace `PersonStat.open` semantics; drop "Open (created)". Always show the caller's own row.
9. Milestone diamonds on the week strip from `usePmStore(s => s.milestones)`; hover shows name and open count linked to it (needs `task_milestones` in the store or a `milestone_ids` RPC column).
10. Skeleton loading and `Empty` states per panel; keyboard-focusable week columns.
11. "Person" stacking in the week strip uses owners, not actors, once item 8 lands.

### Implemented 2026-09-14 — deviations from the text above
MUST 1–7 and SHOULD 8–11 shipped on `feat/pm-productivity`. Where the build
diverged from this proposal:
- **One wide RPC pull, not a second call** (item 4). The view fetches the union
  of the window, the previous window and the trailing 12 weeks once, then
  slices client-side (`sliceWindow`). Same numbers, one loading state.
- **"This week" compares against ALL of last week.** The same-length rule made
  Monday morning read "0 vs 0" (one day against one day). Other presets keep
  the same-length previous window. The delta label says which.
- **The Weeks strip always shows at least 8 columns**; weeks before the window
  are drawn faded and excluded from every number. A one-week window otherwise
  had a single bar.
- **Slipping is split into Overdue (77 in SDM27) and Due this week (19)** —
  one list would have buried this week's dates under two months of slippage.
  Overdue sorts most-recently-slipped first (the ones still worth chasing).
- **No open count on milestone diamonds** (item 9): `pm.task_milestones` has
  zero rows for SDM27 and SDM27e, so there is nothing to count. The diamond
  shows name, date and kind; the subtitle names the next milestone.
- **`may_see_actors` column added to the RPC** (beyond the two columns in
  items 5 and 8) so the gate is stated per row instead of inferred from
  whether any actor happened to be non-null in a quiet week.
- **Stale = untouched**, measured as `max(status_since, updated_at)`, not time
  in status alone: a task in progress for a month but edited yesterday is not
  stale.

### LATER
12. Estimate vs actual scatter per subteam (sparse today; gate on ≥ 20 pairs).
13. Season overlay by week-of-season (needs a clean second season).
14. Subsystem-vs-milestone heat strip (direction C).
15. Persist preset and subteam choice in local storage, as `useScrollMemory` does for scroll.
