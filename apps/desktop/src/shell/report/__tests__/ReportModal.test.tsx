import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ReportModal } from "../ReportModal";
import { recordBreadcrumb, clearBreadcrumbs } from "../../../lib/breadcrumbs";

const h = vi.hoisted(() => ({ submit: vi.fn(async () => true), error: null as string | null, submitting: false }));
vi.mock("../useSubmitReport", () => ({ useSubmitReport: () => ({ submit: h.submit, error: h.error, submitting: h.submitting }) }));

function open(kind: "bug" | "feature" = "bug") {
  return render(<ReportModal kind={kind} module="vault" appVersion="4.3.7" onClose={() => {}} />);
}

describe("ReportModal", () => {
  beforeEach(() => {
    clearBreadcrumbs();
    h.submit = vi.fn(async () => true);
    h.error = null;
    h.submitting = false;
    // jsdom doesn't implement object URLs; the modal uses them for the preview.
    (URL as any).createObjectURL = vi.fn(() => "blob:mock");
    (URL as any).revokeObjectURL = vi.fn();
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
    const call = h.submit.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(call[0]).toMatchObject({ kind: "bug", title: "My title" });
    expect(call[1]).toMatchObject({ module: "vault", app_version: "4.3.7" });
  });

  it("lets the user upload a screenshot file and then remove it", () => {
    open("bug");
    expect(screen.getByRole("button", { name: "Upload screenshot" })).toBeInTheDocument();
    const input = screen.getByLabelText("Upload screenshot");
    const file = new File(["img-bytes"], "shot.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByAltText("Screenshot preview")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove screenshot" }));
    expect(screen.queryByAltText("Screenshot preview")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload screenshot" })).toBeInTheDocument();
  });

  it("autofocuses the Title input on initial mount", () => {
    open("bug");
    expect(screen.getByPlaceholderText("Short summary of the problem")).toHaveFocus();
  });

  it("keeps focus in Details when the parent re-renders with a new onClose reference", () => {
    const { rerender } = render(
      <ReportModal kind="bug" module="vault" appVersion="4.3.7" onClose={() => {}} />,
    );
    const detailsBox = screen.getByLabelText("Details");
    detailsBox.focus();
    expect(detailsBox).toHaveFocus();
    // The shell passes a fresh inline onClose closure on every render (presence
    // events re-render it). Re-mounting the effect must not steal focus back.
    rerender(<ReportModal kind="bug" module="vault" appVersion="4.3.7" onClose={() => {}} />);
    expect(detailsBox).toHaveFocus();
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
