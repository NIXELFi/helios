import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconChartLine, IconChevronDown, IconChevronRight, IconCloud, IconFilterOff, IconListDetails, IconLoader2,
  IconMovie, IconSearch, IconRobot,
} from "@tabler/icons-react";
import { EmptyState } from "../../../components/EmptyState";
import {
  TRACKS, bestLapWentOffCourse, fmtTime, fmtWhen, hasTelemetry, isRankable, runBest, runTheoretical, trackName,
  unrankedReason, unrankedShort, type SimRun,
} from "../api";
import { bestPerCourse } from "../lib/leaderboard";
import { InfoPopover, SharingPolicy } from "./InfoPopover";
import { isPending, type Pending } from "./pending";

type SortKey = "when" | "best" | "driver" | "track";

/**
 * How the table was left, kept between mounts.
 *
 * `SimHome` renders one tab at a time, so visiting the Leaderboard unmounts
 * this and coming back used to reset the search, the filters and every day
 * you had opened -- which went from a mild annoyance to a real one when days
 * started closed. Module scope rather than `localStorage` on purpose: this is
 * where you were a moment ago, not a preference, and a filter that survived a
 * restart would be a filter nobody remembers switching on.
 */
const view: {
  query: string;
  track: string;
  sort: SortKey;
  rankedOnly: boolean;
  mineOnly: boolean;
  opened: Set<string>;
  /** The newest day already opened on the viewer's behalf. See `autoOpen`. */
  autoOpened: string | null;
} = { query: "", track: "all", sort: "when", rankedOnly: false, mineOnly: false, opened: new Set(), autoOpened: null };

/** Forget it. Exported for the tests, which must not inherit each other's view. */
export function resetRunsView(): void {
  view.query = "";
  view.track = "all";
  view.sort = "when";
  view.rankedOnly = false;
  view.mineOnly = false;
  view.opened = new Set();
  view.autoOpened = null;
}

interface Props {
  runs: SimRun[];
  selectedId: string | null;
  onSelect: (run: SimRun) => void;
  onReplay: (run: SimRun) => void;
  onOpenInLogs: (run: SimRun) => void;
  canReplay: boolean;
  /** The signed-in account, so "just mine" can mean something. Null when
   *  signed out, which hides that filter rather than showing an empty one. */
  driverId?: string | null;
  /** A button waiting on a download, so it can say so. */
  pending?: Pending | null;
}

/**
 * A run's day, as a sortable key and as something to put on a header row.
 *
 * Local time on purpose: a session that ran past midnight UTC is still one
 * evening's driving to the person who drove it.
 */
function dayOf(run: SimRun): { key: string; label: string } {
  const t = run.startedAt ? new Date(run.startedAt) : null;
  if (!t || Number.isNaN(t.getTime())) return { key: "unknown", label: "Undated" };
  const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  const today = new Date();
  const isToday = t.toDateString() === today.toDateString();
  const yday = new Date(today);
  yday.setDate(today.getDate() - 1);
  const label = isToday
    ? "Today"
    : t.toDateString() === yday.toDateString()
      ? "Yesterday"
      : t.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  return { key, label };
}

