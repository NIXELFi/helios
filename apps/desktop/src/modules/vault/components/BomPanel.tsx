// Bill of Materials panel for SolidWorks assemblies.
// Opened from FileDetailPanel for .sldasm files.
// Provides a togglable Structure (indented) / Parts List (flat) view,
// summary stats, and a Download CSV button.

import { useMemo, useState } from "react";
import { buildBomTree, flattenBom, bomTotals, bomToCsv } from "../lib/bom";
import { formatMass } from "../lib/massStats";
import type { BomGraph, BomNode, FlatBomRow } from "../lib/bom";
import type { FileId } from "../data/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewMode = "structure" | "parts";

// ---------------------------------------------------------------------------
// CSV download helper (no Tauri fs — uses a Blob + anchor click, works in
// the web renderer without needing file-system permissions)
// ---------------------------------------------------------------------------

function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Indented tree node — recursive. */
function TreeRow({ node, depth }: { node: BomNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <>
      <tr className="group border-b border-helios-line last:border-0">
        <td className="py-1 pr-2 text-xs" style={{ paddingLeft: `${8 + depth * 16}px` }}>
          <span className="flex items-center gap-1">
            {hasChildren ? (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="w-3.5 shrink-0 text-center text-[10px] text-helios-dim hover:text-helios-text"
                aria-label={open ? "Collapse" : "Expand"}
              >
                {open ? "▾" : "▸"}
              </button>
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            <span
              className={
                node.fileId
                  ? "text-helios-text"
                  : "italic text-helios-dim"
              }
              title={node.fileId == null ? "Unresolved reference" : undefined}
            >
              {node.name}
              {node.fileId == null && (
                <span className="ml-1 text-[10px]">(unresolved)</span>
              )}
            </span>
          </span>
        </td>
        <td className="px-2 py-1 text-right text-xs tabular-nums text-helios-text">
          ×{node.quantity}
        </td>
        <td className="py-1 pl-2 text-right text-xs tabular-nums text-helios-dim">
          {node.massGrams != null ? formatMass(node.massGrams) : "—"}
        </td>
      </tr>
      {hasChildren && open
        ? node.children.map((child, i) => (
            <TreeRow key={child.fileId ?? `hint-${i}`} node={child} depth={depth + 1} />
          ))
        : null}
    </>
  );
}

/** Flat parts-list row. */
function FlatRow({ row }: { row: FlatBomRow }) {
  return (
    <tr className="border-b border-helios-line last:border-0">
      <td
        className={
          "py-1 pr-2 text-xs " +
          (row.fileId ? "text-helios-text" : "italic text-helios-dim")
        }
      >
        {row.name}
        {row.fileId == null && (
          <span className="ml-1 text-[10px]">(unresolved)</span>
        )}
      </td>
      <td className="px-2 py-1 text-right text-xs tabular-nums text-helios-text">
        {row.totalQty}
      </td>
      <td className="px-2 py-1 text-right text-xs tabular-nums text-helios-dim">
        {row.massGrams != null ? formatMass(row.massGrams) : "—"}
      </td>
      <td className="py-1 pl-2 text-right text-xs tabular-nums text-helios-dim">
        {row.extMassGrams != null ? formatMass(row.extMassGrams) : "—"}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main BomPanel
// ---------------------------------------------------------------------------

interface Props {
  /** The assembly file we are generating the BOM for. */
  fileId: FileId;
  fileName: string;
  /** The full vault-wide graph from useVaultBom. */
  graph: BomGraph;
  onClose: () => void;
}

export function BomPanel({ fileId, fileName, graph, onClose }: Props) {
  const [mode, setMode] = useState<ViewMode>("parts");

  // Build tree + flat once when graph/fileId changes.
  const tree = useMemo(() => buildBomTree(fileId, graph), [fileId, graph]);
  const flat = useMemo(() => flattenBom(tree), [tree]);
  const totals = useMemo(() => bomTotals(tree), [tree]);

  const empty = flat.length === 0;

  function handleDownloadCsv() {
    const csv = bomToCsv(flat);
    const slug = fileName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
    downloadCsv(`${slug}_BOM.csv`, csv);
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between border-b border-helios-line px-3 py-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-asu-gold">
            Bill of Materials
          </div>
          <div className="mt-0.5 truncate text-xs text-helios-dim" title={fileName}>
            {fileName}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-2 shrink-0 rounded border border-helios-line px-2 py-0.5 text-[10px] text-helios-dim hover:bg-helios-line hover:text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          aria-label="Close BOM"
        >
          ✕
        </button>
      </header>

      {/* ── Stats bar ───────────────────────────────────────────────────── */}
      {!empty && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-helios-line bg-helios-panel px-3 py-2 text-[10px]">
          <span className="text-helios-dim">
            <span className="font-semibold text-helios-text">{totals.distinctParts}</span> parts
          </span>
          <span className="text-helios-dim">
            <span className="font-semibold text-helios-text">{totals.totalInstances}</span> instances
          </span>
          <span className="text-helios-dim">
            Total mass:{" "}
            <span className="font-semibold text-helios-text">
              {totals.totalMass > 0 ? formatMass(totals.totalMass) : "—"}
            </span>
          </span>
          {totals.missingMassCount > 0 && (
            <span className="text-helios-dim/60">
              {totals.missingMassCount} missing mass
            </span>
          )}
        </div>
      )}

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-helios-line px-3 py-1.5">
        {/* View toggle */}
        <div className="flex rounded border border-helios-line text-[10px]">
          <button
            type="button"
            onClick={() => setMode("parts")}
            className={
              "px-2 py-0.5 focus-visible:outline-none " +
              (mode === "parts"
                ? "bg-helios-line text-helios-text"
                : "text-helios-dim hover:text-helios-text")
            }
          >
            Parts List
          </button>
          <button
            type="button"
            onClick={() => setMode("structure")}
            className={
              "px-2 py-0.5 focus-visible:outline-none " +
              (mode === "structure"
                ? "bg-helios-line text-helios-text"
                : "text-helios-dim hover:text-helios-text")
            }
          >
            Structure
          </button>
        </div>

        {/* CSV download */}
        {!empty && (
          <button
            type="button"
            onClick={handleDownloadCsv}
            className="rounded border border-helios-line px-2 py-0.5 text-[10px] text-helios-dim hover:bg-helios-line hover:text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
            title="Download BOM as CSV"
          >
            ↓ CSV
          </button>
        )}
      </div>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        {empty ? (
          <div className="px-4 py-8 text-center text-xs text-helios-dim">
            No child references found.
            <br />
            This assembly may have no "Contains" references in the vault.
          </div>
        ) : mode === "structure" ? (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-helios-line bg-helios-panel">
                <th className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wider text-helios-dim">
                  Part
                </th>
                <th className="px-2 py-1 text-right text-[10px] font-medium uppercase tracking-wider text-helios-dim">
                  Qty
                </th>
                <th className="px-2 py-1 text-right text-[10px] font-medium uppercase tracking-wider text-helios-dim">
                  Unit Mass
                </th>
              </tr>
            </thead>
            <tbody>
              {tree.map((node, i) => (
                <TreeRow key={node.fileId ?? `hint-${i}`} node={node} depth={0} />
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-helios-line bg-helios-panel">
                <th className="px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wider text-helios-dim">
                  Part
                </th>
                <th className="px-2 py-1 text-right text-[10px] font-medium uppercase tracking-wider text-helios-dim">
                  Qty
                </th>
                <th className="px-2 py-1 text-right text-[10px] font-medium uppercase tracking-wider text-helios-dim">
                  Unit Mass
                </th>
                <th className="px-2 py-1 text-right text-[10px] font-medium uppercase tracking-wider text-helios-dim">
                  Ext Mass
                </th>
              </tr>
            </thead>
            <tbody>
              {flat.map((row, i) => (
                <FlatRow key={row.fileId ?? `hint-${i}`} row={row} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
