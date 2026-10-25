/** Ordered, bounded work; no new work starts after cancellation or a failed worker. */
export async function mapBounded<T, R>(items: readonly T[], concurrency: number, work: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  let failed = false
  let failure: unknown
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, Math.floor(concurrency))) }, async () => {
    while (!failed) {
      try {
        signal?.throwIfAborted()
        const index = next++
        if (index >= items.length) return
        results[index] = await work(items[index], index)
      } catch (error) { failed = true; failure = error }
    }
  }))
  if (failed) throw failure
  return results
}
