// The on-disk sync status of a vault file relative to the local folder. The
// LocalStatusBadge component that once rendered this was dead — FileTable's
// inline status PILL is the only live renderer of vault status (it owns the
// single shared palette + label map, closing V14). Only the TYPE survives
// here because data/local-match.ts imports it.
export type LocalStatus = "synced" | "modified" | "vault-only" | "no-folder";
