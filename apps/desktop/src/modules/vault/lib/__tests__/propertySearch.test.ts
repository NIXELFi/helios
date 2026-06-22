import { describe, expect, test } from "vitest";
import {
  parseSearchQuery,
  matchesProperties,
  propertyTextMatch,
} from "../propertySearch";
import type { SwProperty } from "../../data/types";

// ---------------------------------------------------------------------------
// parseSearchQuery
// ---------------------------------------------------------------------------

describe("parseSearchQuery", () => {
  test("text-only query returns full string as text with no prop filters", () => {
    const r = parseSearchQuery("frame bracket");
    expect(r.text).toBe("frame bracket");
    expect(r.propFilters).toHaveLength(0);
  });

  test("empty string returns empty text and no filters", () => {
    const r = parseSearchQuery("   ");
    expect(r.text).toBe("");
    expect(r.propFilters).toHaveLength(0);
  });

  test("single prop token is parsed into key+value, text is empty", () => {
    const r = parseSearchQuery("prop:Material=7075");
    expect(r.text).toBe("");
    expect(r.propFilters).toHaveLength(1);
    expect(r.propFilters[0]!.key).toBe("material");
    expect(r.propFilters[0]!.value).toBe("7075");
  });

  test("multiple prop tokens are AND-combined", () => {
    const r = parseSearchQuery("prop:Material=7075 prop:Status=Prototype");
    expect(r.text).toBe("");
    expect(r.propFilters).toHaveLength(2);
    expect(r.propFilters[0]!.key).toBe("material");
    expect(r.propFilters[0]!.value).toBe("7075");
    expect(r.propFilters[1]!.key).toBe("status");
    expect(r.propFilters[1]!.value).toBe("prototype");
  });

  test("quoted value preserves spaces and strips quotes", () => {
    const r = parseSearchQuery('prop:Material="7075 T6"');
    expect(r.propFilters).toHaveLength(1);
    expect(r.propFilters[0]!.key).toBe("material");
    expect(r.propFilters[0]!.value).toBe("7075 t6");
  });

  test("mixed free text and prop tokens: text excludes prop tokens", () => {
    const r = parseSearchQuery("bracket prop:Material=steel arm");
    expect(r.text).toBe("bracket arm");
    expect(r.propFilters).toHaveLength(1);
    expect(r.propFilters[0]!.key).toBe("material");
    expect(r.propFilters[0]!.value).toBe("steel");
  });

  test("prop key is normalised to lowercase", () => {
    const r = parseSearchQuery("prop:MATERIAL=Aluminum");
    expect(r.propFilters[0]!.key).toBe("material");
  });

  test("prop value is normalised to lowercase", () => {
    const r = parseSearchQuery("prop:Status=PROTOTYPE");
    expect(r.propFilters[0]!.value).toBe("prototype");
  });

  test("free text is normalised to lowercase (case-insensitive filename scoring)", () => {
    // The free text left after stripping prop: tokens must be lowercased so the
    // downstream filename scorer (which lowercases the candidate name only)
    // stays case-insensitive. "Frame" → "frame".
    const r = parseSearchQuery("Frame prop:Material=7075");
    expect(r.text).toBe("frame");
    const r2 = parseSearchQuery("BRACKET ARM");
    expect(r2.text).toBe("bracket arm");
  });

  test("prop token with equals sign in value is handled correctly", () => {
    // Only the first '=' splits key from value
    const r = parseSearchQuery("prop:Description=A=B");
    expect(r.propFilters[0]!.key).toBe("description");
    expect(r.propFilters[0]!.value).toBe("a=b");
  });
});

// ---------------------------------------------------------------------------
// matchesProperties
// ---------------------------------------------------------------------------

