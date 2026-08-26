// Harness stub for @helios/auth. Not shipped — see uiharness/README.

const MY_VERSIONS = [
  {
    plugin_id: "aero.downforce-calculator",
    subteam: "s1",
    version: "1.2.0",
    permissions: ["storage"],
    review_status: "approved",
    published_at: "2026-07-14T10:00:00Z",
  },
];

export function useUser() {
  return { id: "reviewer-1", email: "lead@example.com" };
}

export function useSupabaseClient() {
  return {
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
}
