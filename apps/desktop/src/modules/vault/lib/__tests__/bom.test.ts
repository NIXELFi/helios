import { describe, expect, test } from "vitest";
import {
  buildBomTree,
  flattenBom,
  bomTotals,
  bomToCsv,
} from "../bom";
import type { BomGraph, BomNode, FlatBomRow } from "../bom";

// ---------------------------------------------------------------------------
// Helpers — build minimal BomGraph inputs
// ---------------------------------------------------------------------------

/** Build a BomGraph for tests. */
function makeGraph(
  files: { id: string; name: string; massGrams?: number | null }[],
  edges: { parentFileId: string; childFileId: string | null; childPathHint?: string }[],
): BomGraph {
  const fileMap = new Map(
    files.map((f) => [
      f.id,
      { name: f.name, massGrams: f.massGrams ?? null },
    ]),
  );
  const refsMap = new Map<string, { childFileId: string | null; childPathHint: string }[]>();
  for (const e of edges) {
    const list = refsMap.get(e.parentFileId) ?? [];
    list.push({
      childFileId: e.childFileId,
      childPathHint: e.childPathHint ?? (e.childFileId ? `/${e.childFileId}` : "/unknown.SLDPRT`"),
    });
    refsMap.set(e.parentFileId, list);
  }
  return { files: fileMap, refs: refsMap };
}

// ---------------------------------------------------------------------------
// buildBomTree — basic tree shape
// ---------------------------------------------------------------------------

