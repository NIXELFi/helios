import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreflightReport } from "../../publish/preflight";
import type { ReviewItem } from "../../data/useReview";

const state = {
  queue: [] as ReviewItem[],
  loading: false,
  error: null as string | null,
  reports: {} as Record<string, { report: PreflightReport; disagrees: boolean }>,
  userId: "reviewer-1",
};
const fns = {
  refetch: vi.fn(),
  inspect: vi.fn(),
  preview: vi.fn(() => Promise.resolve()),
  review: vi.fn(() => Promise.resolve()),
};

vi.mock("@helios/auth", () => ({ useUser: () => ({ id: state.userId }) }));
vi.mock("../../data/useReview", () => ({
  useReviewQueue: () => ({
    loading: state.loading,
    error: state.error,
    queue: state.queue,
    refetch: fns.refetch,
  }),
  useReviewInspect: () => ({
    inspect: fns.inspect,
    reports: state.reports,
    inspecting: null,
    error: null,
  }),
  useReviewPreview: () => ({ preview: fns.preview, previewing: null, error: null }),
  useReviewVersion: () => ({ review: fns.review, reviewing: false, error: null }),
}));

import { ReviewView } from "../ReviewView";

const ITEM: ReviewItem = {
  pluginId: "aero.test",
  name: "Downforce Calculator",
  subteam: "s1",
  version: "1.2.0",
  manifest: {
    format: 1,
    id: "aero.test",
    name: "Downforce Calculator",
    version: "1.2.0",
    description: "Computes downforce.",
    entry: "dist/index.html",
    sdk: "^1.0.0",
    permissions: ["storage", "engine:matlab"],
  } as ReviewItem["manifest"],
  permissions: ["storage", "engine:matlab"],
  reviewReport: null,
  bundleSha256: "a".repeat(64),
  bundleBytes: 2048,
  publishedBy: "author-1",
  publishedAt: "2026-08-26T00:00:00Z",
};

const AVAILABLE = [
  { id: "aero.test", permissions: ["storage"] },
] as unknown as Parameters<typeof ReviewView>[0]["available"];

const CLEAN_REPORT: PreflightReport = {
  ok: true,
  errors: [],
  warnings: [],
  passed: [],
  raw: { scan: [], manifestErrors: [], manifestWarnings: [], at: "2026-08-26T00:00:00Z" },
};

beforeEach(() => {
  state.queue = [ITEM];
  state.loading = false;
  state.error = null;
  state.reports = {};
  state.userId = "reviewer-1";
  vi.clearAllMocks();
});

describe("ReviewView", () => {
  it("shows an empty state that explains what the queue is for", () => {
    state.queue = [];

    render(<ReviewView available={AVAILABLE} onHelp={() => {}} />);

    expect(screen.getByText(/nothing waiting on you/i)).toBeInTheDocument();
  });

  it("leads with what changed about the permissions", () => {
    render(<ReviewView available={AVAILABLE} onHelp={() => {}} />);

    expect(screen.getByText(/permissions changed: asks for 1 new/i)).toBeInTheDocument();
    expect(screen.getByText(/new in this version/i)).toBeInTheDocument();
  });

  it("warns loudly when a version newly reaches outside the sandbox", () => {
    render(<ReviewView available={AVAILABLE} onHelp={() => {}} />);

    expect(screen.getByText(/adds a high-trust permission/i)).toBeInTheDocument();
  });

  it("offers a scan of the uploaded bytes and says why the author's is not enough", () => {
    render(<ReviewView available={AVAILABLE} onHelp={() => {}} />);

    expect(screen.getByText(/report submitted with a version comes from the author/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /scan the uploaded bundle/i }));
    expect(fns.inspect).toHaveBeenCalledWith(ITEM);
  });

  it("flags a re-scan that disagrees with the submitted report", () => {
    state.reports = { "aero.test@1.2.0": { report: CLEAN_REPORT, disagrees: true } };

    render(<ReviewView available={AVAILABLE} onHelp={() => {}} />);

    expect(screen.getByText(/does not match the report submitted/i)).toBeInTheDocument();
  });

  it("lets a reviewer test-drive the pending build", async () => {
    render(<ReviewView available={AVAILABLE} onHelp={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /test-drive/i }));

    await waitFor(() => expect(fns.preview).toHaveBeenCalledWith(ITEM));
    expect(screen.getByText(/unapproved preview/i)).toBeInTheDocument();
  });

  it("blocks approving your own submission and explains why", () => {
    state.userId = "author-1"; // the reviewer published it

    render(<ReviewView available={AVAILABLE} onHelp={() => {}} />);

    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.getByText(/you published this version/i)).toBeInTheDocument();
    expect(screen.getByText(/takes a second person/i)).toBeInTheDocument();
  });

  it("attaches the reviewer's own scan to the decision, not the author's", async () => {
    state.reports = { "aero.test@1.2.0": { report: CLEAN_REPORT, disagrees: false } };

    render(<ReviewView available={AVAILABLE} onHelp={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() =>
      expect(fns.review).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "aero.test",
          version: "1.2.0",
          decision: "approved",
          report: CLEAN_REPORT.raw,
        }),
      ),
    );
    expect(fns.refetch).toHaveBeenCalled();
  });

  it("will not send a rejection without a note", async () => {
    render(<ReviewView available={AVAILABLE} onHelp={() => {}} />);

    // First click arms the rejection; the confirm stays disabled while empty.
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    const confirm = screen.getByRole("button", { name: /confirm rejection/i });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/review notes/i), {
      target: { value: "Drop the matlab permission or explain it." },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm rejection/i }));

    await waitFor(() =>
      expect(fns.review).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "rejected",
          notes: "Drop the matlab permission or explain it.",
        }),
      ),
    );
  });
});
