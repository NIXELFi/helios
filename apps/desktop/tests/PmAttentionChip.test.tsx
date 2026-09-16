import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PmAttentionChip } from "../src/components/PmAttentionChip";
import { localDateKey } from "../src/lib/pm-attention";

afterEach(cleanup);

/** Minimal thenable query builder mimicking supabase-js's chain. */
function fakeClient(rows: unknown[]) {
  const q: any = {
    select: vi.fn(() => q),
    neq: vi.fn(() => q),
    lte: vi.fn(() => q),
    then: (res: (v: unknown) => void) => res({ data: rows, error: null }),
  };
  const from = vi.fn(() => q);
  return { client: { schema: vi.fn(() => ({ from })) }, from, q };
}

describe("<PmAttentionChip>", () => {
  it("renders nothing when nothing you own is due", async () => {
    const { client, from } = fakeClient([
      { id: "1", title: "x", due_date: "2000-01-01", status: "not_started", owner_id: "someone-else" },
    ]);
    const { container } = render(<PmAttentionChip client={client} userId="me" onClick={() => {}} />);
    await waitFor(() => expect(from).toHaveBeenCalledWith("tasks"));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows overdue + due-today counts for your tasks and jumps to PM on click", async () => {
    const key = localDateKey();
    const { client, q } = fakeClient([
      { id: "1", title: "x", due_date: "2000-01-01", status: "not_started", owner_id: "me" },
      { id: "2", title: "y", due_date: key, status: "in_progress", owner_id: "o", task_owners: [{ owner_id: "me" }] },
    ]);
    const onClick = vi.fn();
    render(<PmAttentionChip client={client} userId="me" onClick={onClick} />);
    const btn = await screen.findByRole("button", { name: /PM: 1 overdue · 1 due today/ });
    expect(q.neq).toHaveBeenCalledWith("status", "done");
    expect(q.lte).toHaveBeenCalledWith("due_date", key);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
