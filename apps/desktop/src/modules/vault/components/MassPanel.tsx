// Vehicle mass / weight-budget dashboard panel for the Insights screen.
// Renders: total vehicle mass KPI + delta vs target, heaviest parts (HBars),
// and mass by subsystem (HBars).
//
// Target mass is persisted in localStorage keyed by vault id (v1).
// TODO: for a shared per-vault target (visible to all members), add a
//       `target_mass_grams` column to pdm.vaults and expose it via the vault
//       settings admin panel. The localStorage fallback is intentional for v1.

import { useEffect, useMemo, useState } from "react";
import { ChartCard, StatCard, EmptyChart } from "./charts/ChartCard";
import { HBars } from "./charts/HBars";
import { aggregateMass, formatMass } from "../lib/massStats";
import type { FileMassRecord } from "../data/useVaultMass";
import type { Folder } from "../data/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk a file's folder chain to the top-level folder name.
 *  Mirrors the logic in vaultStats.ts topAreaOf() but uses pre-built folder map. */
function topAreaOf(folderId: string | null, byId: Map<string, Folder>): string {
  if (!folderId) return "(root)";
  let cur = byId.get(folderId);
  if (!cur) return "(unknown)";
  const seen = new Set<string>();
  while (cur.parent_id && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = byId.get(cur.parent_id);
    if (!parent) break;
    cur = parent;
  }
  return cur.name;
}

const STORAGE_KEY = (vaultId: string) => `helios.mass-target.${vaultId}`;

