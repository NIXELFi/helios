// Read-only Google Calendar event layer for the PM calendar (#gcal).
//
// The `pm.gcal_events` table is populated + auto-synced server-side every 6h
// (do not write to it from the client). RLS already allows authenticated
// SELECT, so this hook just reads the rows the calendar needs and buckets them
// by the SAME `yyyy-MM-dd` local date-key the calendar grid uses, so the day
// cells can render them alongside the existing task/event chips.

import { useEffect, useMemo, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import { format } from "date-fns";

// Raw row shape we select from pm.gcal_events.
interface GcalRow {
  uid: string;
  title: string | null;
  location: string | null;
  description: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean | null;
  is_recurring: boolean | null;
}

// The small client-facing shape the calendar renders from.
export interface GcalEvent {
  uid: string;
  title: string;
  location: string | null;
  description: string | null;
  startsAt: Date;
  endsAt: Date | null;
  allDay: boolean;
  isRecurring: boolean;
}

export interface UseGcalEventsResult {
  loading: boolean;
  error: string | null;
  events: GcalEvent[];
  // Bucketed by local `yyyy-MM-dd` date-key (derived from startsAt), matching
  // the calendar grid's key format. Multi-day all-day events are keyed only on
  // their start day (kept intentionally simple).
  byDate: Map<string, GcalEvent[]>;
}

const EMPTY_EVENTS: GcalEvent[] = [];
const EMPTY_BY_DATE = new Map<string, GcalEvent[]>();

export function useGcalEvents(): UseGcalEventsResult {
  const client = useSupabaseClient();
  const [events, setEvents] = useState<GcalEvent[]>(EMPTY_EVENTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await client
          .schema("pm")
          .from("gcal_events")
          .select("uid,title,location,description,starts_at,ends_at,all_day,is_recurring")
          .order("starts_at");
        if (!active) return;
        if (res.error) {
          setError(res.error.message);
          setEvents(EMPTY_EVENTS);
          return;
        }
        const rows = (res.data ?? []) as GcalRow[];
        const mapped: GcalEvent[] = [];
        for (const r of rows) {
          const startsAt = new Date(r.starts_at);
          // Skip rows with an unparseable start so the layer never crashes the grid.
          if (Number.isNaN(startsAt.getTime())) continue;
          const ends = r.ends_at ? new Date(r.ends_at) : null;
          mapped.push({
            uid: r.uid,
            title: r.title ?? "(untitled)",
            location: r.location ?? null,
            description: r.description ?? null,
            startsAt,
            endsAt: ends && !Number.isNaN(ends.getTime()) ? ends : null,
            allDay: Boolean(r.all_day),
            isRecurring: Boolean(r.is_recurring),
          });
        }
        setEvents(mapped);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
        setEvents(EMPTY_EVENTS);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const byDate = useMemo(() => {
    if (events.length === 0) return EMPTY_BY_DATE;
    const m = new Map<string, GcalEvent[]>();
    for (const ev of events) {
      // Derive the day from startsAt in LOCAL time, matching the calendar grid's
      // `format(day, "yyyy-MM-dd")` cell keys.
      const key = format(ev.startsAt, "yyyy-MM-dd");
      const arr = m.get(key) ?? [];
      arr.push(ev);
      m.set(key, arr);
    }
    return m;
  }, [events]);

  return { loading, error, events, byDate };
}
