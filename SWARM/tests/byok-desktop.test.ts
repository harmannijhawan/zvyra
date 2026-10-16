import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelInfo } from '../shared/types';
import { defaultSettings, SettingsSchema } from '../shared/settings';

const fx = vi.hoisted(() => ({ chat: vi.fn(), models: [] as ModelInfo[], failure: vi.fn(), success: vi.fn() }));
vi.mock('electron', () => ({ Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../electron/providers/registry', () => ({
  getRegistryRevision: () => Math.random(), listModels: () => fx.models, usable: () => true, nextAvailability: () => null,
  adapter: (id: string) => ({ id, kind: 'cloud', chat: (cfg: unknown, model: string, req: unknown) => fx.chat(id, model, req) }),
  providerConfig: () => ({ apiKey: 'k', baseUrl: 'https://x', accountId: null }), recordSuccess: fx.success, recordFailure: fx.failure,
}));
vi.mock('../electron/core/settings', () => ({ getSettings: () => defaultSettings() }));

import { initDb } from '../electron/core/db';
import { complete, NoModelError } from '../electron/router/router';
import { ProviderError, type DiscoveredModel, type ProviderAdapter } from '../electron/providers/types';
import { classifyHttp } from '../electron/providers/http';
import { PROVIDER_CATALOG, STATUS_LABEL, formatHint, keyPageUrl, probeCandidates, sanitize, statusForError, testConnection } from '../electron/providers/connection';
import { parseActions } from '../electron/agents/protocol';
import { globToRegExp, searchProject } from '../electron/tools/search';

const ok = (text = 'OK') => ({ text, promptTokens: 1, completionTokens: 1, finishReason: 'stop', latencyMs: 3, ttftMs: 1, usageEstimated: false });
const dm = (modelId: string, freeStatus: DiscoveredModel['freeStatus'] = 'free_tier'): DiscoveredModel => ({ modelId, displayName: modelId, capabilities: ['chat'], contextLength: 8192, maxOutput: null, freeStatus });
const adapterOf = (id: string, discover: () => Promise<DiscoveredModel[]>, chat: (model: string) => Promise<ReturnType<typeof ok>>) =>
  ({ id, name: id, kind: 'cloud', requiresKey: true, needsAccountId: false, defaultBaseUrl: 'https://example.invalid/v1', signupUrl: '', freeNotes: '', publicDiscovery: false,
    discover: async () => discover(), chat: async (_c: unknown, model: string) => chat(model) }) as unknown as ProviderAdapter;
const cfg = { apiKey: 'gsk_test_secret_value_1234', baseUrl: 'https://example.invalid/v1', accountId: null };
const info = (providerId: string, modelId: string): ModelInfo => ({ id: `${providerId}::${modelId}`, providerId, modelId, displayName: modelId, capabilities: ['chat', 'coding'], contextLength: 32000, maxOutput: 4096, paramsB: 8, calls: 0, successes: 0, failures: 0, consecutiveFailures: 0, health: 'healthy', enabled: true, freeStatus: 'free_tier' } as ModelInfo);

beforeEach(() => {
  initDb(path.join(mkdtempSync(path.join(tmpdir(), 'swarm-byok-')), 'test.db'));
  fx.chat.mockReset(); fx.failure.mockReset(); fx.success.mockReset();
});

