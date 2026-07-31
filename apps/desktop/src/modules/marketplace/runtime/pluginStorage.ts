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

/** Drop everything a user's copy of a plugin stored. Called on uninstall, so the
 *  add-on's data really is gone (which is what the uninstall confirmation says). */
export function purgePluginStorage(userId: string, pluginId: string): void {
  if (typeof localStorage === "undefined" || !userId) return;
  for (const k of pluginStorageKeys(pluginStorageNamespace(userId, pluginId))) {
    localStorage.removeItem(k);
  }
}
