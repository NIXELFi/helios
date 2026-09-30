/* When the Sim module talks to the server, and what a delete reaches.
 *
 * Two things that were wrong at the seam between the local archive and the
 * team's. The listing is re-read from disk every six seconds and used to be
 * synced with the server every time -- a whole-table read, a per-user read
 * and possibly a fifty-row upsert, per client, ten times a minute, whether or
 * not anything had changed. And deleting a run removed its directory and
 * left its row, so the run came straight back from the server with a cloud
 * icon, still ranked. */
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { SimRun } from "../api";

const listRuns = vi.fn<() => Promise<SimRun[]>>();
const deleteRun = vi.fn<(id: string) => Promise<void>>();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    simStatus: vi.fn(async () => ({
      exePath: "C:/sim/fsae-sim.exe", exeConfigured: true, version: "fsae-sim 0.3.0",
      runsDir: "C:/runs", runCount: 1, searched: [],
    })),
    simListRuns: () => listRuns(),
    simDeleteRun: (id: string) => deleteRun(id),
    readRunTelemetry: vi.fn(async () => null),
    simLaunch: vi.fn(),
    simImportRun: vi.fn(),
    simTelemetryPath: vi.fn(async (id: string) => `C:/runs/${id}/telemetry.csv`),
    // The module keeps the simulator current on its own; here the feed has
    // nothing to say.
    simAvailableBuild: vi.fn(async () => null),
    simFeedPlatforms: vi.fn(async () => []),
    simInstall: vi.fn(),
    onSimInstallProgress: () => () => {},
  };
});

const fetchShared = vi.fn<() => Promise<SimRun[]>>();
const push = vi.fn(async () => ({
  pushed: 0, telemetryPushed: 0, telemetryPruned: 0, telemetrySwept: 0, skippedNotMine: 0, skippedStale: 0, error: null,
}));
const deleteShared = vi.fn<(client: unknown, id: string) => Promise<void>>();
vi.mock("../lib/share", () => ({
  fetchSharedRuns: () => fetchShared(),
  pushRuns: () => push(),
  fetchSharedTelemetry: vi.fn(),
  deleteSharedRun: (client: unknown, id: string) => deleteShared(client, id),
  telemetryToKeep: () => new Set<string>(),
  KEEP_BEST: 3,
  KEEP_RECENT: 3,
  GEN_KEEP_BEST: 2,
  GEN_KEEP_RECENT: 1,
}));

