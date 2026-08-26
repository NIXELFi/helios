import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreflightReport } from "../preflight";

const publishState = {
  phase: "idle" as string,
  sourceDir: null as string | null,
  packed: null as unknown,
  report: null as PreflightReport | null,
  diff: null as unknown,
  lockedSubteam: null as string | null,
  isNewPlugin: true,
  error: null as unknown,
  submitted: null as unknown,
  busy: false,
  canSubmit: false,
};
const actions = {
  chooseFolder: vi.fn(),
  packFolder: vi.fn(),
  recheck: vi.fn(),
  toConfirm: vi.fn(),
  back: vi.fn(),
  submit: vi.fn(),
  reset: vi.fn(),
};
const caps = { can: vi.fn(() => true) };

vi.mock("../usePublish", () => ({ usePublish: () => ({ ...publishState, ...actions }) }));
vi.mock("../../../org/data/useOrgData", () => ({
  useMyCapabilities: () => ({ can: caps.can, canAnywhere: () => true, loading: false, error: null, refetch: () => {} }),
  useSubteams: () => ({
    data: [
      { id: "s1", name: "Aerodynamics", code: "AERO", color: null },
      { id: "s2", name: "Chassis", code: "CHS", color: null },
    ],
    refetch: () => {},
  }),
}));

import { SubmitWizard } from "../SubmitWizard";

const PACKED = {
  stagedPath: "C:/cache/~publish/abc.hplugin",
  sha256: "a".repeat(64),
  bytes: 4096,
  manifest: {
    format: 1,
    id: "aero.test",
    name: "Downforce Calculator",
    version: "1.2.0",
    entry: "dist/index.html",
    sdk: "^1.0.0",
    permissions: [],
  },
  entries: ["dist/index.html", "manifest.json"],
  texts: {},
  warnings: [],
  largest: [],
};

const OK_REPORT: PreflightReport = {
  ok: true,
  errors: [],
  warnings: [],
  passed: [
    { level: "ok", code: "manifest-valid", title: "manifest.json is valid", detail: "", helpTopic: "manifest" },
  ],
  raw: { scan: [], manifestErrors: [], manifestWarnings: [], at: "2026-08-26T00:00:00Z" },
};

const BAD_REPORT: PreflightReport = {
  ok: false,
  errors: [
    {
      level: "error",
      code: "forbidden-api",
      title: "Tries to use the network",
      detail: "A plugin has no network access.",
      path: "dist/app.js",
      helpTopic: "network",
    },
  ],
  warnings: [],
  passed: [],
  raw: { scan: [], manifestErrors: [], manifestWarnings: [], at: "2026-08-26T00:00:00Z" },
};

function reset() {
  Object.assign(publishState, {
    phase: "idle",
    sourceDir: null,
    packed: null,
    report: null,
    diff: null,
    lockedSubteam: null,
    isNewPlugin: true,
    error: null,
    submitted: null,
    busy: false,
    canSubmit: false,
  });
  caps.can.mockReturnValue(true);
  vi.clearAllMocks();
}

beforeEach(reset);

