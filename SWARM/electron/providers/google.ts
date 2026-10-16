import { fetchJson, openAIChat } from './http';
import { inferCapabilities, isChatModel } from './heuristics';
import type { DiscoveredModel, ProviderAdapter } from './types';

interface GModel { name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[] }

export const google: ProviderAdapter = {
  id: 'google',
  name: 'Google Gemini',
  kind: 'cloud',
  requiresKey: true,
  needsAccountId: false,
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  signupUrl: 'https://aistudio.google.com/apikey',
  freeNotes: 'Gemini API free tier for eligible models (rate limited; availability varies by model).',
  publicDiscovery: false,
  async discover(cfg, signal) {
    const out: DiscoveredModel[] = [];
    let pageToken = '';
    for (let i = 0; i < 5; i++) {
      const res = await fetchJson<{ models: GModel[]; nextPageToken?: string }>(
        `${cfg.baseUrl}/models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`,
        { signal, headers: { 'x-goog-api-key': cfg.apiKey ?? '' } },
      );
      for (const m of res.models ?? []) {
        if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
        const id = m.name.replace(/^models\//, '');
        if (!isChatModel(id) || /tts|image|live|native-audio|embedding|computer-use/.test(id)) continue;
        out.push({
          modelId: id,
          displayName: m.displayName ?? id,
          capabilities: inferCapabilities(id, { vision: /gemini|gemma-3/.test(id) || undefined, long_context: (m.inputTokenLimit ?? 0) >= 100_000 || undefined }),
          contextLength: m.inputTokenLimit ?? null,
          maxOutput: m.outputTokenLimit ?? null,
          freeStatus: 'free_tier',
        });
      }
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
    return out;
  },
  chat(cfg, modelId, req) {
    return openAIChat(`${cfg.baseUrl}/openai/chat/completions`, { Authorization: `Bearer ${cfg.apiKey}` }, modelId, req, {}, 'google');
  },
};
