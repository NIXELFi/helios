// The capability catalog — the single source of truth shared by the SDK client,
// the host broker, the compliance validator, and the authoring docs. Adding a
// capability here is the ONLY place a new "door" through the sandbox is defined.

/** A declarable permission key. DEFAULT-DENY: a plugin may only use a capability
 *  whose key it lists in `manifest.permissions`. */
export type PermissionKey = "file.read" | "file.write" | "storage" | "engine:matlab";

export const ALL_PERMISSIONS: readonly PermissionKey[] = [
  "file.read",
  "file.write",
  "storage",
  "engine:matlab",
];

/** 0 = always available (nothing sensitive). 1 = low-trust (user-mediated or
 *  sandbox-scoped; near-auto-approvable). 2 = high-trust (reaches outside the
 *  sandbox; needs explicit user consent + human review). */
export type Tier = 0 | 1 | 2;

export interface CapabilityInfo {
  /** RPC methods this permission unlocks. */
  methods: readonly string[];
  tier: Tier;
  /** One-line description shown at install time and in the authoring docs. */
  description: string;
}

export const CAPABILITIES: Record<PermissionKey, CapabilityInfo> = {
  "file.read": {
    methods: ["file.read"],
    tier: 1,
    description:
      "Read a file the user explicitly picks (e.g. from the vault). No directory listing or filesystem access.",
  },
  "file.write": {
    methods: ["file.write"],
    tier: 1,
    description: "Save a result file via a user-confirmed save dialog.",
  },
  storage: {
    methods: ["storage.get", "storage.set", "storage.keys", "storage.delete"],
    tier: 1,
    description: "Private, plugin-scoped key-value storage for settings and inputs.",
  },
  "engine:matlab": {
    methods: ["engine.matlab.run"],
    tier: 2,
    description:
      "Run MATLAB programs on this computer using its local MATLAB license. Runs native code with your privileges.",
  },
};

/** Methods that need no permission (Tier 0 — always available). */
export const TIER0_METHODS: readonly string[] = ["host.log", "host.notify", "host.getContext"];

/** True if `method` is a known, brokerable method at all. */
export function isKnownMethod(method: string): boolean {
  if (TIER0_METHODS.includes(method)) return true;
  return ALL_PERMISSIONS.some((k) => CAPABILITIES[k].methods.includes(method));
}

/** The permission a method requires, or `null` for Tier-0 / unknown methods.
 *  Callers should check {@link isKnownMethod} first to distinguish the two. */
export function permissionForMethod(method: string): PermissionKey | null {
  if (TIER0_METHODS.includes(method)) return null;
  for (const key of ALL_PERMISSIONS) {
    if (CAPABILITIES[key].methods.includes(method)) return key;
  }
  return null;
}

/** The trust tier a method runs at (Tier 0 if it needs no permission). */
export function tierForMethod(method: string): Tier {
  const key = permissionForMethod(method);
  return key === null ? 0 : CAPABILITIES[key].tier;
}
