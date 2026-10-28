/**
 * Run `worker` over `items` with at most `limit` in flight. Workers pull from a
 * shared cursor, so a slow item never stalls the rest. Stops handing out new
 * items once `signal` aborts (in-flight ones finish their own abort handling).
 * Resolves when every started worker has settled; a worker that throws is the
 * caller's bug — the pool rethrows the first error after the others settle.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  let firstError: unknown = null;
  async function lane() {
    while (next < items.length) {
      if (signal?.aborted) return;
      const i = next++;
      try {
        await worker(items[i] as T, i);
      } catch (e) {
        if (firstError === null) firstError = e;
      }
    }
  }
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane);
  await Promise.all(lanes);
  if (firstError !== null) throw firstError;
}
