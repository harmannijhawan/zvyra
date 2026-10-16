// Stand-in for electron/research/search.ts: latency is controlled by the bench via globalThis.__searchDelayMs.
export async function webSearch(_q: string, _s: unknown, signal?: AbortSignal) {
  const delay = Number((globalThis as { __searchDelayMs?: number }).__searchDelayMs ?? 300);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, delay);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
  return { results: [{ url: 'https://example.com/a', title: 'A', snippet: 'evidence' }], engine: 'stub', errors: [] as string[] };
}
