// Immutable dot-path get/set/delete on plain JSON-shaped objects.
// Used by the editor reducer to update LoadedConfig.raw without
// mutating the savedSnapshot.

export function getAt(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function setAt<T>(obj: T, path: string, value: unknown): T {
  const parts = path.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const root: any = Array.isArray(obj) ? [...(obj as unknown as unknown[])] : { ...(obj as object) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const next = cur[k];
    if (Array.isArray(next)) cur[k] = [...next];
    else if (next && typeof next === "object") cur[k] = { ...next };
    else cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]!] = value;
  return root as T;
}

export function deleteAt<T>(obj: T, path: string): T {
  const parts = path.split(".");
  if (parts.length === 1) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const next: any = { ...(obj as object) };
    delete next[parts[0]!];
    return next as T;
  }
  const headPath = parts.slice(0, -1).join(".");
  const parent = getAt(obj, headPath);
  if (parent == null || typeof parent !== "object") return obj;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nextParent: any = Array.isArray(parent) ? [...(parent as unknown[])] : { ...parent };
  delete nextParent[parts[parts.length - 1]!];
  return setAt(obj, headPath, nextParent);
}
