import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { managedRequest } from './sync';
import type { CompleteOptions, CompleteResult } from '../router/router';
import type { ModelInfo } from '../../shared/types';

const context = new AsyncLocalStorage<string>();
const operations = new Map<string, Promise<unknown>>();
const queues = new Map<string, Promise<unknown>>();
async function queuedRequest(id: string, fn: () => Promise<any>) {
  const previous = queues.get(id) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(fn);
  queues.set(id, pending);
  try { return await pending; } finally { if (queues.get(id) === pending) queues.delete(id); }
}
export function withManagedChat<T>(id: string, fn: () => Promise<T>) {
  return context.run(id, async () => { let success=false;try { const result=await fn();success=true;return result; } finally { await finishManagedOperation(id,success); } });
}
export async function finishManagedOperation(id: string, success = false) {
  if (!operations.has(id)) return;
  try { await managedRequest('managed/finish', { id, success }); } catch { /* Server expiry preserves the cost boundary after connection loss. */ }
  operations.delete(id);
}
export function managedModel(model: any): ModelInfo {
  return { id: 'managed::' + model.id, modelId: model.id, providerId: 'managed', displayName: model.displayName,
    capabilities: model.capabilities || ['chat','coding'], contextLength: model.contextLength || 32768, maxOutput: 4096,
    freeStatus: 'free_tier', health: 'unknown', streaming: false, enabled: true, paramsB: null, latencyMs: null,
    tokensPerSec: null, calls: 0, successes: 0, failures: 0, consecutiveFailures: 0, lastError: null,
    lastErrorAt: null, lastSuccessAt: null, lastCheckedAt: null, rateLimitedUntil: null, discoveredAt: Date.now(), notes: 'Uses SWARM server-managed providers. Availability is checked by the backend for each request.' };
}
export async function managedComplete<T>(opts: CompleteOptions<T>): Promise<CompleteResult<T>> {
  const chatId = context.getStore();
  const id = chatId || opts.scope.runId || randomUUID();
  const standalone = !opts.scope.runId && !context.getStore();
  if (!operations.has(id)) operations.set(id, managedRequest('managed/operation', { id, kind: !chatId && opts.scope.runId ? 'build' : 'chat' }, opts.signal).catch(error => { operations.delete(id); throw error; }));
  await operations.get(id);
  let success=false;
  try {
    const attempts: CompleteResult<T>['attempts'] = [];
    for (let validationAttempt = 0; validationAttempt < 2; validationAttempt++) {
      opts.signal.throwIfAborted();
      const response = await queuedRequest(id, () => {
        opts.signal.throwIfAborted();
        return managedRequest('managed/complete', { operationId: id, requestId: randomUUID(), messages: opts.messages, pinned: opts.route.pinned?.replace(/^managed::/,''), needs: opts.route.needs, purpose: opts.route.purpose, maxTokens: opts.route.maxTokens, json: opts.json }, opts.signal);
      });
      const model = managedModel(response.model), result = response.result;
      opts.onRequest?.(model);
      let value: T;
      try { value = opts.validate ? opts.validate(result.text, result) : result.text as T; }
      catch (error) {
        attempts.push({modelId:model.id,ok:false,error:'The response did not meet the requested format.'});
        opts.onReset?.();
        if (validationAttempt === 1) throw error;
        continue;
      }
      opts.onToken?.(result.text);
      opts.onAttempt?.({ model, ok: true });
      attempts.push({modelId:model.id,ok:true});
      success=true;
      return { text: result.text, value, model, result, attempts, recovered: validationAttempt > 0 || response.recovered === true };
    }
    throw new Error('SWARM could not produce a valid response.');
  } finally { if (standalone) await finishManagedOperation(id,success); }
}