describe('provider onboarding', () => {
  it('opens only the official, hard-coded key pages', () => {
    expect(Object.fromEntries(PROVIDER_CATALOG.map((p) => [p.id, p.keyUrl]))).toEqual({
      google: 'https://aistudio.google.com/apikey', groq: 'https://console.groq.com/keys', mistral: 'https://console.mistral.ai/',
      huggingface: 'https://huggingface.co/settings/tokens', nvidia: 'https://build.nvidia.com/', openrouter: 'https://openrouter.ai/keys',
    });
    expect(keyPageUrl('https://evil.example')).toBeNull();
    expect(keyPageUrl('managed')).toBeNull();
  });
  it('classifies every failure into the shared status vocabulary', () => {
    const gemini = classifyHttp(400, '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}');
    expect(statusForError(gemini)).toBe('auth_failed');
    expect(statusForError(classifyHttp(401, ''))).toBe('auth_failed');
    expect(statusForError(classifyHttp(429, 'slow'))).toBe('rate_limited');
    expect(statusForError(classifyHttp(429, 'insufficient_quota'))).toBe('rate_limited');
    expect(statusForError(classifyHttp(503, ''))).toBe('network_error');
    expect(statusForError(new Error('x'))).toBe('network_error');
    expect(classifyHttp(400, 'missing field').kind).toBe('bad_request');
    expect(STATUS_LABEL.no_models).toBe('No compatible models available');
  });
  it('stops at a rejected key without sending a chat request', async () => {
    const chat = vi.fn(async () => ok());
    const r = await testConnection(adapterOf('groq', async () => { throw new ProviderError('auth', 'no', 401); }, chat), cfg, new AbortController().signal);
    expect(r.status).toBe('auth_failed'); expect(chat).not.toHaveBeenCalled(); expect(r.message).not.toContain(cfg.apiKey);
  });
  it('reports zero models as no compatible models', async () => {
    expect((await testConnection(adapterOf('groq', async () => [], async () => ok()), cfg, new AbortController().signal)).status).toBe('no_models');
  });
  it('probes at most three small models and names the one that answered', async () => {
    const tried: string[] = [];
    const models = ['llama-70b', 'a', 'b', 'c', 'gemma-mini'].map((m) => dm(m));
    const none = await testConnection(adapterOf('groq', async () => models, async (m) => { tried.push(m); throw new ProviderError('not_found', 'gone', 404); }), cfg, new AbortController().signal);
    expect(tried).toHaveLength(3); expect(tried[0]).toBe('gemma-mini'); expect(none.status).toBe('no_models');
    const yes = await testConnection(adapterOf('groq', async () => models, async () => ok()), cfg, new AbortController().signal);
    expect(yes).toMatchObject({ status: 'connected', label: 'Connected', usableModel: 'gemma-mini', models: 5 });
  });
  it('ends the test on a rate limit and reports the wait', async () => {
    const chat = vi.fn(async () => { throw new ProviderError('rate_limit', 'slow', 429, 3000); });
    const r = await testConnection(adapterOf('groq', async () => [dm('a-mini'), dm('b-mini')], chat), cfg, new AbortController().signal);
    expect(r.status).toBe('rate_limited'); expect(chat).toHaveBeenCalledTimes(1); expect(r.message).toMatch(/3 s/);
  });
  it('without a key the provider is not connected', async () => {
    expect((await testConnection(adapterOf('groq', async () => [dm('a')], async () => ok()), { ...cfg, apiKey: null }, new AbortController().signal)).status).toBe('not_connected');
  });
  it('keeps format hints soft and strips key-shaped text', () => {
    expect(formatHint('groq', 'gsk_abcdefghijklmnopqrstu')).toBeNull();
    expect(formatHint('groq', 'AIzaSomethingElse12345678')).toMatch(/usually start with "gsk_"/);
    expect(formatHint('mistral', 'anyshapeisfine12345678901')).toBeNull();
    const s = sanitize('bad key gsk_abcdefghijklmnop and Bearer sk-or-v1-1234567890 ' + 'x'.repeat(300), 'gsk_abcdefghijklmnop');
    expect(s).not.toContain('gsk_abc'); expect(s).not.toContain('sk-or-v1'); expect(s.length).toBeLessThanOrEqual(200);
    expect(probeCandidates([dm('big'), dm('x:free', 'free')])[0].modelId).toBe('x:free');
  });
});

