import { RateGroup } from "./rate-group";
import { sliceRateGroup } from "./slice";
import type { ChannelMeta, ChannelSlice, TimeRange } from "./types";

export class ChannelStore {
  #metas = new Map<string, ChannelMeta>();
  #channelToGroup = new Map<string, string>();
  #groups = new Map<string, RateGroup>();

  list(): ChannelMeta[] { return Array.from(this.#metas.values()); }
  get(id: string): ChannelMeta | undefined { return this.#metas.get(id); }
  groups(): RateGroup[] { return Array.from(this.#groups.values()); }

  addRateGroup(rg: RateGroup, metas: ChannelMeta[]): void {
    if (this.#groups.has(rg.id)) throw new Error(`duplicate rate group ${rg.id}`);
    this.#groups.set(rg.id, rg);
    for (const m of metas) {
      this.#metas.set(m.id, m);
      this.#channelToGroup.set(m.id, rg.id);
    }
  }

  /** Slice across rate groups; channels split by which group owns them. */
  slice(channels: string[], range: TimeRange): ChannelSlice {
    const byGroup = new Map<string, string[]>();
    for (const id of channels) {
      const g = this.#channelToGroup.get(id);
      if (!g) throw new Error(`unknown channel ${id}`);
      const list = byGroup.get(g) ?? [];
      list.push(id);
      byGroup.set(g, list);
    }
    let outTime: BigInt64Array | null = null;
    const outData = new Map<string, Float64Array>();
    for (const [groupId, ids] of byGroup) {
      const rg = this.#groups.get(groupId)!;
      const part = sliceRateGroup(rg, ids, range);
      if (outTime === null) outTime = part.time;
      for (const [id, arr] of part.data) outData.set(id, arr);
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
