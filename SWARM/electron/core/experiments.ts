import { complete } from '../router/router';
import { db } from './db';

const cases = [
  { prompt: 'Return only the integer result of 37 * 19.', expected: '703' },
  { prompt: 'Sort these words alphabetically, return only comma-separated words without spaces: zebra, apple, mango.', expected: 'apple,mango,zebra' },
  { prompt: 'Return only valid compact JSON for an object with key ok and boolean value true.', expected: '{"ok":true}' },
];
let controller: AbortController | null = null;
export function cancelExperiment() { controller?.abort(); }

/** Controlled synthetic workload. Results do not establish coding quality. */
export async function runRoutingExperiment() {
  if (controller) throw new Error('An experiment is already running');
  const ctrl = new AbortController(); controller = ctrl;
  const rows = [];
  try {
    for (const strategy of ['auto', 'fastest', 'quality'] as const) {
      const row = { strategy, cases: cases.length, correct: 0, failures: 0, calls: 0, tokens: 0, latencyMs: 0, models: [] as string[], errors: [] as string[] };
      for (const test of cases) {
        if (ctrl.signal.aborted) throw new Error('Experiment cancelled');
        const start = Date.now();
        try {
          const r = await complete({ isolatedExperiment: true, routingOverride: strategy, route: { purpose: 'classify', maxTokens: 128 }, messages: [{ role: 'user', content: test.prompt }], scope: {}, signal: ctrl.signal, temperature: 0, quiet: true, stream: false,
            onAttempt: () => { row.calls++; } });
          row.correct += Number(r.text.trim() === test.expected);
          row.tokens += r.result.promptTokens + r.result.completionTokens;
          row.models.push(r.model.id);
        } catch (e) { if (ctrl.signal.aborted) throw e; row.failures++; row.errors.push(String(e).slice(0, 200)); }
        row.latencyMs += Date.now() - start;
      }
      rows.push(row);
    }
    const result = { ts: Date.now(), workload: 'Three synthetic instruction-following checks per strategy; not a coding-quality benchmark. Sequential runs can be affected by provider load. Health learning is disabled; provider quota and authentication restrictions still apply. Tokens exclude unreported failed-request usage.', rows, productionChanged: false };
    db().cacheSet('experiment:last', JSON.stringify(result));
    return result;
  } finally { if (controller === ctrl) controller = null; }
}