vi.mock("../../../auth/AuthShell", () => {
  // Stable across renders, as the real auth state is: a fresh `user` object
  // every call would read as signing in on every render.
  const user = { id: "u1" };
  const client = {};
  return {
    useHeliosAuth: () => ({ user, client }),
    userDisplayName: () => "Nick",
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { SimHome } from "../SimHome";
import * as api from "../api";
import * as share from "../lib/share";
import { simToasts } from "../lib/toast";

// Today, so the runs table has one day to open. See RunsTable.test.tsx.
const today = (hour: number) => {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

function run(over: Partial<SimRun> & { runId: string }): SimRun {
  return {
    formatVersion: 3, sampleRateHz: 100, dir: `C:/runs/${over.runId}`,
    telemetryPath: `C:/runs/${over.runId}/telemetry.csv`, telemetryBytes: 1024,
    driver: "Sam", driverId: "u1", session: null, track: "autocross", trackName: "Autocross 2026",
    startedAt: today(12), finishedReason: "finished", profile: "wheel", detectedInput: "wheel",
    device: null, physics: "native", simVersion: "0.3.0", synthetic: false, samples: 4100,
    assists: { traction: false, abs: false, autoShift: false }, laps: [],
    stats: {
      durationS: 41, distanceM: 685, laps: 1, bestLapS: 41.2, bestLapRawS: 41.2,
      bestLapNumber: 1, bestSectors: [], theoreticalBestS: null, totalCones: 0,
      totalOffCourse: 0, peakSpeedKph: 90, peakRpm: 12000, peakLatG: 1.4,
      peakBrakeG: 1.3, peakAccelG: 1.1, avgSpeedMps: 16, fullThrottleFrac: 0.3,
      brakingFrac: 0.2, offTrackS: 0, ffbClippedFrac: 0,
    },
    ...over,
  } as SimRun;
}

describe("SimHome", () => {
  beforeEach(() => {
    localStorage.clear();
    listRuns.mockReset();
    fetchShared.mockReset();
    fetchShared.mockResolvedValue([]);
    push.mockClear();
    deleteRun.mockReset();
    deleteRun.mockResolvedValue(undefined);
    deleteShared.mockReset();
    deleteShared.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("syncs when the set of local runs changes, not every time the disk is read", async () => {
    vi.useFakeTimers();
    const a = run({ runId: "a" });
    // A fresh array of fresh objects every time, which is what the six-second
    // poll hands back whether or not anything changed.
    listRuns.mockImplementation(async () => [{ ...a }]);
    render(<SimHome active />);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(push).toHaveBeenCalledTimes(1);

    // Two more polls, nothing new on disk: nothing goes to the server.
    await act(async () => { await vi.advanceTimersByTimeAsync(6_100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_100); });
    expect(push).toHaveBeenCalledTimes(1);

    // A run is written: the next poll sees a new id, and that syncs.
    listRuns.mockImplementation(async () => [{ ...a }, run({ runId: "b", startedAt: today(13) })]);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_100); });
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("takes a deleted run off the board too, before the server has even answered", async () => {
    const a = run({ runId: "a" });
    listRuns.mockImplementation(async () => [{ ...a }]);
    const onBoard = { ...a, remote: true, dir: "", telemetryPath: "", telemetryBytes: 0 };
    // The first read has the run on the board, as it would. Every later read
    // hangs: the delete has not landed on the server yet, and the table must
    // not wait for it.
    fetchShared.mockResolvedValueOnce([onBoard]).mockImplementation(() => new Promise(() => {}));
    const { container } = render(<SimHome active />);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));

    // The newest day holds the signed-in driver's run, so it is already
    // open. Select the run, delete it.
    expect(container.querySelector("tbody tr")?.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByText("Sam"));
    fireEvent.click(screen.getByRole("button", { name: /delete run/i }));
    fireEvent.click(await screen.findByRole("button", { name: /delete for good/i }));
    await waitFor(() => expect(deleteRun).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(deleteShared).toHaveBeenCalledWith(expect.anything(), "a"));
    // Gone from the table now -- not re-merged from the shared copy with a
    // cloud icon while the server catches up.
    expect(screen.queryByText("Sam")).toBeNull();
  });
});

describe("watching a sector record", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helios:sim:tab", "board");
    listRuns.mockReset();
    fetchShared.mockReset();
    vi.mocked(api.simLaunch).mockReset();
    vi.mocked(api.simLaunch).mockResolvedValue({ exePath: "x", args: [], pid: 1 });
    vi.mocked(api.simImportRun).mockReset();
    vi.mocked(api.simImportRun).mockResolvedValue("C:/runs/x");
    vi.mocked(share.fetchSharedTelemetry).mockReset();
    vi.mocked(share.fetchSharedTelemetry).mockResolvedValue("time_s\n0\n");
  });

  const lapOf = (n: number, sectors: number[]) => ({
    lap: n, raw: sectors.reduce((a, b) => a + b, 0), cones: 0, off: 0,
    total: sectors.reduce((a, b) => a + b, 0), valid: true, sectors, startedAtS: 2,
  });

  it("fetches the record's lap AND the ghost, then opens at that lap and sector", async () => {
    // Mine is on this disk; Jordan's record and my other lap are only on the
    // server. The ghost used to be launched by id without ever being fetched,
    // and the simulator said "GHOST NOT LOADED".
    const mineLocal = run({ runId: "mine-local", simVersion: "0.6.6", laps: [lapOf(1, [13, 13, 13])],
      stats: { ...run({ runId: "x" }).stats, bestLapS: 39, bestLapRawS: 39 } });
    const mineShared = run({ runId: "mine-shared", simVersion: "0.6.6", remote: true, dir: "", telemetryPath: "",
      telemetryBytes: 0, telemetryObject: "u1/mine-shared.csv.gz",
      laps: [lapOf(1, [13.5, 12.5, 13.5])], stats: { ...run({ runId: "x" }).stats, bestLapS: 39.5, bestLapRawS: 39.5 } });
    const record = run({ runId: "jordan", driver: "Jordan", driverId: "u2", simVersion: "0.6.6", remote: true,
      dir: "", telemetryPath: "", telemetryBytes: 0, telemetryObject: "u2/jordan.csv.gz",
      laps: [lapOf(1, [14, 14, 14]), { ...lapOf(2, [13.2, 12.0, 13.9]), startedAtS: 44 }],
      stats: { ...run({ runId: "x" }).stats, bestLapS: 39.1, bestLapRawS: 39.1, bestLapNumber: 2 } });
    listRuns.mockImplementation(async () => [mineLocal]);
    fetchShared.mockResolvedValue([mineShared, record]);

    render(<SimHome active />);
    const chip = await screen.findByRole("button", { name: /Sector 2 record 12\.000 seconds by Jordan/ });
    fireEvent.click(chip);
    expect(screen.getByTestId("sector-card-target").textContent).toMatch(/S2 record.*12\.000 s.*Jordan, lap 2/);
    // My best S2 is 12.5 on the shared run, and it has telemetry, so it is the ghost.
    expect(screen.getByTestId("sector-card-mine").textContent).toMatch(/Your best S2.*12\.500 s.*\+0\.500/);
    fireEvent.click(screen.getByRole("button", { name: /Watch in sim/ }));

    await waitFor(() => expect(api.simLaunch).toHaveBeenCalled());
    const fetched = vi.mocked(share.fetchSharedTelemetry).mock.calls.map((c) => (c[1] as SimRun).runId);
    expect(fetched).toEqual(["jordan", "mine-shared"]);
    expect(api.simLaunch).toHaveBeenCalledWith({
      replay: "jordan", replayLap: 2, ghost: "mine-shared", ghostLap: 1, sector: 2,
    });
  });

  it("will not offer to watch a record whose lap is gone, and says why", async () => {
    const mineLocal = run({ runId: "mine-local", simVersion: "0.6.6", laps: [lapOf(1, [13, 13, 13])],
      stats: { ...run({ runId: "x" }).stats, bestLapS: 39, bestLapRawS: 39 } });
    const record = run({ runId: "jordan", driver: "Jordan", driverId: "u2", simVersion: "0.6.6", remote: true,
      dir: "", telemetryPath: "", telemetryBytes: 0, telemetryObject: null,
      laps: [lapOf(1, [13.2, 12.0, 13.9])], stats: { ...run({ runId: "x" }).stats, bestLapS: 39.1, bestLapRawS: 39.1 } });
    listRuns.mockImplementation(async () => [mineLocal]);
    fetchShared.mockResolvedValue([record]);

    render(<SimHome active />);
    fireEvent.click(await screen.findByRole("button", { name: /Sector 2 record/ }));
    expect((screen.getByRole("button", { name: /Watch in sim/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Compare in Logs/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("sector-card-why").textContent).toMatch(/Jordan's lap is no longer stored/);
  });

  it("compares in Logs: both runs, their own labels, Main/Ref laps and the sector's window", async () => {
    const mineLocal = run({ runId: "mine-local", simVersion: "0.6.6", laps: [lapOf(1, [13, 13, 13])],
      stats: { ...run({ runId: "x" }).stats, bestLapS: 39, bestLapRawS: 39 } });
    const record = run({ runId: "jordan", driver: "Jordan", driverId: "u2", simVersion: "0.6.6", remote: true,
      dir: "", telemetryPath: "", telemetryBytes: 0, telemetryObject: "u2/jordan.csv.gz",
      laps: [{ ...lapOf(1, [13.2, 12.0, 13.9]), startedAtS: 2.5 }],
      stats: { ...run({ runId: "x" }).stats, bestLapS: 39.1, bestLapRawS: 39.1 } });
    listRuns.mockImplementation(async () => [mineLocal]);
    fetchShared.mockResolvedValue([record]);
    const seen: unknown[] = [];
    const h = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("helios:open-in-logs", h);
    try {
      render(<SimHome active />);
      fireEvent.click(await screen.findByRole("button", { name: /Sector 2 record/ }));
      fireEvent.click(screen.getByRole("button", { name: /Compare in Logs/ }));
      await waitFor(() => expect(seen).toHaveLength(1));
    } finally {
      window.removeEventListener("helios:open-in-logs", h);
    }
    expect(seen[0]).toMatchObject({
      paths: ["C:/runs/jordan/telemetry.csv", "C:/runs/mine-local/telemetry.csv"],
      labels: ["Jordan L1 — Autocross 2026 (S2)", "Sam L1 — Autocross 2026 (mine)"],
      selection: {
        main: { path: "C:/runs/jordan/telemetry.csv", lap: 1 },
        ref: { path: "C:/runs/mine-local/telemetry.csv", lap: 1 },
        // Lap 1 started at 2.5 s on the run's clock; S1 took 13.2.
        zoom: { path: "C:/runs/jordan/telemetry.csv", startS: 15.7, endS: 27.7 },
        workspace: "lap-analysis",
      },
    });
  });

  it("an ordinary replay carries no positioning flags", async () => {
    const mineLocal = run({ runId: "mine-local", simVersion: "0.6.6",
      stats: { ...run({ runId: "x" }).stats, bestLapS: 39, bestLapRawS: 39 } });
    listRuns.mockImplementation(async () => [mineLocal]);
    fetchShared.mockResolvedValue([]);
    render(<SimHome active />);
    // Straight through the leaderboard's movie button: no ghost there, and the
    // launch carries no positioning flags.
    const movie = await screen.findByTitle("Watch that lap");
    fireEvent.click(movie);
    await waitFor(() => expect(api.simLaunch).toHaveBeenCalledWith({
      replay: "mine-local", ghost: undefined, replayLap: undefined, ghostLap: undefined, sector: undefined,
    }));
  });
});

describe("what the Sim header and toasts say", () => {
  beforeEach(() => {
    localStorage.clear();
    listRuns.mockReset();
    fetchShared.mockReset();
    push.mockClear();
    vi.mocked(api.simLaunch).mockReset();
    simToasts.reset();
  });
  afterEach(() => { simToasts.reset(); });

  it("opens a run's best lap in Logs as Main, in the lap-analysis workspace", async () => {
    listRuns.mockImplementation(async () => [run({ runId: "a" })]);
    fetchShared.mockResolvedValue([]);
    const seen: unknown[] = [];
    const h = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("helios:open-in-logs", h);
    try {
      render(<SimHome active />);
      fireEvent.click(await screen.findByRole("button", { name: "Open the best lap in Logs" }));
      await waitFor(() => expect(seen).toHaveLength(1));
    } finally {
      window.removeEventListener("helios:open-in-logs", h);
    }
    // It used to send the path alone, and Logs opened the file on its out lap.
    expect(seen[0]).toMatchObject({
      paths: ["C:/runs/a/telemetry.csv"],
      labels: ["Sam — Autocross 2026"],
      selection: { main: { path: "C:/runs/a/telemetry.csv", lap: 1 }, workspace: "lap-analysis" },
    });
  });

  it("keeps a failed launch on screen until it is dismissed", async () => {
    listRuns.mockImplementation(async () => [run({ runId: "a" })]);
    fetchShared.mockResolvedValue([]);
    vi.mocked(api.simLaunch).mockRejectedValue(new Error("the simulator would not start"));
    render(<SimHome active />);
    fireEvent.click(await screen.findByRole("button", { name: "Watch the replay" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/would not start/);
    // Not wiped by the next good read of the archive, which is what the old
    // header line did.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when the team's runs were last read, and when the rig is offline", async () => {
    listRuns.mockImplementation(async () => [run({ runId: "a" })]);
    fetchShared.mockResolvedValue([]);
    const { unmount } = render(<SimHome active />);
    await waitFor(() => expect(screen.getByTestId("sync-pill").textContent).toMatch(/Synced just now/));
    unmount();

    fetchShared.mockRejectedValue(new Error("fetch failed"));
    render(<SimHome active />);
    await waitFor(() => expect(screen.getByTestId("sync-pill").textContent).toMatch(/Offline — showing this machine only/));
    expect(screen.getByTestId("sync-pill").getAttribute("title")).toMatch(/fetch failed/);
  });

  it("marks the tabs as tabs", async () => {
    listRuns.mockImplementation(async () => []);
    fetchShared.mockResolvedValue([]);
    render(<SimHome active />);
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Launch", "Runs", "Leaderboard"]);
    expect(screen.getByRole("tab", { name: /Runs/ }).getAttribute("aria-selected")).toBe("true");
  });
});
