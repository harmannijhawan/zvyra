import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, Notification: { isSupported: () => false }, safeStorage: { isEncryptionAvailable: () => false } }));

import { defaultSettings } from '../shared/settings';
import type { ModelInfo } from '../shared/types';
import { scoreModel } from '../electron/router/router';
import { estimateParamsB, inferCapabilities, isChatModel } from '../electron/providers/heuristics';

const model = (p: Partial<ModelInfo>): ModelInfo => ({
  id: 'x::m', providerId: 'nvidia', modelId: 'm', displayName: 'M', capabilities: ['chat'], contextLength: 128_000, maxOutput: null,
  freeStatus: 'free_tier', health: 'unknown', streaming: true, enabled: true, paramsB: null, latencyMs: null, tokensPerSec: null,
  calls: 0, successes: 0, failures: 0, consecutiveFailures: 0, lastError: null, lastErrorAt: null, lastSuccessAt: null, lastCheckedAt: null,
  rateLimitedUntil: null, discoveredAt: 0, notes: null, ...p,
});

describe('model router scoring', () => {
  const s = defaultSettings();
  const req = { purpose: 'code' as const, promptTokens: 4000, maxTokens: 4000 };
  it('prefers coding-capable models for coding tasks', () => {
    const coder = model({ id: 'a', capabilities: ['chat', 'coding', 'long_context'], paramsB: 70 });
    const plain = model({ id: 'b', capabilities: ['chat'], paramsB: 70 });
    expect(scoreModel(coder, req, s)).toBeGreaterThan(scoreModel(plain, req, s));
  });
  it('penalizes measured unreliability and slowness', () => {
    const good = model({ calls: 10, successes: 10, health: 'healthy', latencyMs: 800, tokensPerSec: 80, paramsB: 70, capabilities: ['chat', 'coding'] });
    const bad = model({ calls: 10, successes: 3, consecutiveFailures: 3, health: 'degraded', latencyMs: 9000, tokensPerSec: 8, paramsB: 70, capabilities: ['chat', 'coding'] });
    expect(scoreModel(good, req, s)).toBeGreaterThan(scoreModel(bad, req, s));
  });
  it('prefers a fast mid-size model over a huge slow one', () => {
    const huge = model({ paramsB: 550, latencyMs: 5000, tokensPerSec: 15, health: 'healthy', calls: 5, successes: 5, capabilities: ['chat', 'coding', 'reasoning'] });
    const mid = model({ paramsB: 120, latencyMs: 700, tokensPerSec: 90, health: 'healthy', calls: 5, successes: 5, capabilities: ['chat', 'coding', 'reasoning'] });
    expect(scoreModel(mid, req, s)).toBeGreaterThan(scoreModel(huge, req, s));
  });
  it('honors local-first routing', () => {
    const local = model({ providerId: 'ollama', freeStatus: 'local', paramsB: 8, capabilities: ['chat', 'coding', 'fast'] });
    const cloud = model({ paramsB: 8, capabilities: ['chat', 'coding', 'fast'] });
    const lf = { ...s, ai: { ...s.ai, routing: 'local_first' as const } };
    expect(scoreModel(local, { ...req, purpose: 'classify' }, lf)).toBeGreaterThan(scoreModel(cloud, { ...req, purpose: 'classify' }, lf));
  });
  it('starts small fixes efficiently and escalates after failure', () => {
    const small = model({ paramsB: 8, capabilities: ['chat', 'coding', 'long_context'], latencyMs: 500, tokensPerSec: 60 });
    const large = model({ paramsB: 70, capabilities: ['chat', 'coding', 'long_context'], latencyMs: 500, tokensPerSec: 60 });
    const simple = { ...req, complexity: 'small' as const };
    expect(scoreModel(small, simple, s)).toBeGreaterThan(scoreModel(large, simple, s));
    expect(scoreModel(large, { ...simple, escalation: 1 }, s)).toBeGreaterThan(scoreModel(small, { ...simple, escalation: 1 }, s));
  });
  it('rejects models without context headroom', () => {
    const small = model({ contextLength: 4096, capabilities: ['chat', 'coding'] });
    const big = model({ contextLength: 128_000, capabilities: ['chat', 'coding'] });
    expect(scoreModel(big, req, s)).toBeGreaterThan(scoreModel(small, req, s));
  });
});

describe('capability heuristics', () => {
  it('filters non-chat models', () => {
    expect(isChatModel('nvidia/nv-embedqa-mistral-7b-v2')).toBe(false);
    expect(isChatModel('meta/llama-guard-4-12b')).toBe(false);
    expect(isChatModel('deepseek-ai/deepseek-v4.1-flash')).toBe(true);
  });
  it('estimates parameter counts', () => {
    expect(estimateParamsB('nvidia/nemotron-3-super-120b-a12b')).toBe(120);
    expect(estimateParamsB('mistralai/mixtral-8x22b-v0.1')).toBe(176);
    expect(estimateParamsB('some/model')).toBeNull();
  });
  it('infers vision capability', () => {
    expect(inferCapabilities('meta/llama-3.2-90b-vision-instruct')).toContain('vision');
  });
});
