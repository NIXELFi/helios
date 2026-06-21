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
// FIX 1: flattenBom/bomTotals — assembly nodes must not double-count mass
// ---------------------------------------------------------------------------

describe("flattenBom — assembly with massGrams AND massed children (double-count fix)", () => {
  // SolidWorks stores a computed rollup mass on assembly versions.
  // If we count the assembly's own massGrams AND its children's masses, the
  // total is wrong. Only leaf parts (nodes with no children) should contribute
  // to the mass total.
  //
  // TopAsm (massGrams=500 — SW rollup stored on the assembly row)
  //   └── PartA ×1 (massGrams=200)
  //   └── PartB ×1 (massGrams=300)
  // Correct total: 200 + 300 = 500 (not 500 + 200 + 300 = 1000)
  const graph = makeGraph(
    [
      { id: "top", name: "TopAsm.SLDASM", massGrams: 500 }, // rollup stored on asm
      { id: "partA", name: "PartA.SLDPRT", massGrams: 200 },
      { id: "partB", name: "PartB.SLDPRT", massGrams: 300 },
    ],
    [
      { parentFileId: "top", childFileId: "partA" },
      { parentFileId: "top", childFileId: "partB" },
    ],
  );

  const tree = buildBomTree("top", graph);

  test("flattenBom: only leaf parts appear in flat list (assembly is root, not in tree)", () => {
    // buildBomTree returns the CHILDREN of the root, so 'top' itself is never
    // a BomNode in the returned tree. The flat list contains only the leaf parts.
    const flat = flattenBom(tree);
    expect(flat.map((r) => r.fileId).sort()).toEqual(["partA", "partB"].sort());
  });

  test("bomTotals: total mass equals sum of leaf parts only (not assembly + leaves)", () => {
    const totals = bomTotals(tree);
    // leaf total: 200 + 300 = 500; must NOT be 500 + 200 + 300 = 1000
    expect(totals.totalMass).toBeCloseTo(500);
  });

  test("bomTotals: distinctParts counts only the leaf parts (assembly is root)", () => {
    const totals = bomTotals(tree);
    // PartA + PartB = 2 distinct leaf parts (top is the root, not in tree)
    expect(totals.distinctParts).toBe(2);
  });
});

describe("flattenBom — nested assemblies: mid-level asm with massGrams + massed leaves", () => {
  // VehicleAsm (massGrams=null)
  //   └── SuspAsm ×2 (massGrams=950 — SW rollup)
  //         └── Upright ×1 (massGrams=800)
  //         └── BallJoint ×2 (massGrams=75)
  // Correct total: 2×(800 + 2×75) = 2×950 = 1900 (NOT 2×950 + 2×800 + 4×75)
  const graph = makeGraph(
    [
      { id: "vehicle", name: "Vehicle.SLDASM", massGrams: null },
      { id: "susp", name: "SuspAsm.SLDASM", massGrams: 950 },
      { id: "upright", name: "Upright.SLDPRT", massGrams: 800 },
      { id: "bj", name: "BallJoint.SLDPRT", massGrams: 75 },
    ],
    [
      { parentFileId: "vehicle", childFileId: "susp" },
      { parentFileId: "vehicle", childFileId: "susp" },
      { parentFileId: "susp", childFileId: "upright" },
      { parentFileId: "susp", childFileId: "bj" },
      { parentFileId: "susp", childFileId: "bj" },
    ],
  );

  const tree = buildBomTree("vehicle", graph);

  test("total mass counts only leaves: 2×(800 + 2×75) = 1900", () => {
    const totals = bomTotals(tree);
    // upright: qty=2×1=2, mass=800 → 1600
    // balljoint: qty=2×2=4, mass=75 → 300
    // total = 1900 (not 1900 + 2×950 = 3800)
    expect(totals.totalMass).toBeCloseTo(1900);
  });
});

// ---------------------------------------------------------------------------
// FIX 2: bomToCsv — formula injection neutralization
// ---------------------------------------------------------------------------

