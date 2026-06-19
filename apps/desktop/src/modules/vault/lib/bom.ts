// Pure BOM (Bill of Materials) builder for SolidWorks assemblies.
// No React, no Supabase — graph in, BOM out — fully unit-testable.
// See __tests__/bom.test.ts.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input graph. One entry per file (id → metadata) + one entry per version's
 *  child refs. Built by useVaultBom from live Supabase data. */
export interface BomGraph {
  /** Map of fileId → { name, massGrams } for every file in the vault. */
  files: Map<string, { name: string; massGrams: number | null }>;
  /** Map of fileId → list of direct children.
   *  childFileId is null when the ref is unresolved (file deleted or not in vault). */
  refs: Map<string, { childFileId: string | null; childPathHint: string }[]>;
}

/** One node in the indented BOM tree. */
export interface BomNode {
  /** null for unresolved (broken) references. */
  fileId: string | null;
  name: string;
  /** How many times this exact file appears under this parent. */
  quantity: number;
  massGrams: number | null;
  children: BomNode[];
}

/** One row in the flattened (parts-list) BOM. */
export interface FlatBomRow {
  fileId: string | null;
  name: string;
  /** Total quantity across the entire assembly (qty × parent multiplicity). */
  totalQty: number;
  massGrams: number | null;
  /** totalQty × massGrams, or null when massGrams is null. */
  extMassGrams: number | null;
}

/** Summary totals for a BOM. */
export interface BomTotals {
  /** Sum of (qty × unit mass) for all parts with known mass, in grams. */
  totalMass: number;
  /** Count of distinct part identities (fileId or path hint). */
  distinctParts: number;
  /** Sum of all quantities (total instances across the assembly). */
  totalInstances: number;
  /** Count of distinct parts whose mass is unknown/null. */
  missingMassCount: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract the last path segment as a file name from a path hint. */
function basenameFromHint(hint: string): string {
  const cleaned = hint.replace(/`$/, ""); // strip accidental trailing backtick
  const i = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return i >= 0 ? cleaned.slice(i + 1) : cleaned;
}

/** CSV-quote a single cell value if it contains commas, quotes, or newlines. */
function csvCell(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---------------------------------------------------------------------------
// buildBomTree
// ---------------------------------------------------------------------------

/**
 * Recursively build a BOM tree from rootFileId.
 *
 * Cycle guard: tracks the ancestor chain (by fileId) for this recursion path.
 * When a child fileId is already in the ancestor set, the recursion stops and
 * no children are emitted for that node (it appears as a leaf).
 *
 * Duplicate children under the same parent are collapsed into a single BomNode
 * with quantity = number of occurrences.
 */
export function buildBomTree(
  rootFileId: string,
  graph: BomGraph,
): BomNode[] {
  return _buildChildren(rootFileId, graph, new Set([rootFileId]));
}

function _buildChildren(
  parentFileId: string,
  graph: BomGraph,
  ancestors: Set<string>,
): BomNode[] {
  const childRefs = graph.refs.get(parentFileId) ?? [];

  // Group child refs by childFileId (resolved) or childPathHint (unresolved).
  // Key: `id:<fileId>` for resolved refs, `hint:<pathHint>` for unresolved.
  const grouped = new Map<string, { childFileId: string | null; childPathHint: string; count: number }>();

  for (const ref of childRefs) {
    const key = ref.childFileId != null
      ? `id:${ref.childFileId}`
      : `hint:${ref.childPathHint}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, {
        childFileId: ref.childFileId,
        childPathHint: ref.childPathHint,
        count: 1,
      });
    }
  }

  const nodes: BomNode[] = [];

  for (const { childFileId, childPathHint, count } of grouped.values()) {
    if (childFileId === null) {
      // Unresolved reference — leaf node with name from path hint.
      nodes.push({
        fileId: null,
        name: basenameFromHint(childPathHint),
        quantity: count,
        massGrams: null,
        children: [],
      });
      continue;
    }

    const fileMeta = graph.files.get(childFileId);
    const name = fileMeta?.name ?? basenameFromHint(childPathHint);
    const massGrams = fileMeta?.massGrams ?? null;

    // Cycle guard: if this file is already an ancestor in the current path,
    // skip it entirely to prevent infinite recursion.
    if (ancestors.has(childFileId)) {
      continue;
    }

    const children = _buildChildren(
      childFileId,
      graph,
      new Set([...ancestors, childFileId]),
    );

    nodes.push({
      fileId: childFileId,
      name,
      quantity: count,
      massGrams,
      children,
    });
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// flattenBom
// ---------------------------------------------------------------------------

/**
 * Flatten the BOM tree into one row per distinct part (fileId, or path hint
 * for unresolved refs), rolling up total quantity across all parent paths.
 *
 * The walk is depth-first; parent multiplicity is propagated down so that
 * a sub-assembly used 2× contributes 2× its children's quantities.
 */
export function flattenBom(tree: BomNode[]): FlatBomRow[] {
  // Key: same as in buildBomTree — `id:<fileId>` or `name:<name>` for unresolved.
  const accum = new Map<string, { name: string; fileId: string | null; totalQty: number; massGrams: number | null }>();

  function walk(nodes: BomNode[], parentMultiplier: number): void {
    for (const node of nodes) {
      const qty = node.quantity * parentMultiplier;
      const key = node.fileId != null ? `id:${node.fileId}` : `name:${node.name}`;
      const existing = accum.get(key);
      if (existing) {
        existing.totalQty += qty;
      } else {
        accum.set(key, {
          name: node.name,
          fileId: node.fileId,
          totalQty: qty,
          massGrams: node.massGrams,
        });
      }
      // Recurse into sub-assemblies; pass the multiplied qty downward.
      if (node.children.length > 0) {
        walk(node.children, qty);
      }
    }
  }

  walk(tree, 1);

  return Array.from(accum.values()).map((r) => ({
    fileId: r.fileId,
    name: r.name,
    totalQty: r.totalQty,
    massGrams: r.massGrams,
    extMassGrams: r.massGrams != null ? r.totalQty * r.massGrams : null,
  }));
}

// ---------------------------------------------------------------------------
// bomTotals
// ---------------------------------------------------------------------------

/**
 * Compute summary statistics from a flattened BOM.
 */
export function bomTotals(tree: BomNode[]): BomTotals {
  const flat = flattenBom(tree);
  let totalMass = 0;
  let missingMassCount = 0;
  let totalInstances = 0;

  for (const row of flat) {
    totalInstances += row.totalQty;
    if (row.massGrams == null) {
      missingMassCount += 1;
    } else {
      totalMass += row.totalQty * row.massGrams;
    }
  }

  return {
    totalMass,
    distinctParts: flat.length,
    totalInstances,
    missingMassCount,
  };
}

// ---------------------------------------------------------------------------
// bomToCsv
// ---------------------------------------------------------------------------

/**
 * Convert a flattened BOM to a CSV string.
 * Columns: Name, Qty, Unit Mass (g), Ext Mass (g)
 */
export function bomToCsv(rows: FlatBomRow[]): string {
  const header = ["Name", "Qty", "Unit Mass (g)", "Ext Mass (g)"]
    .map(csvCell)
    .join(",");

  const dataLines = rows.map((r) => {
    const cells = [
      csvCell(r.name),
      String(r.totalQty),
      r.massGrams != null ? String(r.massGrams) : "",
      r.extMassGrams != null ? String(r.extMassGrams) : "",
    ];
    return cells.join(",");
  });

  return [header, ...dataLines].join("\n");
}