describe("SubmitWizard", () => {
  it("opens on the folder step and tells you to pick the folder above dist", () => {
    render(<SubmitWizard onClose={() => {}} />);

    expect(screen.getByText(/choose your plugin folder/i)).toBeInTheDocument();
    expect(screen.getByText(/not the/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose folder/i })).toBeEnabled();
  });

  it("explains the missing capability instead of hiding the feature", () => {
    caps.can.mockReturnValue(false);

    render(<SubmitWizard onClose={() => {}} />);

    expect(screen.getByText(/you cannot publish yet/i)).toBeInTheDocument();
    expect(screen.getByText(/ask your lead or vp/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /choose folder/i })).not.toBeInTheDocument();
  });

  it("disables Continue while a blocking error is present", () => {
    Object.assign(publishState, { phase: "preflight", packed: PACKED, report: BAD_REPORT, canSubmit: false });

    render(<SubmitWizard onClose={() => {}} />);

    expect(screen.getByText(/a few things need fixing first/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });

  it("promises the pre-flight matches review when everything passes", () => {
    Object.assign(publishState, { phase: "preflight", packed: PACKED, report: OK_REPORT, canSubmit: true });

    render(<SubmitWizard onClose={() => {}} />);

    expect(screen.getByText(/everything checks out/i)).toBeInTheDocument();
    expect(screen.getByText(/same checks your reviewer runs/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("opens the help drawer at the topic a finding links to", () => {
    Object.assign(publishState, { phase: "preflight", packed: PACKED, report: BAD_REPORT, canSubmit: false });

    render(<SubmitWizard onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /how do i fix this/i }));

    expect(screen.getByRole("dialog", { name: /plugin author help/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /there is no network/i })).toBeInTheDocument();
  });

  it("will not submit a new plugin until an owning subteam is chosen", () => {
    Object.assign(publishState, {
      phase: "confirm",
      packed: PACKED,
      report: OK_REPORT,
      canSubmit: true,
      isNewPlugin: true,
      diff: { added: [], removed: [], unchanged: [], identical: true, isFirstVersion: true, addsHighTrust: false },
    });

    render(<SubmitWizard onClose={() => {}} />);

    const submit = screen.getByRole("button", { name: /submit for review/i });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/owning subteam/i), { target: { value: "s1" } });
    expect(screen.getByRole("button", { name: /submit for review/i })).toBeEnabled();
  });

  it("locks the owner of an existing plugin rather than offering a choice", () => {
    Object.assign(publishState, {
      phase: "confirm",
      packed: PACKED,
      report: OK_REPORT,
      canSubmit: true,
      isNewPlugin: false,
      lockedSubteam: "s1",
      diff: { added: [], removed: [], unchanged: [], identical: true, isFirstVersion: false, addsHighTrust: false },
    });

    render(<SubmitWizard onClose={() => {}} />);

    expect(screen.queryByLabelText(/owning subteam/i)).not.toBeInTheDocument();
    expect(screen.getByText(/owned by/i)).toBeInTheDocument();
    expect(screen.getByText("Aerodynamics")).toBeInTheDocument();
  });

  it("never implies you can approve your own submission", () => {
    Object.assign(publishState, {
      phase: "confirm",
      packed: PACKED,
      report: OK_REPORT,
      canSubmit: true,
      isNewPlugin: false,
      lockedSubteam: "s1",
      diff: { added: [], removed: [], unchanged: [], identical: true, isFirstVersion: false, addsHighTrust: false },
    });

    render(<SubmitWizard onClose={() => {}} />);

    expect(screen.getByText(/someone other than you/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot approve your own submission/i)).toBeInTheDocument();
  });

  it("shouts about a newly requested high-trust permission", () => {
    Object.assign(publishState, {
      phase: "confirm",
      packed: PACKED,
      report: OK_REPORT,
      canSubmit: true,
      isNewPlugin: false,
      lockedSubteam: "s1",
      diff: {
        added: ["engine:matlab"],
        removed: [],
        unchanged: ["storage"],
        identical: false,
        isFirstVersion: false,
        addsHighTrust: true,
      },
    });

    render(<SubmitWizard onClose={() => {}} />);

    expect(screen.getByText(/high-trust/i)).toBeInTheDocument();
    expect(screen.getByText(/new in this version/i)).toBeInTheDocument();
  });

  it("tells the author what happens next once submitted", () => {
    Object.assign(publishState, {
      phase: "done",
      packed: PACKED,
      report: OK_REPORT,
      submitted: { pluginId: "aero.test", version: "1.2.0", reviewStatus: "pending" },
    });

    render(<SubmitWizard onClose={() => {}} />);

    expect(screen.getByText(/submitted for review/i)).toBeInTheDocument();
    expect(screen.getByText(/withdraw it from/i)).toBeInTheDocument();
  });
});
