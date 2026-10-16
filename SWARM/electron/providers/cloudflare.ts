import { fetchJson, openAIChat } from './http';
import { inferCapabilities, isChatModel, prettyName } from './heuristics';
import { ProviderError, type DiscoveredModel, type ProviderAdapter } from './types';

interface CFModel { name: string; description?: string; task?: { name?: string }; properties?: { property_id: string; value: string }[] }

export const cloudflare: ProviderAdapter = {
  id: 'cloudflare',
  name: 'Cloudflare Workers AI',
  kind: 'cloud',
  requiresKey: true,
  needsAccountId: true,
  defaultBaseUrl: 'https://api.cloudflare.com/client/v4',
  signupUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  freeNotes: 'Workers AI free allocation of 10,000 Neurons per day.',
  publicDiscovery: false,
  async discover(cfg, signal) {
    if (!cfg.accountId) throw new ProviderError('auth', 'Cloudflare account ID is required');
    const res = await fetchJson<{ result: CFModel[] }>(
      `${cfg.baseUrl}/accounts/${cfg.accountId}/ai/models/search?task=Text%20Generation&per_page=100`,
      { signal, headers: { Authorization: `Bearer ${cfg.apiKey}` } },
    );
    const out: DiscoveredModel[] = [];
    for (const m of res.result ?? []) {
      if (!isChatModel(m.name)) continue;
      const ctxProp = m.properties?.find((p) => p.property_id === 'context_window' || p.property_id === 'max_input_tokens');
      out.push({
        modelId: m.name,
        displayName: prettyName(m.name.replace(/^@cf\//, '')),
        capabilities: inferCapabilities(m.name),
        contextLength: ctxProp ? Number(ctxProp.value) || null : null,
        maxOutput: null,
        freeStatus: 'free_tier',
      });
    }
    return out;
  },
  chat(cfg, modelId, req) {
    return openAIChat(`${cfg.baseUrl}/accounts/${cfg.accountId}/ai/v1/chat/completions`, { Authorization: `Bearer ${cfg.apiKey}` }, modelId, req, {}, 'cloudflare');
  },
};
