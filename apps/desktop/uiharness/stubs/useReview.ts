// Harness stub for the reviewer data hooks.
export type ReviewItem = {
  pluginId: string; name: string; subteam: string | null; version: string;
  manifest: Record<string, unknown>; permissions: string[]; reviewReport: unknown;
  bundleSha256: string; bundleBytes: number; publishedBy: string; publishedAt: string;
};
const QUEUE: ReviewItem[] = [
  {
    pluginId: "aero.downforce-calculator",
    name: "Downforce Calculator",
    subteam: "s1",
    version: "1.3.0",
    manifest: { description: "Computes downforce and centre of pressure from speed and aero coefficients." },
    permissions: ["storage", "engine:matlab"],
    reviewReport: null,
    bundleSha256: "9f2c1b7e4d5a6c8f0e1d2b3a4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f",
    bundleBytes: 184320,
    publishedBy: "author-1",
    publishedAt: "2026-08-26T09:00:00Z",
  },
  {
    pluginId: "chassis.bolt-torque",
    name: "Bolt Torque Table",
    subteam: "s2",
    version: "0.4.0",
    manifest: { description: "Preload and torque for the fastener stack, per material pair." },
    permissions: [],
    reviewReport: null,
    bundleSha256: "b".repeat(64),
    bundleBytes: 22016,
    publishedBy: "reviewer-1",
    publishedAt: "2026-08-25T16:30:00Z",
  },
];
export function useReviewQueue() {
  return { loading: false, error: null, queue: QUEUE, refetch: () => {} };
}
export function useReviewInspect() {
  return { inspect: () => Promise.resolve(), reports: {}, inspecting: null, error: null };
}
export function useReviewPreview() {
  return { preview: () => Promise.resolve(), previewing: null, error: null };
}
export function useReviewVersion() {
  return { review: () => Promise.resolve(), reviewing: false, error: null };
}
