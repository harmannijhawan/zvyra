// Router regression tests: quota exhaustion, context overflow, switching/cooldowns, affinity, permanent errors.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelInfo } from '../shared/types';
import { defaultSettings } from '../shared/settings';

const fx = vi.hoisted(() => ({ chat: vi.fn(), models: [] as ModelInfo[], failure: vi.fn(), next: null as number | null }));
vi.mock('electron', () => ({ Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../electron/providers/registry', () => ({
  getRegistryRevision: () => Math.random(), listModels: () => fx.models, usable: () => true, nextAvailability: () => fx.next,
  adapter: (id: string) => ({ id, kind: 'cloud', chat: (_c: unknown, model: string, req: unknown) => fx.chat(id, model, req) }),
  providerConfig: () => ({ apiKey: 'k', baseUrl: 'https://x', accountId: null }), recordSuccess: vi.fn(), recordFailure: fx.failure,
}));
vi.mock('../electron/core/settings', () => ({ getSettings: () => defaultSettings() }));

import { initDb } from '../electron/core/db';
import { complete, NoModelError, rankModels } from '../electron/router/router';
import { ProviderError } from '../electron/providers/types';
import { bodyRetryMs, classifyHttp } from '../electron/providers/http';

const ok = (text = 'OK') => ({ text, promptTokens: 1, completionTokens: 1, finishReason: 'stop', latencyMs: 3, ttftMs: 1, usageEstimated: false });
const info = (providerId: string, modelId: string, p: Partial<ModelInfo> = {}): ModelInfo => ({ id: `${providerId}::${modelId}`, providerId, modelId, displayName: modelId, capabilities: ['chat', 'coding'], contextLength: 32000, maxOutput: 4096, paramsB: 70, calls: 10, successes: 10, failures: 0, consecutiveFailures: 0, health: 'healthy', enabled: true, freeStatus: 'free_tier', latencyMs: 500, tokensPerSec: 60, ...p } as ModelInfo);
const run = (extra: Record<string, unknown> = {}, messages = [{ role: 'user' as const, content: 'hi' }]) => complete({ route: { purpose: 'code', ...extra }, messages, scope: {}, signal: new AbortController().signal, quiet: true, stream: false });

beforeEach(() => {
  initDb(path.join(mkdtempSync(path.join(tmpdir(), 'swarm-router-')), 'test.db'));
  fx.chat.mockReset(); fx.failure.mockReset(); fx.next = null;
});

describe('quota exhaustion', () => {
  it('tries each provider once, then stops with a quota category and the earliest retry time', async () => {
    fx.models = [info('groq', 'a'), info('groq', 'b'), info('google', 'g'), info('google', 'h')];
    fx.next = Date.now() + 90_000;
    fx.chat.mockImplementation(async () => { throw new ProviderError('quota', 'Quota unavailable (429)', 429, 3_600_000); });
    const err = await run().catch(e => e);
    expect(err).toBeInstanceOf(NoModelError);
    expect(err.category).toBe('quota');
    expect(err.retryAt).toBe(fx.next);
    // One model per provider: the rest of an exhausted provider is skipped, not cycled through.
    expect(new Set(fx.chat.mock.calls.map(c => c[0]))).toEqual(new Set(['groq', 'google']));
    expect(fx.chat).toHaveBeenCalledTimes(2);
  });
  it('reports a pure cooldown before any attempt with a retry time instead of "no provider"', async () => {
    fx.models = [];
    fx.next = Date.now() + 30_000;
    const err = await run().catch(e => e);
    expect(err.category).toBe('rate_limit');
    expect(err.retryAt).toBe(fx.next);
  });
});

