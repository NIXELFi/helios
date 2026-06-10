import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { VaultWarningBanner } from "../../components/VaultWarningBanner";
import { notifyVaultWarning } from "../vault-warning-events";

describe("VaultWarningBanner", () => {
  it("renders fired warnings (surviving the firing component) and dismisses", () => {
    render(<VaultWarningBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => {
      notifyVaultWarning({ title: "asm.sldasm: 2 references unresolved", detail: "frame.sldprt, arm.sldprt" });
    });
    expect(screen.getByRole("alert").textContent).toContain("2 references unresolved");
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps only the most recent few warnings", () => {
    render(<VaultWarningBanner />);
    act(() => {
      for (let i = 1; i <= 5; i++) notifyVaultWarning({ title: `w${i}`, detail: "d" });
    });
    const text = screen.getByRole("alert").textContent!;
    expect(text).not.toContain("w1");
    expect(text).toContain("w5");
  });
});
