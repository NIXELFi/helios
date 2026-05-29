import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ChangePasswordModal } from "../src/auth/ChangePasswordModal";

function makeClient(updateUser = vi.fn().mockResolvedValue({ data: {}, error: null })) {
  return { auth: { updateUser } } as any;
}

function fill(pw: string, confirm: string) {
  fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: pw } });
  fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: confirm } });
}

const STRONG = "correcthorsebattery"; // >= 12 chars

describe("<ChangePasswordModal>", () => {
  it("renders nothing when closed", () => {
    render(<ChangePasswordModal open={false} client={makeClient()} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rejects a password shorter than 12 characters", () => {
    const updateUser = vi.fn();
    render(<ChangePasswordModal open client={makeClient(updateUser)} onClose={() => {}} />);
    fill("short", "short");
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/at least 12/i);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("rejects mismatched passwords", () => {
    const updateUser = vi.fn();
    render(<ChangePasswordModal open client={makeClient(updateUser)} onClose={() => {}} />);
    fill(STRONG, STRONG + "x");
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/don't match/i);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("calls updateUser and shows confirmation on success", async () => {
    const updateUser = vi.fn().mockResolvedValue({ data: {}, error: null });
    render(<ChangePasswordModal open client={makeClient(updateUser)} onClose={() => {}} />);
    fill(STRONG, STRONG);
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: STRONG }));
    expect(await screen.findByText(/password updated/i)).toBeInTheDocument();
  });

  it("surfaces a server error", async () => {
    const updateUser = vi.fn().mockResolvedValue({ data: {}, error: { message: "weak password" } });
    render(<ChangePasswordModal open client={makeClient(updateUser)} onClose={() => {}} />);
    fill(STRONG, STRONG);
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/weak password/i));
  });
});