describe("buildBomTree — simple two-level assembly", () => {
  // TopAssembly
  //   ├── Bracket ×2
  //   └── Bolt ×1
  const graph = makeGraph(
    [
      { id: "top", name: "TopAssembly.SLDASM", massGrams: null },
      { id: "bracket", name: "Bracket.SLDPRT", massGrams: 150 },
      { id: "bolt", name: "Bolt.SLDPRT", massGrams: 5 },
    ],
    [
      { parentFileId: "top", childFileId: "bracket", childPathHint: "/Bracket.SLDPRT" },
      { parentFileId: "top", childFileId: "bracket", childPathHint: "/Bracket.SLDPRT" },
      { parentFileId: "top", childFileId: "bolt", childPathHint: "/Bolt.SLDPRT" },
    ],
  );

  const tree = buildBomTree("top", graph);

  test("tree has two distinct child nodes (bracket deduplicated)", () => {
    expect(tree).toHaveLength(2);
  });

  test("bracket node has quantity 2", () => {
    const bracket = tree.find((n) => n.fileId === "bracket");
    expect(bracket).toBeDefined();
    expect(bracket!.quantity).toBe(2);
  });

  test("bolt node has quantity 1", () => {
    const bolt = tree.find((n) => n.fileId === "bolt");
    expect(bolt!.quantity).toBe(1);
  });

  test("leaf parts have no children", () => {
    for (const node of tree) {
      expect(node.children).toHaveLength(0);
    }
  });

  test("mass is propagated from graph", () => {
    const bracket = tree.find((n) => n.fileId === "bracket")!;
    expect(bracket.massGrams).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// buildBomTree — three-level nesting
// ---------------------------------------------------------------------------

describe("buildBomTree — three-level nesting", () => {
  // VehicleAsm
  //   └── SuspensionAsm  ×1
  //         ├── Upright.SLDPRT ×1
  //         └── BallJoint.SLDPRT ×2
  const graph = makeGraph(
    [
      { id: "vehicle", name: "Vehicle.SLDASM", massGrams: null },
      { id: "suspension", name: "SuspensionAsm.SLDASM", massGrams: null },
      { id: "upright", name: "Upright.SLDPRT", massGrams: 800 },
      { id: "balljoint", name: "BallJoint.SLDPRT", massGrams: 120 },
    ],
    [
      { parentFileId: "vehicle", childFileId: "suspension" },
      { parentFileId: "suspension", childFileId: "upright" },
      { parentFileId: "suspension", childFileId: "balljoint" },
      { parentFileId: "suspension", childFileId: "balljoint" },
    ],
  );

  const tree = buildBomTree("vehicle", graph);

  test("vehicle has one direct child (SuspensionAsm)", () => {
    expect(tree).toHaveLength(1);
    expect(tree[0]!.fileId).toBe("suspension");
  });

  test("SuspensionAsm has two children (Upright + BallJoint)", () => {
    const suspChildren = tree[0]!.children;
    expect(suspChildren).toHaveLength(2);
  });

  test("BallJoint quantity is 2 inside SuspensionAsm", () => {
    const suspChildren = tree[0]!.children;
    const bj = suspChildren.find((n) => n.fileId === "balljoint");
    expect(bj!.quantity).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildBomTree — unresolved children (childFileId === null)
// ---------------------------------------------------------------------------

describe("buildBomTree — unresolved child references", () => {
  const graph = makeGraph(
    [{ id: "asm", name: "TopAsm.SLDASM", massGrams: null }],
    [
      { parentFileId: "asm", childFileId: null, childPathHint: "/missing/Part.SLDPRT" },
    ],
  );

  const tree = buildBomTree("asm", graph);

  test("unresolved ref appears as a leaf node with null fileId", () => {
    expect(tree).toHaveLength(1);
    expect(tree[0]!.fileId).toBeNull();
  });

  test("unresolved node name comes from the path hint's basename", () => {
    expect(tree[0]!.name).toBe("Part.SLDPRT");
  });

  test("unresolved node has quantity 1", () => {
    expect(tree[0]!.quantity).toBe(1);
  });

  test("unresolved node has no children", () => {
    expect(tree[0]!.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildBomTree — CYCLE GUARD (self-reference + mutual)
// ---------------------------------------------------------------------------

describe("buildBomTree — cycle guard (self-reference)", () => {
  // asm → asm (direct self-loop)
  const graph = makeGraph(
    [{ id: "asm", name: "BadAsm.SLDASM", massGrams: null }],
    [{ parentFileId: "asm", childFileId: "asm" }],
  );

  test("self-referencing assembly terminates and returns empty children", () => {
    const tree = buildBomTree("asm", graph);
    // The root node's child is itself; the cycle guard must cut the recursion.
    // Depending on implementation the child entry may be omitted or returned as
    // a leaf with no children — either way the call must not throw or hang.
    expect(() => tree).not.toThrow();
    // No infinite recursion: the total node count is finite (0 or 1 child nodes).
    expect(tree.length).toBeLessThanOrEqual(1);
    if (tree.length === 1) {
      expect(tree[0]!.children).toHaveLength(0);
    }
  });
});

describe("buildBomTree — cycle guard (mutual reference A↔B)", () => {
  const graph = makeGraph(
    [
      { id: "a", name: "A.SLDASM" },
      { id: "b", name: "B.SLDASM" },
    ],
    [
      { parentFileId: "a", childFileId: "b" },
      { parentFileId: "b", childFileId: "a" }, // mutual cycle
    ],
  );

  test("mutual cycle terminates: A's child B gets no children back to A", () => {
    const tree = buildBomTree("a", graph);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.fileId).toBe("b");
    // B wants to recurse into A, but A is an ancestor — must be cut
    expect(tree[0]!.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// flattenBom — quantity roll-up across multiple parents
// ---------------------------------------------------------------------------

describe("flattenBom — quantity roll-up when a part appears under multiple parents", () => {
  // VehicleAsm
  //   ├── FrontCornerAsm ×2
  //   │     └── Upright ×1   (appears ×2 via FrontCornerAsm qty)
  //   └── RearCornerAsm ×2
  //         └── Upright ×1   (appears ×2 via RearCornerAsm qty)
  // Upright total qty = 2×1 + 2×1 = 4
  const graph = makeGraph(
    [
      { id: "vehicle", name: "Vehicle.SLDASM", massGrams: null },
      { id: "front_corner", name: "FrontCorner.SLDASM", massGrams: null },
      { id: "rear_corner", name: "RearCorner.SLDASM", massGrams: null },
      { id: "upright", name: "Upright.SLDPRT", massGrams: 900 },
    ],
    [
      { parentFileId: "vehicle", childFileId: "front_corner" },
      { parentFileId: "vehicle", childFileId: "front_corner" },
      { parentFileId: "vehicle", childFileId: "rear_corner" },
      { parentFileId: "vehicle", childFileId: "rear_corner" },
      { parentFileId: "front_corner", childFileId: "upright" },
      { parentFileId: "rear_corner", childFileId: "upright" },
    ],
  );

  const tree = buildBomTree("vehicle", graph);
  const flat = flattenBom(tree);

  test("Upright total quantity is 4 (rolled up across two parent assemblies)", () => {
    const uprightRow = flat.find((r) => r.fileId === "upright");
    expect(uprightRow).toBeDefined();
    expect(uprightRow!.totalQty).toBe(4);
  });

  test("FrontCorner quantity is 2", () => {
    const fcRow = flat.find((r) => r.fileId === "front_corner");
    expect(fcRow!.totalQty).toBe(2);
  });

  test("extended mass = totalQty × unit massGrams", () => {
    const uprightRow = flat.find((r) => r.fileId === "upright")!;
    expect(uprightRow.extMassGrams).toBeCloseTo(4 * 900);
  });

  test("flat rows with no mass have null extMassGrams", () => {
    const fcRow = flat.find((r) => r.fileId === "front_corner")!;
    expect(fcRow.extMassGrams).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bomTotals
// ---------------------------------------------------------------------------

describe("bomTotals", () => {
  // Simple tree: root asm → bracket ×2 (150g) + bolt ×1 (5g)
  const graph = makeGraph(
    [
      { id: "top", name: "TopAsm.SLDASM", massGrams: null },
      { id: "bracket", name: "Bracket.SLDPRT", massGrams: 150 },
      { id: "bolt", name: "Bolt.SLDPRT", massGrams: 5 },
      { id: "mystery", name: "Mystery.SLDPRT", massGrams: null },
    ],
    [
      { parentFileId: "top", childFileId: "bracket" },
      { parentFileId: "top", childFileId: "bracket" },
      { parentFileId: "top", childFileId: "bolt" },
      { parentFileId: "top", childFileId: "mystery" },
    ],
  );

  const tree = buildBomTree("top", graph);
  const totals = bomTotals(tree);

  test("totalMass sums qty × unit mass for parts with known mass", () => {
    // bracket: 2×150 = 300; bolt: 1×5 = 5 → 305
    expect(totals.totalMass).toBeCloseTo(305);
  });

  test("distinctParts counts unique parts (bracket is 1 distinct, mystery is 1)", () => {
    // bracket, bolt, mystery = 3 distinct
    expect(totals.distinctParts).toBe(3);
  });

  test("totalInstances sums quantities", () => {
    // bracket×2 + bolt×1 + mystery×1 = 4
    expect(totals.totalInstances).toBe(4);
  });

  test("missingMassCount counts parts with null mass", () => {
    expect(totals.missingMassCount).toBe(1); // mystery
  });

  test("empty tree yields all-zero totals", () => {
    const empty = bomTotals([]);
    expect(empty.totalMass).toBe(0);
    expect(empty.distinctParts).toBe(0);
    expect(empty.totalInstances).toBe(0);
    expect(empty.missingMassCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// bomToCsv
// ---------------------------------------------------------------------------

describe("bomToCsv", () => {
  const rows: FlatBomRow[] = [
    {
      fileId: "bracket",
      name: "Bracket.SLDPRT",
      totalQty: 4,
      massGrams: 150,
      extMassGrams: 600,
    },
    {
      fileId: null,
      name: "Part,With,Commas.SLDPRT", // needs quoting
      totalQty: 1,
      massGrams: null,
      extMassGrams: null,
    },
  ];

  const csv = bomToCsv(rows);
  const lines = csv.split("\n");

  test("first line is a header", () => {
    expect(lines[0]).toMatch(/name/i);
    expect(lines[0]).toMatch(/qty/i);
  });

  test("has a line per row plus header (2 data rows → 3 lines total)", () => {
    expect(lines).toHaveLength(3);
  });

  test("values appear in data rows", () => {
    const dataLine = lines[1]!;
    expect(dataLine).toContain("Bracket.SLDPRT");
    expect(dataLine).toContain("4");
    expect(dataLine).toContain("150");
    expect(dataLine).toContain("600");
  });

  test("cells with commas are quoted", () => {
    const commaLine = lines[2]!;
    expect(commaLine).toContain('"Part,With,Commas.SLDPRT"');
  });

  test("null mass renders as empty cell (not 'null' text)", () => {
    const nullLine = lines[2]!;
    const cells = nullLine.split(",");
    // mass cell and extMass cell should be empty strings, not "null"
    const hasNullText = cells.some((c) => c.trim() === "null");
    expect(hasNullText).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bomToCsv — unresolved child rows
// ---------------------------------------------------------------------------

describe("bomToCsv — unresolved (fileId=null) rows round-trip correctly", () => {
  const graph = makeGraph(
    [{ id: "asm", name: "TopAsm.SLDASM", massGrams: null }],
    [
      { parentFileId: "asm", childFileId: null, childPathHint: "/missing/Ghost.SLDPRT" },
    ],
  );
  const tree = buildBomTree("asm", graph);
  const flat = flattenBom(tree);

  test("flat list contains one row for the unresolved part", () => {
    expect(flat).toHaveLength(1);
    expect(flat[0]!.name).toBe("Ghost.SLDPRT");
  });

  test("CSV export includes the unresolved part name", () => {
    const csv = bomToCsv(flat);
    expect(csv).toContain("Ghost.SLDPRT");
  });
});
