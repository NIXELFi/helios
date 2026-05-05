export interface RateGroupInit {
  id: string;
  nominalRateHz: number;
  time: BigInt64Array;
  columns: Map<string, Float64Array>;
}

export class RateGroup {
  readonly id: string;
  readonly nominalRateHz: number;
  readonly time: BigInt64Array;
  readonly columns: Map<string, Float64Array>;

  private constructor(init: RateGroupInit) {
    this.id = init.id;
    this.nominalRateHz = init.nominalRateHz;
    this.time = init.time;
    this.columns = init.columns;
    for (const [id, col] of this.columns) {
      if (col.length !== this.time.length) {
        throw new Error(`column ${id} length mismatch`);
      }
    }
  }

  static fromColumns(init: RateGroupInit): RateGroup { return new RateGroup(init); }

  has(channelId: string): boolean { return this.columns.has(channelId); }

  channelIds(): string[] { return Array.from(this.columns.keys()); }

  data(channelId: string): Float64Array {
    const col = this.columns.get(channelId);
    if (!col) throw new Error(`unknown channel ${channelId}`);
    return col;
  }
}
