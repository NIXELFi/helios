import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ReportModal } from "../ReportModal";
import { recordBreadcrumb, clearBreadcrumbs } from "../../../lib/breadcrumbs";

const h = vi.hoisted(() => ({ submit: vi.fn(async () => true), error: null as string | null, submitting: false }));
vi.mock("../useSubmitReport", () => ({ useSubmitReport: () => ({ submit: h.submit, error: h.error, submitting: h.submitting }) }));
vi.mock("../../../lib/screenshot", () => ({ captureScreenshot: vi.fn(async () => null) }));

function open(kind: "bug" | "feature" = "bug") {
  return render(<ReportModal kind={kind} module="vault" appVersion="4.3.7" onClose={() => {}} />);
}

describe("ReportModal", () => {
  beforeEach(() => {
    clearBreadcrumbs();
    h.submit = vi.fn(async () => true);
    h.error = null;
    h.submitting = false;
  });

  it("defaults the type from the kind prop and shows that type's severities", () => {
    open("bug");
    expect(screen.getByRole("button", { name: "bug" })).toHaveAttribute("aria-pressed", "true");
    const sev = screen.getByLabelText("Severity");
    const opts = within(sev).getAllByRole("option").map((o) => o.textContent);
    expect(opts).toEqual(["blocker", "annoying", "minor"]);
  });

  it("switches severities when the type changes to feature", () => {
    open("bug");
    fireEvent.click(screen.getByRole("button", { name: "feature" }));
    const opts = within(screen.getByLabelText("Severity")).getAllByRole("option").map((o) => o.textContent);
    expect(opts).toEqual(["important", "nice-to-have"]);
  });

  it("disables Send until a title is entered", () => {
    open("bug");
    const send = screen.getByRole("button", { name: "Send report" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Short summary of the problem"), { target: { value: "It broke" } });
    expect(send).toBeEnabled();
  });

  it("shows the snapshotted diagnostics (module + a seeded breadcrumb)", () => {
    recordBreadcrumb("nav", "module -> vault");
    open("bug");
    fireEvent.click(screen.getByRole("button", { name: /Diagnostics included/ }));
    expect(screen.getByText(/module=vault/)).toBeInTheDocument();
    expect(screen.getByText(/module -> vault/)).toBeInTheDocument();
  });

  it("submits the typed draft + diagnostics", async () => {
    open("bug");
    fireEvent.change(screen.getByPlaceholderText("Short summary of the problem"), { target: { value: "My title" } });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(h.submit).toHaveBeenCalledTimes(1);
    const [draft, diag] = h.submit.mock.calls[0]!;
    expect(draft).toMatchObject({ kind: "bug", title: "My title" });
    expect(diag).toMatchObject({ module: "vault", app_version: "4.3.7" });
  });

  it("on failure shows the error and keeps the typed title", () => {
    h.submit = vi.fn(async () => false);
    h.error = "insert failed";
    open("bug");
    const input = screen.getByPlaceholderText("Short summary of the problem") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "My title" } });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(screen.getByText("insert failed")).toBeInTheDocument();
    expect(input.value).toBe("My title");
  });
});
