import { performance } from 'node:perf_hooks';

export type Timing = 'schedule' | 'graph' | 'route' | 'model' | 'fallback' | 'message' | 'checkpoint' | 'filesystem' | 'process' | 'preview' | 'browser' | 'test' | 'ui' | 'toolchain';
type Sample = { count: number; totalMs: number; maxMs: number; lastMs: number };
const samples = new Map<string, Map<Timing, Sample>>();
const operations = new Map<string, number>();

/** Bounded aggregates, no logs or renderer work per sample. */
export function recordTiming(kind: Timing, ms: number, runId = 'application') {
  let run = samples.get(runId);
  if (!run) {
    if (samples.size >= 100) samples.delete(samples.keys().next().value!);
    samples.set(runId, run = new Map());
  }
  const old = run.get(kind) ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
  run.set(kind, { count: old.count + 1, totalMs: old.totalMs + ms, maxMs: Math.max(old.maxMs, ms), lastMs: ms });
}
export function timeOperation(kind: Timing, runId?: string) {
  const start = performance.now();
  let ended = false;
  if (runId) operations.set(runId, (operations.get(runId) ?? 0) + 1);
  return () => {
    if (ended) return;
    ended = true;
    if (runId) {
      const remaining = (operations.get(runId) ?? 1) - 1;
      if (remaining) operations.set(runId, remaining); else operations.delete(runId);
    }
    recordTiming(kind, performance.now() - start, runId);
  };
}
export function hasActiveOperations(runId: string) { return (operations.get(runId) ?? 0) > 0; }
export function performanceSnapshot(runId = 'application') {
  return Object.fromEntries([...(samples.get(runId) ?? [])].map(([kind, s]) => [kind, { ...s, meanMs: s.totalMs / s.count }]));
}
