// Pure diff engine — produces a flat list of entries comparing two
// configs. Walks the SDM26 schema for scalar fields plus the known
// array fields (intake_pipes, exhaust_primaries, exhaust_secondaries,
// exhaust_collector). Used by ConfigDiffModal; no React in here.

import { deepEqual } from "../lib/deep-equal";
import { getAt } from "../lib/path-helpers";
import {
  SDM26_SCHEMA,
  VALVE_FIELDS,
  PIPE_FIELDS,
  type FieldMeta,
} from "../../lib/sdm26Schema";

export type DiffKind = "same" | "changed" | "added" | "removed";

export interface DiffEntry {
  group: string;
  key: string;       // dot-path
  label: string;
  unit?: string;
  formatted: { left: string; right: string };
  raw: { left: unknown; right: unknown };
  kind: DiffKind;
}

function classify(left: unknown, right: unknown): DiffKind {
  const lEmpty = left == null;
  const rEmpty = right == null;
  if (lEmpty && rEmpty) return "same";
  if (lEmpty) return "added";
  if (rEmpty) return "removed";
  return deepEqual(left, right) ? "same" : "changed";
}

function formatValue(meta: FieldMeta, value: unknown): string {
  if (value == null) return "—";
  if (meta.format) return meta.format(value);
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function diffScalar(meta: FieldMeta, left: unknown, right: unknown): DiffEntry {
  return {
    group: meta.group,
    key: meta.key,
    label: meta.label,
    unit: meta.unit,
    formatted: { left: formatValue(meta, left), right: formatValue(meta, right) },
    raw: { left, right },
    kind: classify(left, right),
  };
}

function diffPipeArrays(
  group: string,
  pipesKey: string,
  left: unknown,
  right: unknown,
): DiffEntry[] {
  const leftArr = (Array.isArray(left) ? left : []) as Array<Record<string, unknown>>;
  const rightArr = (Array.isArray(right) ? right : []) as Array<Record<string, unknown>>;
  const maxLen = Math.max(leftArr.length, rightArr.length);
  const out: DiffEntry[] = [];
  // Header row for the pipe count.
  out.push({
    group,
    key: `${pipesKey}.length`,
    label: `${pipesKey} count`,
    formatted: { left: String(leftArr.length), right: String(rightArr.length) },
    raw: { left: leftArr.length, right: rightArr.length },
    kind: leftArr.length === rightArr.length ? "same" : "changed",
  });
  for (let i = 0; i < maxLen; i++) {
    const l = leftArr[i];
    const r = rightArr[i];
    for (const sub of PIPE_FIELDS) {
      const fullKey = `${pipesKey}[${i + 1}].${sub.key}`;
      const lv = l ? l[sub.key] : undefined;
      const rv = r ? r[sub.key] : undefined;
      out.push({
        group,
        key: fullKey,
        label: `#${i + 1} ${sub.label}`,
        unit: sub.unit,
        formatted: { left: formatValue(sub, lv), right: formatValue(sub, rv) },
        raw: { left: lv, right: rv },
        kind: classify(lv, rv),
      });
    }
  }
  return out;
}

function diffValve(
  valveKey: "intake_valve" | "exhaust_valve",
  left: unknown,
  right: unknown,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  const lv = (left ?? {}) as Record<string, unknown>;
  const rv = (right ?? {}) as Record<string, unknown>;
  for (const sub of VALVE_FIELDS) {
    out.push({
      group: valveKey === "intake_valve" ? "Intake valve" : "Exhaust valve",
      key: `${valveKey}.${sub.key}`,
      label: sub.label,
      unit: sub.unit,
      formatted: { left: formatValue(sub, lv[sub.key]), right: formatValue(sub, rv[sub.key]) },
      raw: { left: lv[sub.key], right: rv[sub.key] },
      kind: classify(lv[sub.key], rv[sub.key]),
    });
  }
  const lCd = lv.cd_table;
  const rCd = rv.cd_table;
  out.push({
    group: valveKey === "intake_valve" ? "Intake valve" : "Exhaust valve",
    key: `${valveKey}.cd_table`,
    label: "Cd table",
    formatted: {
      left: Array.isArray(lCd) ? `${(lCd as unknown[]).length} rows` : "—",
      right: Array.isArray(rCd) ? `${(rCd as unknown[]).length} rows` : "—",
    },
    raw: { left: lCd, right: rCd },
    kind: classify(lCd, rCd),
  });
  return out;
}

/// Compare two raw V1 SDM JSON configs. Returns a flat list of
/// DiffEntry objects in schema-group order, suitable for rendering
/// section-by-section.
export function diffConfigs(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const m of SDM26_SCHEMA) {
    if (m.key.startsWith("__")) continue; // synthetic
    out.push(diffScalar(m, getAt(left, m.key), getAt(right, m.key)));
  }
  out.push(...diffValve("intake_valve", left.intake_valve, right.intake_valve));
  out.push(...diffValve("exhaust_valve", left.exhaust_valve, right.exhaust_valve));
  out.push(...diffPipeArrays("Intake runners", "intake_pipes", left.intake_pipes, right.intake_pipes));
  out.push(...diffPipeArrays("Exhaust primaries", "exhaust_primaries", left.exhaust_primaries, right.exhaust_primaries));
  out.push(...diffPipeArrays("Exhaust secondaries", "exhaust_secondaries", left.exhaust_secondaries, right.exhaust_secondaries));
  return out;
}

/// Group diff entries by `group` while preserving the schema order.
export function groupDiff(entries: ReadonlyArray<DiffEntry>): Array<{ group: string; entries: DiffEntry[] }> {
  const out: Array<{ group: string; entries: DiffEntry[] }> = [];
  for (const e of entries) {
    let bucket = out.find((b) => b.group === e.group);
    if (!bucket) {
      bucket = { group: e.group, entries: [] };
      out.push(bucket);
    }
    bucket.entries.push(e);
  }
  return out;
}
