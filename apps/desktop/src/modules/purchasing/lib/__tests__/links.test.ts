import { describe, expect, it } from "vitest";
import { linkHref } from "../links";

describe("product links", () => {
  it("opens http(s) links as typed and adds https to a bare address; nothing else", () => {
    expect(linkHref(" https://www.mouser.com/ProductDetail/595-ADC128S102CIMTX ")).toBe("https://www.mouser.com/ProductDetail/595-ADC128S102CIMTX");
    expect(linkHref("digikey.com/en/products/detail/x")).toBe("https://digikey.com/en/products/detail/x");
    expect(linkHref("javascript:alert(1)")).toBeNull();
    expect(linkHref("in the airtable")).toBeNull();
    expect(linkHref("")).toBeNull();
  });
});
