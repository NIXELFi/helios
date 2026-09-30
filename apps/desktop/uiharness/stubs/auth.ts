// Harness stub for @helios/auth. Not shipped — see uiharness/README.

const v = (
  plugin_id: string,
  name: string,
  subteam: string,
  version: string,
  review_status: string,
  published_at: string,
  extra: Record<string, unknown> = {},
) => ({
  plugin_id,
  name,
  subteam,
  is_recommended: plugin_id === "aero.downforce-calculator",
  latest_version: plugin_id === "aero.downforce-calculator" ? "1.2.0" : null,
  version,
  manifest: {},
  permissions: ["storage"],
  review_status,
  review_notes: null,
  reviewed_at: null,
  bundle_bytes: 184320,
  published_by: "reviewer-1",
  published_at,
  ...extra,
});

const MY_VERSIONS = [
  v("aero.downforce-calculator", "Downforce Calculator", "s1", "1.3.0", "pending", "2026-08-26T09:00:00Z"),
  v("aero.downforce-calculator", "Downforce Calculator", "s1", "1.2.1", "rejected", "2026-08-20T09:00:00Z", {
    review_notes: "The storage permission is declared but never used. Drop it and resubmit.",
    published_by: "author-2",
  }),
  v("aero.downforce-calculator", "Downforce Calculator", "s1", "1.2.0", "approved", "2026-07-14T10:00:00Z"),
  v("aero.downforce-calculator", "Downforce Calculator", "s1", "1.1.0", "yanked", "2026-06-30T10:00:00Z", {
    review_notes: "Yanked by the author: wrong air density constant",
  }),
  v("chassis.bolt-torque", "Bolt Torque Table", "s2", "0.4.0", "withdrawn", "2026-08-25T16:30:00Z", {
    published_by: "author-2",
  }),
];

export function useUser() {
  return { id: "reviewer-1", email: "lead@example.com" };
}

// One client for the whole harness, like the real provider's context value. A
// fresh object per call re-runs every data hook's fetch effect forever.
export function useSupabaseClient() {
  return CLIENT;
}

const CLIENT = {
    schema: () => ({
      rpc: (fn: string) => {
        if (fn === "my_published_plugins") return Promise.resolve({ data: MY_VERSIONS, error: null });
        if (fn === "publish_plugin_version")
          return Promise.resolve({
            data: [
              {
                plugin_id: "aero.downforce-calculator",
                version: "1.3.0",
                review_status: "pending",
              },
            ],
            error: null,
          });
        return Promise.resolve({ data: [], error: null });
      },
    }),
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ data: { path: "x" }, error: null }),
        createSignedUrl: () => Promise.resolve({ data: { signedUrl: "about:blank" }, error: null }),
      }),
    },
  };