describe('router fallback', () => {
  const route = { purpose: 'code' as const };
  const run = () => complete({ route, messages: [{ role: 'user', content: 'hi' }], scope: {}, signal: new AbortController().signal, quiet: true, stream: false });
  it('skips the rest of a provider after an auth failure and reports who answered', async () => {
    fx.models = [info('groq', 'a'), info('groq', 'b'), info('google', 'g')];
    fx.chat.mockImplementation(async (provider: string) => { if (provider === 'groq') throw new ProviderError('auth', 'bad key', 401); return ok('answer'); });
    const r = await run();
    expect(r.text).toBe('answer'); expect(r.model.providerId).toBe('google'); expect(r.recovered).toBe(true);
    expect(fx.chat.mock.calls.filter((c) => c[0] === 'groq')).toHaveLength(1);
    expect(fx.failure).toHaveBeenCalledWith('groq::a', 'auth', expect.any(String), undefined);
  });
  it('retries a transient failure once on the same model before switching', async () => {
    fx.models = [info('groq', 'a'), info('google', 'g')];
    fx.chat.mockImplementation(async (provider: string) => { if (provider === 'groq') throw new ProviderError('server', 'down', 503); return ok(); });
    const r = await run();
    expect(fx.chat.mock.calls.map((c) => c[0])).toEqual(['groq', 'groq', 'google']); expect(r.model.providerId).toBe('google');
  });
  it('never replays a rejected request on the same model and stops after two rejections', async () => {
    fx.models = [info('groq', 'a'), info('google', 'g'), info('mistral', 'm')];
    fx.chat.mockImplementation(async () => { throw new ProviderError('bad_request', 'invalid'); });
    await expect(run()).rejects.toBeInstanceOf(NoModelError);
    expect(fx.chat).toHaveBeenCalledTimes(2); expect(new Set(fx.chat.mock.calls.map((c) => c[1])).size).toBe(2);
  });
  it('honours the fallback cap', async () => {
    fx.models = Array.from({ length: 12 }, (_, i) => info('p' + i, 'x'));
    fx.chat.mockImplementation(async () => { throw new ProviderError('not_found', 'gone', 404); });
    await expect(run()).rejects.toBeInstanceOf(NoModelError);
    expect(fx.chat).toHaveBeenCalledTimes(defaultSettings().routing.maxFallbacks + 1);
  });
  it('explains an empty registry in actionable terms', async () => {
    fx.models = [];
    await expect(run()).rejects.toThrow(/Settings › Providers/);
  });
});

describe('agent search tool', () => {
  it('parses <search> actions with optional glob and path', () => {
    expect(parseActions('<search pattern="useEffect\\(" glob="src/**/*.tsx"/>').actions[0]).toEqual({ type: 'search', pattern: 'useEffect\\(', glob: 'src/**/*.tsx', path: '.' });
    expect(parseActions('<search>TODO</search>').actions[0]).toMatchObject({ type: 'search', pattern: 'TODO' });
  });
  it('searches source files, skips dependencies and secrets, and refuses traversal', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'swarm-search-'));
    mkdirSync(path.join(root, 'src')); mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'app.ts'), 'export function startServer() {}\nstartServer();\n');
    writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'startServer()');
    writeFileSync(path.join(root, '.env'), 'startServer=SECRET');
    const r = await searchProject(root, { pattern: 'startServer' });
    expect(r.matches).toBe(2); expect(r.text).toContain('src/app.ts:1:'); expect(r.text).not.toContain('node_modules'); expect(r.text).not.toContain('SECRET');
    expect((await searchProject(root, { pattern: 'startServer', glob: '**/*.js' })).matches).toBe(0);
    await expect(searchProject(root, { pattern: 'x', path: '../..' })).rejects.toThrow();
    expect(globToRegExp('src/**/*.{ts,tsx}').test('src/a/b.tsx')).toBe(true);
  });
});

describe('settings', () => {
  it('adds intelligence profiles, ordered fallbacks and the fallback cap with safe defaults', () => {
    const d = defaultSettings();
    expect(d.ai.profile).toBe('recommended'); expect(d.routing.fallbacks).toEqual([]); expect(d.routing.maxFallbacks).toBe(6);
    expect(SettingsSchema.parse({ ai: { profile: 'custom' }, routing: { fallbacks: ['groq::a', 'google::g'] } }).routing.fallbacks).toHaveLength(2);
    expect(() => SettingsSchema.parse({ ai: { profile: 'turbo' } })).toThrow();
    expect(() => SettingsSchema.parse({ routing: { maxFallbacks: 20 } })).toThrow();
  });
});
