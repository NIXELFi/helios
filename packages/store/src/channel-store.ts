import { RateGroup } from "./rate-group";
import { sliceRateGroup } from "./slice";
import type { ChannelMeta, ChannelSlice, TimeRange } from "./types";

export class ChannelStore {
  #metas = new Map<string, ChannelMeta>();
  #channelToGroup = new Map<string, string>();
  #groups = new Map<string, RateGroup>();
  /** source CSV header → channel id that owns that source column. Built
   *  alongside #channelToGroup so the override UI can address every column
   *  by its raw header text. Math channels (no source_header) are absent. */
  #bySourceHeader = new Map<string, string>();
  /** canonical id → source_header of the channel it is currently redirected
   *  to. Stored as source_header (not the target channel id) because the
   *  per-session settings the user sees and persists is "engine.aps is bound
   *  to `Throttle Pedal Pos`", which survives a re-load even if the resolver's
   *  default mapping changes. Empty when no override is active. */
  #overrides = new Map<string, string>();

  list(): ChannelMeta[] { return Array.from(this.#metas.values()); }
  get(id: string): ChannelMeta | undefined { return this.#metas.get(id); }
  groups(): RateGroup[] { return Array.from(this.#groups.values()); }

  addRateGroup(rg: RateGroup, metas: ChannelMeta[]): void {
    if (this.#groups.has(rg.id)) throw new Error(`duplicate rate group ${rg.id}`);
    this.#groups.set(rg.id, rg);
    for (const m of metas) {
      this.#metas.set(m.id, m);
      this.#channelToGroup.set(m.id, rg.id);
      if (m.source_header !== undefined && m.source_header !== "") {
        // First-write wins. The CSV loader's collision-protection path
        // already guarantees each canonical id has a unique source_header,
        // and within a single rate-group build we never double-add. Belt-
        // and-braces: keep the earliest writer so duplicate adds (in tests
        // or future code paths) don't silently rebind an existing entry.
        if (!this.#bySourceHeader.has(m.source_header)) {
          this.#bySourceHeader.set(m.source_header, m.id);
        }
      }
    }
  }

  /** Find which rate group a channel belongs to. Respects active overrides:
   *  asking for the canonical id returns the group of whatever channel that
   *  id currently redirects to. Widgets that look up the owning group for
   *  cross-rate resampling get the right one without knowing about overrides. */
  groupOf(channelId: string): RateGroup | undefined {
    const eff = this.effectiveChannelId(channelId);
    const id = this.#channelToGroup.get(eff);
    return id ? this.#groups.get(id) : undefined;
  }

  /** Add a derived channel to an existing rate group. The values array must
   *  match the group's `time` length. Used by math channels and other
   *  computed channels. Replacing an existing channel is allowed (overwrites
   *  the column + meta). */
  addChannel(groupId: string, meta: ChannelMeta, values: Float64Array): void {
    const rg = this.#groups.get(groupId);
    if (!rg) throw new Error(`unknown rate group ${groupId}`);
    if (values.length !== rg.time.length) {
      throw new Error(`channel ${meta.id}: ${values.length} values vs ${rg.time.length} samples`);
    }
    rg.columns.set(meta.id, values);
    this.#metas.set(meta.id, meta);
    this.#channelToGroup.set(meta.id, groupId);
    if (meta.source_header !== undefined && meta.source_header !== "") {
      if (!this.#bySourceHeader.has(meta.source_header)) {
        this.#bySourceHeader.set(meta.source_header, meta.id);
      }
    }
  }

  /** Remove a previously-added channel by id. No-op if unknown. Also clears
   *  any override that pointed at this channel's source_header. */
  removeChannel(channelId: string): void {
    const groupId = this.#channelToGroup.get(channelId);
    if (!groupId) return;
    const rg = this.#groups.get(groupId);
    rg?.columns.delete(channelId);
    const removed = this.#metas.get(channelId);
    if (removed?.source_header) {
      this.#bySourceHeader.delete(removed.source_header);
      // Any canonical override whose target source_header just vanished
      // gets cleared so reads don't silently fall back to its raw header.
      for (const [canonical, src] of this.#overrides) {
        if (src === removed.source_header) this.#overrides.delete(canonical);
      }
    }
    this.#metas.delete(channelId);
    this.#channelToGroup.delete(channelId);
  }

  /** ── Per-session channel overrides ──────────────────────────────────────
   *  Auto-resolution is right ~99% of the time. When a user hits the 1% case
   *  (a per-vehicle quirk that the resolver mis-routed) they pick a different
   *  source column for the canonical id. setChannelOverride accepts the
   *  *source_header* — the original CSV header text — so the override survives
   *  re-loads even if the resolver's default mapping shifts.
   */
  setChannelOverride(canonicalId: string, sourceHeader: string): void {
    const targetId = this.#bySourceHeader.get(sourceHeader);
    if (!targetId) {
      throw new Error(
        `cannot override ${canonicalId}: no channel has source_header "${sourceHeader}"`,
      );
    }
    this.#overrides.set(canonicalId, sourceHeader);
  }

  clearChannelOverride(canonicalId: string): void {
    this.#overrides.delete(canonicalId);
  }

  getChannelOverride(canonicalId: string): string | undefined {
    return this.#overrides.get(canonicalId);
  }

  /** Returns the channel id whose data should be read when callers request
   *  `canonicalId`. With no override, returns `canonicalId` itself. With an
   *  override, returns the id of the channel whose source_header the user
   *  picked. If the override points at a vanished source_header (e.g. saved
   *  state from a previous session that no longer has that column), falls
   *  back to the canonical id rather than throwing — keeps reads working
   *  with a stale override instead of breaking the whole widget. */
  effectiveChannelId(canonicalId: string): string {
    const src = this.#overrides.get(canonicalId);
    if (src === undefined) return canonicalId;
    return this.#bySourceHeader.get(src) ?? canonicalId;
  }

  /** Enumerate every source CSV header the store knows about, with the
   *  channel id that currently owns each one. Used by the Channel Inspector
   *  to build the override-picker dropdown. */
  listSourceHeaders(): { sourceHeader: string; channelId: string; displayName: string }[] {
    const out: { sourceHeader: string; channelId: string; displayName: string }[] = [];
    for (const [sourceHeader, channelId] of this.#bySourceHeader) {
      const meta = this.#metas.get(channelId);
      out.push({
        sourceHeader,
        channelId,
        displayName: meta?.display_name ?? channelId,
      });
    }
    out.sort((a, b) => a.sourceHeader.localeCompare(b.sourceHeader));
    return out;
  }

  /** Slice across rate groups; channels split by which group owns them.
   *  Each requested id is translated through `effectiveChannelId` to find
   *  the underlying data; the result is keyed by the *requested* id so
   *  callers ask for `engine.aps` and get data keyed as `engine.aps`
   *  regardless of any override. */
  slice(channels: string[], range: TimeRange): ChannelSlice {
    // Map requested id → effective id (for the actual data lookup) and the
    // reverse mapping (effective id → list of requested ids so we can fan
    // the same column out to multiple aliases if needed).
    const byGroup = new Map<string, { effectiveIds: string[]; requestedFor: Map<string, string[]> }>();
    for (const requested of channels) {
      const effective = this.effectiveChannelId(requested);
      const g = this.#channelToGroup.get(effective);
      if (!g) throw new Error(`unknown channel ${requested}`);
      let bucket = byGroup.get(g);
      if (!bucket) {
        bucket = { effectiveIds: [], requestedFor: new Map() };
        byGroup.set(g, bucket);
      }
      if (!bucket.requestedFor.has(effective)) {
        bucket.effectiveIds.push(effective);
        bucket.requestedFor.set(effective, []);
      }
      bucket.requestedFor.get(effective)!.push(requested);
    }
    let outTime: BigInt64Array | null = null;
    const outData = new Map<string, Float64Array>();
    for (const [groupId, { effectiveIds, requestedFor }] of byGroup) {
      const rg = this.#groups.get(groupId)!;
      const part = sliceRateGroup(rg, effectiveIds, range);
      if (outTime === null) outTime = part.time;
      for (const [effId, arr] of part.data) {
        for (const requested of requestedFor.get(effId) ?? [effId]) {
          outData.set(requested, arr);
        }
      }
    }
    return { time: outTime ?? new BigInt64Array(0), data: outData, range };
  }

  /** Range of [min t, max t] across all groups, in microseconds. */
  extentUs(): { startUs: number; endUs: number } {
    let s = Number.POSITIVE_INFINITY, e = Number.NEGATIVE_INFINITY;
    for (const g of this.#groups.values()) {
      if (g.time.length === 0) continue;
      s = Math.min(s, Number(g.time[0]!));
      e = Math.max(e, Number(g.time[g.time.length - 1]!));
    }
    if (!Number.isFinite(s)) return { startUs: 0, endUs: 0 };
    return { startUs: s, endUs: e };
  }
}