export function RunsTable({
  runs, selectedId, onSelect, onReplay, onOpenInLogs, canReplay, driverId, pending = null,
}: Props) {
  const [query, setQuery] = useState(view.query);
  const [track, setTrack] = useState<string>(view.track);
  const [sort, setSort] = useState<SortKey>(view.sort);
  const [rankedOnly, setRankedOnly] = useState(view.rankedOnly);
  const [mineOnly, setMineOnly] = useState(view.mineOnly);
  /** Days the user has opened. Every day starts rolled up -- see `groups`. */
  const [opened, setOpened] = useState<Set<string>>(() => new Set(view.opened));

  // Signing out takes the "Just mine" control away with it, so the filter has
  // to go too: leaving it set means a table that is silently filtered by a
  // checkbox that is no longer on screen.
  useEffect(() => {
    if (!driverId && mineOnly) setMineOnly(false);
  }, [driverId, mineOnly]);

  // Write it back on every change, so the next mount picks up where this left
  // off. See `view`.
  useEffect(() => {
    view.query = query;
    view.track = track;
    view.sort = sort;
    view.rankedOnly = rankedOnly;
    view.mineOnly = mineOnly;
    view.opened = opened;
  }, [query, track, sort, rankedOnly, mineOnly, opened]);

  // The courses on offer are the fixed three and then whatever else the
  // archive holds -- a generated course exists only once somebody has driven
  // it, so the list has to come from the runs.
  const courses = useMemo(() => {
    const out: { id: string; name: string }[] = TRACKS.map((t) => ({ id: t.id, name: t.name }));
    const seen = new Set(out.map((c) => c.id));
    for (const r of runs) {
      if (seen.has(r.track)) continue;
      seen.add(r.track);
      out.push({ id: r.track, name: trackName(r.track) });
    }
    return out;
  }, [runs]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = runs.filter((r) => {
      if (track !== "all" && r.track !== track) return false;
      if (rankedOnly && !isRankable(r)) return false;
      if (mineOnly && driverId && r.driverId !== driverId) return false;
      if (!q) return true;
      return (
        r.driver.toLowerCase().includes(q) ||
        r.trackName.toLowerCase().includes(q) ||
        (r.session ?? "").toLowerCase().includes(q)
      );
    });
    list = [...list];
    switch (sort) {
      case "best":
        // Runs with no lap sink to the bottom rather than sorting as zero.
        list.sort((a, b) => (runBest(a) ?? Infinity) - (runBest(b) ?? Infinity));
        break;
      case "driver":
        list.sort((a, b) => a.driver.localeCompare(b.driver) || (runBest(a) ?? Infinity) - (runBest(b) ?? Infinity));
        break;
      case "track":
        list.sort((a, b) => a.trackName.localeCompare(b.trackName) || (runBest(a) ?? Infinity) - (runBest(b) ?? Infinity));
        break;
      default:
        list.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
    }
    return list;
  }, [runs, query, track, sort, rankedOnly, mineOnly, driverId]);

  /**
   * Runs by day, newest first.
   *
   * A season is hundreds of rows and a flat list of them is unreadable —
   * scrolling past last month to find this afternoon is not browsing, it is
   * searching by hand. Grouped by day, the same archive is a couple of dozen
   * headers, all rolled up, and you open the day you came for.
   *
   * Only when sorted by time: "quickest first" is a ranking, and chopping a
   * ranking into days destroys the only thing it was for.
   */
  const groups = useMemo(() => {
    if (sort !== "when") return null;
    const out: { key: string; label: string; runs: SimRun[] }[] = [];
    for (const r of shown) {
      const d = dayOf(r);
      const last = out[out.length - 1];
      if (last && last.key === d.key) last.runs.push(r);
      else out.push({ key: d.key, label: d.label, runs: [r] });
    }
    return out;
  }, [shown, sort]);

  /**
   * Days start closed -- except the newest one, when some of it is yours.
   *
   * This table is the whole team's archive, so on a shared machine the newest
   * day is somebody else's session as often as it is yours, and opening it
   * for everyone spends the top of the page on rows nobody asked for. But a
   * driver who has just driven comes here to see THOSE runs, and making them
   * click a header first is a click every single time. So the newest day
   * opens itself when it holds a run of the signed-in driver's, once: close
   * it and it stays closed, and only a newer day of yours opens by itself.
   */
  const newest = groups?.[0];
  const autoOpen = !!newest && !!driverId && view.autoOpened !== newest.key
    && newest.runs.some((r) => r.driverId === driverId);
  useEffect(() => {
    if (!autoOpen || !newest) return;
    view.autoOpened = newest.key;
    setOpened((prev) => (prev.has(newest.key) ? prev : new Set(prev).add(newest.key)));
  }, [autoOpen, newest]);

  const isOpen = (key: string) => opened.has(key);

  const toggleDay = (key: string) => {
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /**
   * A run picked somewhere else has to be visible when you land here.
   *
   * The end-of-session summary sets `selectedId` and switches to this tab,
   * and with days rolled up by default the row it selected may be inside a
   * closed one: you click your best lap and arrive at a table where nothing
   * is highlighted. Open its day and scroll to it.
   */
  const selectedRow = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (!selectedId) return;
    const run = runs.find((r) => r.runId === selectedId);
    if (!run) return;
    const key = dayOf(run).key;
    setOpened((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, [selectedId, runs]);
  useEffect(() => {
    // After the row exists, which is the render the line above causes.
    // Optional-called: jsdom has no scrollIntoView, and neither does an older
    // webview -- neither is a reason to throw out of an effect.
    selectedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId, opened]);

  const allOpen = !!groups?.length && groups.every((g) => opened.has(g.key));

  const toggleAll = () => {
    if (!groups) return;
    // Per visible group rather than wholesale: "Collapse all" with a filter on
    // should close what you can see, not silently forget the days the filter
    // is hiding.
    setOpened((prev) => {
      const next = new Set(prev);
      for (const g of groups) {
        if (allOpen) next.delete(g.key);
        else next.add(g.key);
      }
      return next;
    });
  };

  /** One run's row. Shared by the grouped and the flat renderings. */
  const renderRow = (r: SimRun) => {
    const reason = unrankedReason(r);
    const short = unrankedShort(r);
    const best = runBest(r);
    const wentOff = best == null && bestLapWentOffCourse(r);
    const selected = r.runId === selectedId;
    const busy = isPending(pending, r.runId);
    return (
      <tr
        key={r.runId}
        ref={selected ? selectedRow : undefined}
        tabIndex={0}
        aria-selected={selected}
        aria-label={`${r.driver}, ${r.trackName}, ${best != null ? fmtTime(best) : wentOff ? "off course" : "no time"}${short ? `, not ranked: ${short}` : ""}`}
        className={
          "cursor-pointer border-b border-helios-line/60 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-asu-gold " +
          (selected ? "bg-asu-gold/10" : "hover:bg-helios-line/25")
        }
        onClick={() => onSelect(r)}
        onKeyDown={(e) => {
          // Enter opens the run, as a click does. Only when the row itself has
          // focus: Enter on one of its buttons belongs to the button.
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          onSelect(r);
        }}
      >
        <Td>
          <span className="flex items-center gap-1.5">
            {r.synthetic && (
              <IconRobot size={13} className="shrink-0 text-helios-muted" title="Robot driver" />
            )}
            <span className="font-medium">{r.driver}</span>
            {r.remote && (
              <IconCloud
                size={12}
                className="shrink-0 text-helios-muted"
                title="Shared by the team; not on this machine"
              />
            )}
          </span>
          {r.session && (
            <span className="block truncate text-[11px] text-helios-muted">{r.session}</span>
          )}
        </Td>
        <Td>{r.trackName}</Td>
        <Td className="text-right font-mono">
          <span className="inline-flex items-center justify-end gap-1.5">
            {/* A lap thrown out for leaving the course says so, in the same
                words as everywhere else, instead of a dash and an asterisk. */}
            {wentOff ? (
              <span className="font-sans text-[11px] text-helios-warn" title={reason ?? undefined}>off course</span>
            ) : (
              <span className={reason ? "text-helios-dim" : "text-asu-gold"}>{fmtTime(best)}</span>
            )}
            {short && !wentOff && (
              // Visible, not hover-only: why a time is not on the board is the
              // first question anybody has about it.
              <span
                className="whitespace-nowrap rounded bg-helios-line/70 px-1 py-px font-sans text-[10px] text-helios-dim"
                title={reason ? `Not ranked: ${reason}` : undefined}
                data-testid="unranked-chip"
              >
                {short}
              </span>
            )}
          </span>
        </Td>
        <Td className="text-right font-mono text-helios-dim">
          {fmtTime(runTheoretical(r))}
        </Td>
        <Td className="text-right font-mono">{r.stats.laps}</Td>
        <Td className="text-right font-mono">
          <span className={r.stats.totalCones ? "text-helios-warn" : "text-helios-muted"}>
            {r.stats.totalCones}
          </span>
        </Td>
        <Td className="text-right font-mono text-helios-dim">
          {r.stats.peakLatG ? `${r.stats.peakLatG.toFixed(2)} g` : "—"}
        </Td>
        <Td className="whitespace-nowrap text-helios-dim">{fmtWhen(r.startedAt)}</Td>
        <Td className="text-right">
          <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {/* A shared run has no files here yet. It can still be opened --
                clicking fetches it first -- but only if the driver shared the
                lap and not just its time, which is the usual case for
                anything that was not a personal best. */}
            <IconBtn
              title={
                !canReplay
                  ? "The simulator is not installed here"
                  : !hasTelemetry(r)
                    ? `${r.driver} shared this run's time, not the lap itself`
                    : r.remote
                      ? `Fetch ${r.driver}'s lap and watch it`
                      : "Watch the replay"
              }
              disabled={!canReplay || !hasTelemetry(r) || busy}
              busy={isPending(pending, r.runId, "replay")}
              onClick={() => onReplay(r)}
            >
              <IconMovie size={14} />
            </IconBtn>
            {/* A run whose telemetry never landed -- a rig that lost
                power between the two writes -- has a path and zero
                bytes. Offering it throws the whole app across to
                Logs, fails there, and leaves the user in a
                different module with an error and no way back to
                what they were looking at. */}
            <IconBtn
              title={
                hasTelemetry(r)
                  ? r.remote
                    ? `Fetch ${r.driver}'s lap and open its best lap in Logs`
                    : "Open the best lap in Logs"
                  : "This run has no telemetry file"
              }
              disabled={!hasTelemetry(r) || busy}
              busy={isPending(pending, r.runId, "logs")}
              onClick={() => onOpenInLogs(r)}
            >
              <IconChartLine size={14} />
            </IconBtn>
          </span>
        </Td>
      </tr>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-helios-line px-3 py-2">
        <div className="relative">
          <IconSearch size={14} className="pointer-events-none absolute left-2.5 top-2 text-helios-muted" />
          <input
            className="w-56 rounded border border-helios-line bg-helios-deep py-1.5 pl-8 pr-2 text-xs outline-none transition focus:border-asu-gold"
            placeholder="Driver, course, session…"
            aria-label="Search runs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          className="rounded border border-helios-line bg-helios-deep px-2 py-1.5 text-xs outline-none focus:border-asu-gold"
          aria-label="Course"
          value={track}
          onChange={(e) => setTrack(e.target.value)}
        >
          <option value="all">Every course</option>
          {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          className="rounded border border-helios-line bg-helios-deep px-2 py-1.5 text-xs outline-none focus:border-asu-gold"
          aria-label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
        >
          <option value="when">Newest first</option>
          <option value="best">Quickest first</option>
          <option value="driver">By driver</option>
          <option value="track">By course</option>
        </select>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-helios-dim">
          <input
            type="checkbox"
            className="accent-asu-gold"
            checked={rankedOnly}
            onChange={(e) => setRankedOnly(e.target.checked)}
          />
          Ranked only
        </label>
        {driverId && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-helios-dim">
            <input
              type="checkbox"
              className="accent-asu-gold"
              checked={mineOnly}
              onChange={(e) => setMineOnly(e.target.checked)}
            />
            Just mine
          </label>
        )}
        {/* Shown for one day as well as many: with days rolled up by
            default, a single-session archive would otherwise offer no way to
            open it but clicking the header, which nothing says is clickable. */}
        {groups && groups.length > 0 && (
          <button
            className="rounded border border-helios-line px-2 py-1 text-[11px] text-helios-dim transition hover:border-asu-gold hover:text-helios-text"
            onClick={toggleAll}
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs text-helios-muted">
          <InfoPopover label="What gets shared" align="right"><SharingPolicy /></InfoPopover>
          {shown.length} of {runs.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {shown.length === 0 ? (
          runs.length === 0 ? (
            <EmptyState
              Icon={IconListDetails}
              title="No runs recorded yet"
              hint="Launch the simulator and drive a lap; the run files itself here."
            />
          ) : (
            <EmptyState Icon={IconFilterOff} title="Nothing matches that filter" />
          )
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-helios-strip">
              <tr className="border-b border-helios-line text-left text-helios-dim">
                <Th>Driver</Th>
                <Th>Course</Th>
                <Th className="text-right">Best lap</Th>
                <Th className="text-right">Theoretical</Th>
                <Th className="text-right">Laps</Th>
                <Th className="text-right">Cones</Th>
                <Th className="text-right">Peak lat</Th>
                <Th>When</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            {groups ? (
              groups.map((g) => {
                const open = isOpen(g.key);
                const bests = bestPerCourse(g.runs);
                const laps = g.runs.reduce((a, r) => a + (r.stats.laps ?? 0), 0);
                return (
                  <tbody key={g.key}>
                    {/* A real control, not a clickable row: it is the way to
                        reach a run, so it has to be reachable from a keyboard
                        and has to say whether it is open. */}
                    <tr
                      className="cursor-pointer border-b border-helios-line bg-helios-strip/70 transition hover:bg-helios-line/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold"
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      onClick={() => toggleDay(g.key)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        toggleDay(g.key);
                      }}
                    >
                      <td colSpan={9} className="px-3 py-1.5">
                        <div className="flex items-center gap-2 text-[11px]">
                          {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                          <span className="font-semibold">{g.label}</span>
                          <span className="text-helios-muted">
                            {g.runs.length} run{g.runs.length === 1 ? "" : "s"}
                            {laps ? ` · ${laps} lap${laps === 1 ? "" : "s"}` : ""}
                          </span>
                          {/* Best per course. One minimum across courses put a
                              single 4.352 accel run above forty autocross laps
                              as "the day's best". */}
                          {bests.length > 0 && (
                            <span className="ml-auto truncate font-mono" data-testid="day-bests">
                              {bests.map((c, i) => (
                                <span key={c.track}>
                                  {i > 0 && <span className="text-helios-muted"> · </span>}
                                  <span className="font-sans text-helios-muted">{c.short}</span>{" "}
                                  <span className="text-asu-gold">{fmtTime(c.best)}</span>
                                </span>
                              ))}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open && g.runs.map(renderRow)}
                  </tbody>
                );
              })
            ) : (
              <tbody>{shown.map(renderRow)}</tbody>
            )}
          </table>
        )}
      </div>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={"px-3 py-2 font-medium " + className}>{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={"max-w-[220px] truncate px-3 py-2 " + className}>{children}</td>;
}

function IconBtn({
  children, title, onClick, disabled, busy,
}: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      title={busy ? "Working…" : title}
      aria-label={title}
      aria-busy={busy || undefined}
      // The working button stays at full strength with its spinner; its
      // neighbours for the same run are disabled until it is done.
      disabled={disabled && !busy}
      onClick={() => { if (!busy) onClick(); }}
      className="rounded border border-helios-line p-1 text-helios-dim transition hover:border-asu-gold hover:text-helios-text disabled:cursor-not-allowed disabled:opacity-30"
    >
      {busy ? <IconLoader2 size={14} className="animate-spin text-asu-gold" /> : children}
    </button>
  );
}