describe("matchesProperties", () => {
  const props: SwProperty[] = [
    { name: "Material", value: "7075-T6 Aluminum" },
    { name: "Status", value: "Prototype" },
    { name: "Finish", value: "Anodized Black" },
  ];

  test("empty filters always return true", () => {
    expect(matchesProperties(props, [])).toBe(true);
    expect(matchesProperties(null, [])).toBe(true);
    expect(matchesProperties(undefined, [])).toBe(true);
  });

  test("single filter matches when property name and value satisfy it", () => {
    expect(matchesProperties(props, [{ key: "material", value: "7075" }])).toBe(true);
  });

  test("single filter fails when property name does not match", () => {
    expect(matchesProperties(props, [{ key: "weight", value: "100" }])).toBe(false);
  });

  test("single filter fails when property value does not contain filter value", () => {
    expect(matchesProperties(props, [{ key: "material", value: "steel" }])).toBe(false);
  });

  test("all filters must match (AND logic)", () => {
    expect(
      matchesProperties(props, [
        { key: "material", value: "7075" },
        { key: "status", value: "prototype" },
      ])
    ).toBe(true);
  });

  test("AND fails if one filter does not match", () => {
    expect(
      matchesProperties(props, [
        { key: "material", value: "7075" },
        { key: "status", value: "production" }, // no match
      ])
    ).toBe(false);
  });

  test("null props with non-empty filters return false", () => {
    expect(matchesProperties(null, [{ key: "material", value: "7075" }])).toBe(false);
  });

  test("undefined props with non-empty filters return false", () => {
    expect(matchesProperties(undefined, [{ key: "material", value: "7075" }])).toBe(false);
  });

  test("empty array props with non-empty filters return false", () => {
    expect(matchesProperties([], [{ key: "material", value: "7075" }])).toBe(false);
  });

  test("property name matching is case-insensitive", () => {
    // filter key 'MATERIAL' should match property named 'Material'
    expect(matchesProperties(props, [{ key: "MATERIAL", value: "7075" }])).toBe(true);
  });

  test("property value matching is case-insensitive substring", () => {
    // Filter value 'PROTOTYPE' should match property value 'Prototype'
    expect(matchesProperties(props, [{ key: "status", value: "PROTOTYPE" }])).toBe(true);
  });

  test("key can be a substring of the property name", () => {
    // 'mat' should match property named 'Material'
    expect(matchesProperties(props, [{ key: "mat", value: "7075" }])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// propertyTextMatch
// ---------------------------------------------------------------------------

describe("propertyTextMatch", () => {
  const props: SwProperty[] = [
    { name: "Material", value: "7075-T6 Aluminum" },
    { name: "Status", value: "Prototype" },
    { name: "Description", value: "Lower control arm bracket" },
  ];

  test("returns true when any property VALUE contains the text", () => {
    expect(propertyTextMatch(props, "7075")).toBe(true);
  });

  test("returns true for substring match within a value", () => {
    expect(propertyTextMatch(props, "control arm")).toBe(true);
  });

  test("returns false when text does not appear in any property value", () => {
    expect(propertyTextMatch(props, "composite")).toBe(false);
  });

  test("matching is case-insensitive", () => {
    expect(propertyTextMatch(props, "PROTOTYPE")).toBe(true);
    expect(propertyTextMatch(props, "aluminum")).toBe(true);
  });

  test("returns false for null props", () => {
    expect(propertyTextMatch(null, "7075")).toBe(false);
  });

  test("returns false for undefined props", () => {
    expect(propertyTextMatch(undefined, "7075")).toBe(false);
  });

  test("returns false for empty props array", () => {
    expect(propertyTextMatch([], "7075")).toBe(false);
  });

  test("returns false for empty text string", () => {
    expect(propertyTextMatch(props, "")).toBe(false);
  });

  test("returns true on single character match", () => {
    expect(propertyTextMatch(props, "z")).toBe(false);
    expect(propertyTextMatch(props, "a")).toBe(true); // 'a' appears in 'Aluminum', 'Prototype', etc.
  });
});
