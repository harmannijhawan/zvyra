// Provider onboarding: catalog, key-page allowlist and the real connection test
// (docs/SWARM_PLATFORM_SPEC.md §1–§3). Runs only in the main process; keys never
// reach the renderer.
import { fetchJson } from './http';
import { ProviderError, type DiscoveredModel, type ProviderAdapter, type ProviderConfig } from './types';

export type ConnectionStatus =
  | 'not_connected' | 'needs_configuration' | 'checking' | 'connected'
  | 'auth_failed' | 'rate_limited' | 'no_models' | 'network_error';

export const STATUS_LABEL: Record<ConnectionStatus, string> = {
  not_connected: 'Not connected',
  needs_configuration: 'Needs configuration',
  checking: 'Checking connection',
  connected: 'Connected',
  auth_failed: 'Authentication failed',
  rate_limited: 'Rate limited',
  no_models: 'No compatible models available',
  network_error: 'Network error',
};

export interface CatalogEntry {
  id: 'google' | 'groq' | 'mistral' | 'huggingface' | 'nvidia' | 'openrouter';
  name: string;
  description: string;
  keyUrl: string;
  keyPrefix: string | null;
  instructions: string;
  permissions: string | null;
  freeNotes: string;
  /** Click-by-click guide shown next to the key field. */
  steps: readonly string[];
  /** Short plan tag as advertised by the provider (never a guarantee). */
  tag: string;
  /** Suggested for first-time users: quick sign-up and an advertised free tier. */
  recommended: boolean;
}

/** The only URLs SWARM opens for "Get API Key". Never derived from user input. */
export const PROVIDER_CATALOG: readonly CatalogEntry[] = [
  { id: 'google', name: 'Google AI Studio', description: 'Gemini models with long context and multimodal input.', keyUrl: 'https://aistudio.google.com/apikey',
    keyPrefix: 'AIza', instructions: 'Sign in with your Google account, choose "Create API key", then copy the key.', permissions: null,
    freeNotes: 'Google advertises a free tier for some Gemini models. Rate limits and eligibility vary by model and region.',
    steps: ['Sign in with your Google account and accept the terms.', 'Select "Create API key" (choose any project if asked).', 'Copy the key (it starts with AIza).'], tag: 'Free tier · Google account', recommended: true },
  { id: 'groq', name: 'Groq', description: 'Very low-latency hosted open models.', keyUrl: 'https://console.groq.com/keys',
    keyPrefix: 'gsk_', instructions: 'Open API Keys, choose "Create API Key", name it, then copy it. Groq shows the key only once.', permissions: null,
    freeNotes: 'Groq advertises a free plan with per-model request and token limits.',
    steps: ['Sign in with Google, GitHub or email.', 'Select "Create API Key", give it any name and submit.', 'Copy the key (it starts with gsk_). Groq shows it only once.'], tag: 'Free tier · fastest setup', recommended: true },
  { id: 'mistral', name: 'Mistral AI', description: 'Mistral and Codestral models from Mistral AI.', keyUrl: 'https://console.mistral.ai/',
    keyPrefix: null, instructions: 'In the Mistral console open API Keys, create a new key and copy it. A workspace plan may need to be activated first.', permissions: null,
    freeNotes: 'Mistral advertises an "Experiment" plan with rate limits. Activation may require phone verification.',
    steps: ['Sign in and, if asked, choose the free "Experiment" plan (phone verification may be required).', 'Open "API Keys" in the left menu and select "Create new key".', 'Copy the key. Mistral shows it only once.'], tag: 'Free "Experiment" plan', recommended: false },
  { id: 'huggingface', name: 'Hugging Face', description: 'Open models served through Hugging Face Inference Providers.', keyUrl: 'https://huggingface.co/settings/tokens',
    keyPrefix: 'hf_', instructions: 'Create a fine-grained access token and copy it.', permissions: 'Enable only "Make calls to Inference Providers". No write permissions are needed.',
    freeNotes: 'Free accounts receive a small monthly inference credit. Usage beyond it requires a paid plan.',
    steps: ['Sign in, then select "Create new token".', 'Choose "Fine-grained" and tick only "Make calls to Inference Providers".', 'Create the token and copy it (it starts with hf_).'], tag: 'Monthly free credit', recommended: false },
  { id: 'nvidia', name: 'NVIDIA NIM', description: 'NVIDIA-hosted NIM inference endpoints.', keyUrl: 'https://build.nvidia.com/',
    keyPrefix: 'nvapi-', instructions: 'Sign in, open any model page, choose "Get API Key" and copy the generated key.', permissions: null,
    freeNotes: 'NVIDIA advertises free developer access with rate limits.',
    steps: ['Sign in with an NVIDIA account.', 'Open any model page and select "Get API Key", then "Generate Key".', 'Copy the key (it starts with nvapi-).'], tag: 'Free developer access', recommended: false },
  { id: 'openrouter', name: 'OpenRouter', description: 'One key for models from many providers, including free variants.', keyUrl: 'https://openrouter.ai/keys',
    keyPrefix: 'sk-or-', instructions: 'Choose "Create Key", optionally set a credit limit, then copy the key.', permissions: null,
    freeNotes: 'Models priced at $0 are marked free. Free usage has daily request limits.',
    steps: ['Sign in, then select "Create Key".', 'Name it and (optionally) set a credit limit, then create it.', 'Copy the key (it starts with sk-or-).'], tag: 'Many models · free variants', recommended: false },
];

