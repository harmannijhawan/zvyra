import { fetchJson, openAIChat } from './http';
import { inferCapabilities, isChatModel } from './heuristics';
import type { DiscoveredModel, ProviderAdapter } from './types';

interface ORModel {
  id: string; name: string; context_length?: number;
  pricing?: { prompt?: string; completion?: string; request?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number | null };
}

export const openrouter: ProviderAdapter = {
  id: 'openrouter',
  name: 'OpenRouter',
  kind: 'cloud',
  requiresKey: true,
  needsAccountId: false,
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  signupUrl: 'https://openrouter.ai/keys',
  freeNotes: 'Models priced at $0 (":free" variants). Free keys have daily request limits.',
  publicDiscovery: true,
  async discover(cfg, signal) {
    const res = await fetchJson<{ data: ORModel[] }>(`${cfg.baseUrl}/models`, { signal, headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {} });
    const out: DiscoveredModel[] = [];
    for (const m of res.data) {
      const free = m.pricing && Number(m.pricing.prompt ?? 1) === 0 && Number(m.pricing.completion ?? 1) === 0 && Number(m.pricing.request ?? 0) === 0;
      // BYOK authorizes discovered paid models as well; provider billing remains external.
      if (!isChatModel(m.id) || (m.architecture?.output_modalities && !m.architecture.output_modalities.includes('text'))) continue;
      if (m.id === 'openrouter/auto') continue;
      out.push({
        modelId: m.id,
        displayName: m.name.replace(/\s*\(free\)\s*$/i, ''),
        capabilities: inferCapabilities(m.id, {
          vision: m.architecture?.input_modalities?.includes('image') ?? false,
          tools: m.supported_parameters?.includes('tools') ?? undefined,
          json: m.supported_parameters?.includes('response_format') ?? false,
          reasoning: m.supported_parameters?.includes('reasoning') || false,
          long_context: (m.context_length ?? 0) >= 100_000 || undefined,
        }),
        contextLength: m.context_length ?? null,
        maxOutput: m.top_provider?.max_completion_tokens ?? null,
        freeStatus: free ? 'free' : 'paid',
      });
    }
    return out;
  },
  chat(cfg, modelId, req) {
    return openAIChat(`${cfg.baseUrl}/chat/completions`, {
      Authorization: `Bearer ${cfg.apiKey}`,
      'HTTP-Referer': 'https://swarm.local',
      'X-Title': 'SWARM',
    }, modelId, req, {}, 'openrouter');
  },
};