describe('context overflow', () => {
  it('only retries on models with a larger context window and stops after two overflows', async () => {
    fx.models = [info('groq', 'small', { contextLength: 16000, latencyMs: 100 }), info('mistral', 'same', { contextLength: 16000, latencyMs: 200 }), info('google', 'big', { contextLength: 1_000_000, latencyMs: 5000 })];
    fx.chat.mockImplementation(async (provider: string) => { if (provider !== 'google') throw new ProviderError('context', 'Context overflow (400)', 400); return ok('fits'); });
    const r = await run();
    expect(r.model.modelId).toBe('big');
    // The other 16k model would overflow too, so it is never tried.
    expect(fx.chat.mock.calls.map(c => c[1])).toEqual(['small', 'big']);
  });
  it('raises a context-category error so the caller can shrink the prompt', async () => {
    fx.models = [info('groq', 'a', { contextLength: 16000 }), info('google', 'b', { contextLength: 64000 }), info('mistral', 'c', { contextLength: 200000 })];
    fx.chat.mockImplementation(async () => { throw new ProviderError('context', 'Context overflow (413)', 413); });
    const err = await run().catch(e => e);
    expect(err.category).toBe('context');
    expect(fx.chat).toHaveBeenCalledTimes(2);
  });
});

describe('switching, affinity and permanent errors', () => {
  it('keeps the preferred (working) model even when another scores higher or its provider is busy', () => {
    fx.models = [info('groq', 'fast', { latencyMs: 100, tokensPerSec: 300 }), info('nvidia', 'slower', { latencyMs: 2000, tokensPerSec: 30 })];
    const req = { purpose: 'code' as const, promptTokens: 100, maxTokens: 1000 };
    expect(rankModels(req)[0].model.modelId).toBe('fast');
    expect(rankModels({ ...req, preferred: 'nvidia::slower' })[0].model.modelId).toBe('slower');
  });
  it('switches providers on a transient outage after one same-model retry', async () => {
    fx.models = [info('groq', 'a'), info('google', 'g', { latencyMs: 3000 })];
    fx.chat.mockImplementation(async (p: string) => { if (p === 'groq') throw new ProviderError('server', 'down', 503); return ok(); });
    const r = await run();
    expect(fx.chat.mock.calls.map(c => c[0])).toEqual(['groq', 'groq', 'google']);
    expect(r.model.providerId).toBe('google');
  });
  it('does not retry a permanently rejected request beyond two models', async () => {
    fx.models = [info('groq', 'a'), info('google', 'g'), info('mistral', 'm')];
    fx.chat.mockImplementation(async () => { throw new ProviderError('bad_request', 'invalid'); });
    const err = await run().catch(e => e);
    expect(err.category).toBe('invalid_request');
    expect(fx.chat).toHaveBeenCalledTimes(2);
  });
  it('stops after three malformed outputs', async () => {
    fx.models = Array.from({ length: 6 }, (_, i) => info('p' + i, 'm'));
    fx.chat.mockImplementation(async () => ok('not json'));
    const err = await complete({ route: { purpose: 'plan' }, messages: [{ role: 'user', content: 'x' }], scope: {}, signal: new AbortController().signal, quiet: true, stream: false, validate: () => { throw new Error('bad'); } }).catch(e => e);
    expect(err.category).toBe('malformed_output');
    expect(fx.chat).toHaveBeenCalledTimes(3);
  });
});

describe('provider error classification', () => {
  it('treats daily/plan quotas as quota (not a 60 s rate limit) and honours body retry hints', () => {
    expect(classifyHttp(429, '{"error":{"message":"You exceeded your current quota, please check your plan and billing details."}}').kind).toBe('quota');
    expect(classifyHttp(429, 'Rate limit reached for model on tokens per day (TPD): Limit 100000. Please try again in 7m12.5s.').kind).toBe('quota');
    const tpm = classifyHttp(429, 'Rate limit reached on requests per minute. Please try again in 2.5s');
    expect(tpm.kind).toBe('rate_limit');
    expect(tpm.retryAfterMs).toBe(2500);
    expect(bodyRetryMs('"retrydelay": "34s"')).toBe(34_000);
    expect(bodyRetryMs('try again in 7m12.5s')).toBe(432_500);
    expect(bodyRetryMs('retry in 500ms')).toBe(500);
  });
});