function loadTargetGrams(vaultId: string): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(vaultId));
    if (!raw) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function saveTargetGrams(vaultId: string, grams: number | null) {
  try {
    if (grams === null) {
      localStorage.removeItem(STORAGE_KEY(vaultId));
    } else {
      localStorage.setItem(STORAGE_KEY(vaultId), String(grams));
    }
  } catch {
    // localStorage unavailable (e.g. private browsing with quota 0) — silently ignore
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MassPanel({
  vaultId,
  massRows,
  folders,
  loading,
}: {
  vaultId: string;
  massRows: FileMassRecord[] | null;
  folders: Folder[];
  loading: boolean;
}) {
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState("");
  const [targetGrams, setTargetGrams] = useState<number | null>(() =>
    loadTargetGrams(vaultId),
  );

  // Reload the target from localStorage whenever the active vault changes so
  // the previous vault's target (and its budget delta) is never shown for a
  // different vault.
  useEffect(() => {
    setTargetGrams(loadTargetGrams(vaultId));
    setEditingTarget(false);
    setTargetInput("");
  }, [vaultId]);

  // Build folder id → top-level folder name map (walk hierarchy once)
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const folderNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of folders) {
      m.set(f.id, topAreaOf(f.id, folderById));
    }
    return m;
  }, [folders, folderById]);

  const agg = useMemo(() => {
    if (!massRows) return null;
    return aggregateMass(massRows, folderNames);
  }, [massRows, folderNames]);

  // ── Loading / empty guards ──────────────────────────────────────────────
  if (loading && !agg) {
    return (
      <div className="border border-helios-line bg-helios-panel px-4 py-3 text-xs text-helios-dim">
        Loading mass data…
      </div>
    );
  }

  const noData = !agg || agg.withMassCount === 0;

  // ── Target editing helpers ──────────────────────────────────────────────
  function commitTarget() {
    const rawKg = parseFloat(targetInput.replace(/,/g, ""));
    if (Number.isFinite(rawKg) && rawKg > 0) {
      const grams = rawKg * 1000; // input is in kg
      setTargetGrams(grams);
      saveTargetGrams(vaultId, grams);
    } else if (targetInput.trim() === "") {
      setTargetGrams(null);
      saveTargetGrams(vaultId, null);
    }
    setEditingTarget(false);
    setTargetInput("");
  }

  function startEditing() {
    setTargetInput(targetGrams !== null ? String((targetGrams / 1000).toFixed(2)) : "");
    setEditingTarget(true);
  }

  // ── Delta calculation ──────────────────────────────────────────────────
  const deltaGrams =
    agg && targetGrams !== null ? agg.totalGrams - targetGrams : null;
  const overBudget = deltaGrams !== null && deltaGrams > 0;

  // ── Target button / badge ─────────────────────────────────────────────
  const targetBadge = editingTarget ? (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        commitTarget();
      }}
    >
      <input
        autoFocus
        type="text"
        value={targetInput}
        onChange={(e) => setTargetInput(e.target.value)}
        onBlur={commitTarget}
        placeholder="e.g. 230"
        className="w-24 bg-helios-base px-2 py-0.5 text-[11px] text-helios-text border border-helios-line focus:border-asu-gold focus:outline-none"
        aria-label="Target mass in kg"
      />
      <span className="text-[10px] text-helios-dim">kg</span>
    </form>
  ) : (
    <button
      onClick={startEditing}
      className="text-[10px] text-helios-dim hover:text-asu-gold"
      title="Set weight-budget target"
    >
      {targetGrams !== null ? `target ${formatMass(targetGrams)}` : "set target"}
    </button>
  );

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      {/* Section header */}
      <div className="flex items-center gap-3 border-b border-helios-line pb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-asu-gold">
          Weight Budget
        </h2>
        {agg && (
          <span className="text-[10px] text-helios-dim">
            {agg.withMassCount} parts with mass
            {agg.missingCount > 0 ? `, ${agg.missingCount} missing` : ""}
          </span>
        )}
      </div>

      {noData ? (
        <div className="border border-helios-line bg-helios-panel px-4 py-6 text-center text-xs text-helios-dim">
          No mass data yet — check in SolidWorks parts with a{" "}
          <span className="font-semibold text-helios-text">Mass</span> property
          in the data card.
        </div>
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="Vehicle Mass"
              value={formatMass(agg!.totalGrams)}
              hint={`${agg!.withMassCount} parts`}
            />
            <StatCard
              label="Parts w/ Mass"
              value={String(agg!.withMassCount)}
              hint={agg!.missingCount > 0 ? `${agg!.missingCount} missing` : "complete"}
            />
            {deltaGrams !== null ? (
              <StatCard
                label={overBudget ? "Over Budget" : "Under Budget"}
                value={formatMass(Math.abs(deltaGrams))}
                hint={`target ${formatMass(targetGrams!)}`}
              />
            ) : (
              <div className="border border-helios-line bg-helios-panel px-3 py-2">
                <div className="text-[10px] text-helios-dim/70">No target set</div>
                <button
                  onClick={startEditing}
                  className="mt-1 text-[10px] text-helios-dim hover:text-asu-gold underline"
                >
                  Set weight target
                </button>
              </div>
            )}
            {/* Target setting inline */}
            <div className="border border-helios-line bg-helios-panel px-3 py-2 flex flex-col justify-center">
              <div className="text-[9px] font-medium uppercase tracking-widest text-helios-dim mb-1">
                Target
              </div>
              {targetBadge}
            </div>
          </div>

          {/* Delta bar (only when target set) */}
          {deltaGrams !== null && (
            <div className="border border-helios-line bg-helios-panel px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between text-[10px]">
                <span className="text-helios-dim">Weight vs target</span>
                <span
                  className={
                    overBudget ? "font-semibold text-red-400" : "font-semibold text-green-400"
                  }
                >
                  {overBudget ? "+" : "−"}
                  {formatMass(Math.abs(deltaGrams))}
                </span>
              </div>
              {/* Progress bar: fill = actual/target ratio, capped at 100% */}
              <div className="relative h-2 w-full overflow-hidden bg-helios-base">
                <div
                  className={
                    "absolute inset-y-0 left-0 " +
                    (overBudget ? "bg-red-500" : "bg-green-500")
                  }
                  style={{
                    width: `${Math.min((agg!.totalGrams / targetGrams!) * 100, 100)}%`,
                  }}
                />
                {/* Target marker */}
                <div
                  className="absolute inset-y-0 w-px bg-asu-gold/80"
                  style={{ left: "100%" }}
                />
              </div>
              <div className="mt-0.5 flex justify-between text-[9px] text-helios-dim/60">
                <span>0</span>
                <span>{formatMass(targetGrams!)}</span>
              </div>
            </div>
          )}

          {/* Charts grid */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard title="Heaviest parts" subtitle="By component mass">
              <HBars
                data={agg!.heaviest}
                formatValue={formatMass}
                accent="#FFC627"
              />
            </ChartCard>

            <ChartCard title="Mass by subsystem" subtitle="Top-level folders">
              {agg!.bySubsystem.length === 0 ? (
                <EmptyChart message="No folder data" />
              ) : (
                <HBars data={agg!.bySubsystem} formatValue={formatMass} />
              )}
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}