describe("bomToCsv — CSV formula injection neutralization", () => {
  const injectionRows: FlatBomRow[] = [
    {
      fileId: "evil1",
      name: "=cmd()|' /C calc",
      totalQty: 1,
      massGrams: 10,
      extMassGrams: 10,
    },
    {
      fileId: "evil2",
      name: "+HYPERLINK(\"http://evil.com\",\"click\")",
      totalQty: 1,
      massGrams: 10,
      extMassGrams: 10,
    },
    {
      fileId: "evil3",
      name: "-1+2",
      totalQty: 1,
      massGrams: 10,
      extMassGrams: 10,
    },
    {
      fileId: "evil4",
      name: "@SUM(A1:A10)",
      totalQty: 1,
      massGrams: 10,
      extMassGrams: 10,
    },
    {
      fileId: "safe",
      name: "NormalPart.SLDPRT",
      totalQty: 2,
      massGrams: 50,
      extMassGrams: 100,
    },
  ];

  const csv = bomToCsv(injectionRows);
  const lines = csv.split("\n");

  test("name starting with '=' is neutralized (prefixed with single-quote)", () => {
    const evilLine = lines.find((l) => l.includes("cmd()"))!;
    expect(evilLine).toBeDefined();
    // The cell must not start with = — it should be prefixed with '
    // The cell value (quoted or not) must not begin with = after stripping outer quotes
    expect(evilLine).not.toMatch(/^"?=cmd/);
    expect(evilLine).toContain("'=cmd()");
  });

  test("name starting with '+' is neutralized", () => {
    const line = lines.find((l) => l.includes("HYPERLINK"))!;
    expect(line).toBeDefined();
    expect(line).toContain("'+HYPERLINK");
  });

  test("name starting with '-' is neutralized", () => {
    const line = lines.find((l) => l.includes("1+2"))!;
    expect(line).toBeDefined();
    expect(line).toContain("'-1+2");
  });

  test("name starting with '@' is neutralized", () => {
    const line = lines.find((l) => l.includes("SUM(A1"))!;
    expect(line).toBeDefined();
    expect(line).toContain("'@SUM");
  });

  test("safe part name is NOT prefixed with single-quote", () => {
    const safeLine = lines.find((l) => l.includes("NormalPart"))!;
    expect(safeLine).toBeDefined();
    expect(safeLine).not.toContain("'NormalPart");
    expect(safeLine).toContain("NormalPart.SLDPRT");
  });
});

// ---------------------------------------------------------------------------
// buildBomTree — CYCLE GUARD (self-reference + mutual)
// ---------------------------------------------------------------------------

describe("buildBomTree — cycle guard (self-reference)", () => {
  // asm → asm (direct self-loop)
  // FIX 4: strengthen this test so it would genuinely fail if the cycle guard
  // were removed. We verify: (a) the self-edge child is dropped from the tree
  // (not present as a child), AND (b) the call does not hang (enforced by the
  // fact that we also inspect the structure, not just that it "doesn't throw").
  const selfGraph = makeGraph(
    [{ id: "asm", name: "BadAsm.SLDASM", massGrams: null }],
    [{ parentFileId: "asm", childFileId: "asm" }],
  );

  test("self-referencing assembly: the self-edge child is dropped (cycle guard removes it)", () => {
    const tree = buildBomTree("asm", selfGraph);
    // Without the cycle guard this would recurse infinitely and never reach here.
    // The self-edge must be dropped: root has no children.
    expect(tree).toHaveLength(0);
  });

  test("self-referencing assembly: no node in the result has the same fileId as itself in children", () => {
    // Build a more elaborate self-referencing graph: A → B → A (three-node cycle)
    const cycleGraph = makeGraph(
      [
        { id: "a", name: "A.SLDASM" },
        { id: "b", name: "B.SLDASM" },
        { id: "c", name: "C.SLDPRT", massGrams: 10 },
      ],
      [
        { parentFileId: "a", childFileId: "b" },
        { parentFileId: "b", childFileId: "a" }, // back-edge (cycle)
        { parentFileId: "b", childFileId: "c" }, // legitimate leaf
      ],
    );

    const tree = buildBomTree("a", cycleGraph);
    // a → b (qty 1), b → a is cut (cycle), b → c (qty 1)
    expect(tree).toHaveLength(1);
    const bNode = tree[0]!;
    expect(bNode.fileId).toBe("b");
    // b's children: back-edge to a is dropped, c survives
    expect(bNode.children).toHaveLength(1);
    expect(bNode.children[0]!.fileId).toBe("c");
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
// flattenBom — two distinct broken refs sharing a basename stay separate rows
// ---------------------------------------------------------------------------

describe("flattenBom — same-basename unresolved refs do NOT merge", () => {
  // Two unresolved children with the SAME basename (Bracket.SLDPRT) but
  // DIFFERENT full paths must remain two distinct parts-list rows. Keying by
  // basename (the old bug) summed their quantities into a single row.
  const graph = makeGraph(
    [{ id: "asm", name: "TopAsm.SLDASM", massGrams: null }],
    [
      { parentFileId: "asm", childFileId: null, childPathHint: "/front/Bracket.SLDPRT" },
      { parentFileId: "asm", childFileId: null, childPathHint: "/rear/Bracket.SLDPRT" },
    ],
  );

  const tree = buildBomTree("asm", graph);
  const flat = flattenBom(tree);

  test("buildBomTree keeps the two broken refs as separate nodes", () => {
    expect(tree).toHaveLength(2);
  });

  test("flattenBom keeps two distinct rows (not one merged row)", () => {
    const brackets = flat.filter((r) => r.name === "Bracket.SLDPRT");
    expect(brackets).toHaveLength(2);
    // Each retains its own quantity of 1 — they are NOT summed into qty 2.
    for (const r of brackets) {
      expect(r.totalQty).toBe(1);
    }
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
