// Real model registry: provider-wide cooldowns and unsuitable-model filtering.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelInfo } from '../shared/types';

vi.mock('electron', () => ({ Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] }, safeStorage: { isEncryptionAvailable: () => false } }));
import { db, initDb } from '../electron/core/db';
import { loadRegistry, providerCooldown, recordFailure, getModel, resetProviderCooldowns } from '../electron/providers/registry';
import { isChatModel } from '../electron/providers/heuristics';

const model = (providerId: string, modelId: string): ModelInfo => ({ id: `${providerId}::${modelId}`, providerId, modelId, displayName: modelId, capabilities: ['chat', 'coding'], contextLength: 32000, maxOutput: 4096, freeStatus: 'free_tier', health: 'healthy', streaming: true, enabled: true, paramsB: 70, latencyMs: null, tokensPerSec: null, calls: 0, successes: 0, failures: 0, consecutiveFailures: 0, lastError: null, lastErrorAt: null, lastSuccessAt: null, lastCheckedAt: null, rateLimitedUntil: null, discoveredAt: 0, notes: null });

describe('provider-level cooldowns', () => {
  it('cools down the whole provider after two different models hit quota, honouring retry-after', () => {
    initDb(path.join(mkdtempSync(path.join(tmpdir(), 'swarm-reg-')), 'test.db'));
    resetProviderCooldowns();
    for (const m of [model('groq', 'a'), model('groq', 'b'), model('groq', 'c')]) db().put('models', m.id, m, { provider_id: m.providerId });
    loadRegistry();
    recordFailure('groq::a', 'quota', 'quota', 2 * 60 * 60_000);
    expect(providerCooldown('groq')).toBeNull(); // one model is not evidence of a provider-wide limit
    expect(getModel('groq::a')!.rateLimitedUntil! - Date.now()).toBeGreaterThan(110 * 60_000); // provider retry-after respected
    recordFailure('groq::b', 'quota', 'quota');
    const c = providerCooldown('groq');
    expect(c?.kind).toBe('quota');
    expect(c!.until - Date.now()).toBeGreaterThan(14 * 60_000);
  });
  it('excludes fill-in-the-middle and robotics models from agent routing', () => {
    expect(isChatModel('mistral-code-fim-latest')).toBe(false);
    expect(isChatModel('codestral-fim-2501')).toBe(false);
    expect(isChatModel('gemini-robotics-er-2-preview')).toBe(false);
    expect(isChatModel('mistral-large-latest')).toBe(true);
    expect(isChatModel('nvidia/nemotron-3-super-120b-a12b')).toBe(true);
  });
});
