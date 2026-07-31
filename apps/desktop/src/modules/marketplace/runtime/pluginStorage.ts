// The plugin data vault's key layout, in one place so the runtime (which writes
// it) and uninstall (which purges it) can never disagree.
//
// Keys are namespaced by USER id as well as plugin id. Before that they were keyed
// by plugin id alone, which on a shared shop machine meant member A's plugin config
// survived both uninstall AND sign-out and was read back verbatim by member B on
// the next sign-in — and permanently ate A's 1 MB per-plugin quota. Per-user keys
// follow the established convention for user-scoped localStorage in this app (see
// modules/pm/lib/workspace-snapshot.ts `helios:pm:workspaceSnapshot:<userId>`), and
// they also make sign-out safe for free: a different user simply reads a different
// namespace, so nothing needs to be wiped on the way out.

const STORAGE_PREFIX = "helios:plugin-storage:";

/** Key prefix owning every value one user's copy of one plugin may store. */
export function pluginStorageNamespace(userId: string, pluginId: string): string {
  return `${STORAGE_PREFIX}${userId}:${pluginId}:`;
}

/** Every key currently under a namespace. Snapshotted into an array first because
 *  removing while iterating `localStorage.key(i)` re-indexes the store. */
export function pluginStorageKeys(ns: string): string[] {
  if (typeof localStorage === "undefined") return [];
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(ns)) keys.push(k);
  }
  return keys;
}

/** The pre-namespacing key prefix: `helios:plugin-storage:<pluginId>:`. Still has
 *  live data behind it — chassis.coast, engine.boreas and rf.aether shipped under
 *  it — so it can't simply be abandoned. A user id is a UUID and a plugin id is
 *  dotted/dashed, so a legacy key can never be mistaken for a namespaced one. */
function legacyPluginStorageNamespace(pluginId: string): string {
  return `${STORAGE_PREFIX}${pluginId}:`;
}

/**
 * Move any pre-namespacing values into `userId`'s namespace, once.
 *
 * Without this, namespacing silently wipes every member's saved add-on settings
 * on update (the new namespace is empty) and strands the old keys forever, since
 * nothing reads or purges them. Whoever opens the plugin first on a given machine
 * inherits the legacy data — which matches the old behaviour exactly, because the
 * old bucket was shared by every user of that machine anyway.
 *
 * Idempotent: legacy keys are removed as they're migrated, and an existing
 * namespaced value always wins over the legacy one.
 */
export function migrateLegacyPluginStorage(userId: string, pluginId: string): void {
  if (typeof localStorage === "undefined" || !userId) return;
  const legacy = legacyPluginStorageNamespace(pluginId);
  const ns = pluginStorageNamespace(userId, pluginId);
  for (const k of pluginStorageKeys(legacy)) {
    const suffix = k.slice(legacy.length);
    const value = localStorage.getItem(k);
    if (value !== null && localStorage.getItem(ns + suffix) === null) {
      try {
        localStorage.setItem(ns + suffix, value);
      } catch {
        // Quota — leave the legacy key in place rather than losing the data.
        continue;
      }
    }
    localStorage.removeItem(k);
  }
}

/** Drop everything a user's copy of a plugin stored. Called on uninstall, so the
 *  add-on's data really is gone (which is what the uninstall confirmation says).
 *  Sweeps the legacy bucket too — otherwise "its stored data is erased" would be
 *  a lie for anyone who never opened the plugin after updating. */
export function purgePluginStorage(userId: string, pluginId: string): void {
  if (typeof localStorage === "undefined") return;
  const keys = [
    ...(userId ? pluginStorageKeys(pluginStorageNamespace(userId, pluginId)) : []),
    ...pluginStorageKeys(legacyPluginStorageNamespace(pluginId)),
  ];
  for (const k of keys) localStorage.removeItem(k);
}