export const catalogEntry = (id: string) => PROVIDER_CATALOG.find((p) => p.id === id) ?? null;
export const keyPageUrl = (id: string): string | null => catalogEntry(id)?.keyUrl ?? null;

/** Soft hint only. A matching format does not prove the key works. */
export function formatHint(id: string, key: string): string | null {
  const entry = catalogEntry(id);
  const k = key.trim();
  if (!entry || !k) return null;
  if (/\s/.test(k)) return 'The key contains spaces. Check that it was copied completely.';
  if (entry.keyPrefix && !k.startsWith(entry.keyPrefix)) return `${entry.name} keys usually start with "${entry.keyPrefix}". You can still test it.`;
  if (k.length < 20) return 'This key looks shorter than expected. You can still test it.';
  return null;
}

/** Remove anything key-shaped and cap length so provider text is safe to display. */
export function sanitize(message: string, key?: string | null): string {
  let m = message;
  if (key) m = m.split(key).join('[key]');
  m = m.replace(/\b(AIza[\w-]{10,}|gsk_[\w-]{8,}|hf_[\w-]{8,}|nvapi-[\w-]{8,}|sk-[\w-]{8,})/g, '[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]');
  return m.length > 200 ? m.slice(0, 197) + '…' : m;
}

export function statusForError(e: unknown): ConnectionStatus {
  const kind = e instanceof ProviderError ? e.kind : 'network';
  if (kind === 'auth') return 'auth_failed';
  if (kind === 'rate_limit' || kind === 'quota') return 'rate_limited';
  if (kind === 'not_found' || kind === 'unsupported') return 'no_models';
  return 'network_error';
}

export interface ConnectionResult {
  providerId: string;
  status: ConnectionStatus;
  label: string;
  models: number;
  freeModels: number;
  usableModel: string | null;
  latencyMs: number | null;
  checkedAt: number;
  message: string;
  retryAfterMs?: number;
}

function messageFor(status: ConnectionStatus, entry: CatalogEntry | null, e?: unknown): string {
  const name = entry?.name ?? 'The provider';
  switch (status) {
    case 'auth_failed': return `${name} rejected the key. Check that it was copied completely and is still active.${entry?.permissions ? ' ' + entry.permissions : ''}`;
    case 'rate_limited': {
      const quota = e instanceof ProviderError && e.kind === 'quota';
      const wait = e instanceof ProviderError && e.retryAfterMs ? ` Try again in about ${Math.max(1, Math.round(e.retryAfterMs / 1000))} s.` : '';
      return quota ? `${name} reports that the quota or credit for this key is exhausted. Check your plan or billing.` : `${name} is rate limiting this key.${wait}`;
    }
    case 'no_models': return `The key works, but ${name} did not return a chat model this key can use.`;
    case 'network_error': return `Could not reach ${name}. Check your connection and retry.${e instanceof ProviderError && e.kind === 'server' ? ' The provider reported a server error.' : ''}`;
    default: return '';
  }
}

/** Free and small models first, so the probe is cheap and most likely to be allowed. */
export function probeCandidates(models: DiscoveredModel[], max = 3): DiscoveredModel[] {
  const rank = (m: DiscoveredModel) => (m.freeStatus === 'free' ? 0 : 2) + (/flash|mini|small|instant|8b|lite|haiku|nano/i.test(m.modelId) ? 0 : 1) + (/preview|exp|thinking|reason|r1\b|qwq/i.test(m.modelId) ? 2 : 0);
  return [...models].sort((a, b) => rank(a) - rank(b) || a.modelId.localeCompare(b.modelId)).slice(0, max);
}

/** Auth check that spends no tokens, where the provider offers one. Returns false when not available. */
async function authCheck(adapter: ProviderAdapter, cfg: ProviderConfig, signal: AbortSignal): Promise<boolean> {
  const auth = { Authorization: `Bearer ${cfg.apiKey ?? ''}` };
  if (adapter.id === 'huggingface') { await fetchJson('https://huggingface.co/api/whoami-v2', { headers: auth, signal, timeoutMs: 15_000 }); return true; }
  if (adapter.id === 'openrouter') { await fetchJson(`${cfg.baseUrl}/key`, { headers: auth, signal, timeoutMs: 15_000 }); return true; }
  return false; // google, groq, mistral: authenticated discovery is the check. nvidia: only the probe proves the key.
}

export async function testConnection(adapter: ProviderAdapter, cfg: ProviderConfig, signal: AbortSignal, onDiscovered?: (models: DiscoveredModel[]) => void): Promise<ConnectionResult> {
  const entry = catalogEntry(adapter.id);
  const started = Date.now();
  const base = { providerId: adapter.id, models: 0, freeModels: 0, usableModel: null as string | null, latencyMs: null as number | null, checkedAt: Date.now() };
  const done = (status: ConnectionStatus, extra: Partial<ConnectionResult> = {}, e?: unknown): ConnectionResult => ({
    ...base, status, label: STATUS_LABEL[status], message: messageFor(status, entry, e), checkedAt: Date.now(),
    ...(e instanceof ProviderError && e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}), ...extra,
  });
  if (!cfg.apiKey) return done('not_connected', { message: 'Add an API key to test this provider.' });
  try { await authCheck(adapter, cfg, signal); }
  catch (e) { if (e instanceof ProviderError && e.kind === 'cancelled') throw e; return done(statusForError(e), {}, e); }

  let models: DiscoveredModel[];
  try { models = await adapter.discover(cfg, signal); }
  catch (e) { if (e instanceof ProviderError && e.kind === 'cancelled') throw e; return done(statusForError(e), {}, e); }
  onDiscovered?.(models);
  base.models = models.length;
  base.freeModels = models.filter((m) => m.freeStatus === 'free').length;
  if (!models.length) return done('no_models');

  let last: unknown = null;
  for (const candidate of probeCandidates(models)) {
    try {
      const r = await adapter.chat(cfg, candidate.modelId, {
        messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 8, temperature: 0, signal, stream: false,
        firstTokenTimeoutMs: 20_000, totalTimeoutMs: 20_000,
      });
      return done('connected', { usableModel: candidate.modelId, latencyMs: r.latencyMs || Date.now() - started,
        message: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available; ${candidate.modelId} answered a test request.` });
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'cancelled') throw e;
      last = e;
      const kind = e instanceof ProviderError ? e.kind : 'network';
      // Account-wide problems end the test; model-specific ones try the next candidate.
      if (!['not_found', 'unsupported', 'bad_request', 'invalid', 'context'].includes(kind)) return done(statusForError(e), {}, e);
    }
  }
  return done('no_models', { message: `The key works for listing models, but none of the tested models accepted a request. ${last instanceof ProviderError ? sanitize(last.message, cfg.apiKey) : ''}`.trim() });
}
