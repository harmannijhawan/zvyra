// Local models via Ollama's native API (streams NDJSON, supports disabling "thinking").
import { classifyHttp, estimatePromptTokens, fetchJson, linkedController } from './http';
import { estimateParamsB, inferCapabilities } from './heuristics';
import { ProviderError, type ChatResult, type DiscoveredModel, type ProviderAdapter } from './types';
import type { Capability } from '../../shared/types';

interface Tag { name: string; size: number; details?: { parameter_size?: string; family?: string } }
interface Show { capabilities?: string[]; model_info?: Record<string, unknown>; details?: { parameter_size?: string } }

const thinkingModels = new Set<string>();
const localCtx = new Map<string, number>();

export async function ollamaStatus(baseUrl: string): Promise<{ running: boolean; version: string | null }> {
  try {
    const r = await fetchJson<{ version: string }>(`${baseUrl}/api/version`, { timeoutMs: 2500 });
    return { running: true, version: r.version };
  } catch { return { running: false, version: null }; }
}

export const ollama: ProviderAdapter = {
  id: 'ollama',
  name: 'Ollama (Local)',
  kind: 'local',
  requiresKey: false,
  needsAccountId: false,
  defaultBaseUrl: 'http://127.0.0.1:11434',
  signupUrl: 'https://ollama.com/download',
  freeNotes: 'Runs on this machine. No API cost; uses local CPU/GPU.',
  publicDiscovery: true,
  async discover(cfg, signal) {
    const tags = await fetchJson<{ models: Tag[] }>(`${cfg.baseUrl}/api/tags`, { signal, timeoutMs: 4000 });
    const out: DiscoveredModel[] = [];
    await Promise.all((tags.models ?? []).map(async (t) => {
      let show: Show = {};
      try {
        show = await fetchJson<Show>(`${cfg.baseUrl}/api/show`, { method: 'POST', body: JSON.stringify({ model: t.name }), headers: { 'Content-Type': 'application/json' }, signal, timeoutMs: 8000 });
      } catch { /* details optional */ }
      const caps = show.capabilities ?? [];
      if (caps.length && !caps.includes('completion')) return; // embedding-only models
      if (caps.includes('thinking')) thinkingModels.add(t.name);
      const ctxKey = Object.keys(show.model_info ?? {}).find((k) => k.endsWith('.context_length'));
      const ctx = ctxKey ? Number(show.model_info![ctxKey]) : null;
      const psize = show.details?.parameter_size ?? t.details?.parameter_size ?? '';
      const paramsB = psize ? Number.parseFloat(psize) : estimateParamsB(t.name);
      const extra: Partial<Record<Capability, boolean>> = {
        vision: caps.includes('vision') || undefined,
        tools: caps.includes('tools') || undefined,
        reasoning: caps.includes('thinking') || undefined,
        fast: paramsB !== null && paramsB <= 14 ? true : undefined,
      };
      if (ctx) localCtx.set(t.name, ctx);
      out.push({
        modelId: t.name,
        displayName: t.name.replace(/:latest$/, ''),
        capabilities: inferCapabilities(t.name, extra),
        contextLength: ctx ? Math.min(ctx, 16_384) : 8192,
        maxOutput: null,
        freeStatus: 'local',
        notes: psize ? `${psize} parameters, ${(t.size / 1e9).toFixed(1)} GB on disk` : `${(t.size / 1e9).toFixed(1)} GB on disk`,
      });
    }));
    return out;
  },
  async chat(cfg, modelId, req): Promise<ChatResult> {
    const started = Date.now();
    const link = linkedController(req.signal, req.firstTokenTimeoutMs);
    const messages = req.messages.map((m) => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      const text = m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
      const images = m.content.filter((p) => p.type === 'image').map((p) => (p as { dataUrl: string }).dataUrl.replace(/^data:[^,]+,/, ''));
      return { role: m.role, content: text, images };
    });
    const numCtx = Math.min(localCtx.get(modelId) ?? 16_384, 16_384);
    const body: Record<string, unknown> = {
      model: modelId, messages, stream: req.stream,
      options: { temperature: req.temperature, num_predict: req.maxTokens, num_ctx: numCtx },
      keep_alive: '10m',
    };
    if (thinkingModels.has(modelId)) body.think = false;
    if (req.json) body.format = 'json';
    let totalTimer: NodeJS.Timeout | null = null;
    try {
      const res = await fetch(`${cfg.baseUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: link.signal });
      if (!res.ok) throw classifyHttp(res.status, await res.text(), res.headers);
      let text = '', ttft: number | null = null, promptTokens = 0, completionTokens = 0, finish: string | null = null;
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          const chunk = JSON.parse(line) as { message?: { content?: string; thinking?: string }; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number; error?: string };
          if (chunk.error) throw new ProviderError('server', chunk.error);
          if (ttft === null && (chunk.message?.content || chunk.message?.thinking)) {
            ttft = Date.now() - started;
            link.dispose();
            totalTimer = setTimeout(() => reader.cancel().catch(() => undefined), Math.max(1000, req.totalTimeoutMs - ttft));
            req.signal.addEventListener('abort', () => reader.cancel().catch(() => undefined), { once: true });
          }
          if (chunk.message?.content) { text += chunk.message.content; req.onToken?.(chunk.message.content); }
          if (chunk.done) { finish = chunk.done_reason ?? 'stop'; promptTokens = chunk.prompt_eval_count ?? 0; completionTokens = chunk.eval_count ?? 0; }
        }
      }
      if (req.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
      if (!finish) throw new ProviderError('timeout', 'Local model response exceeded total timeout');
      return {
        text, finishReason: finish === 'length' ? 'length' : finish, latencyMs: Date.now() - started, ttftMs: ttft,
        promptTokens: promptTokens || estimatePromptTokens(req.messages), completionTokens: completionTokens || Math.ceil(text.length / 4), usageEstimated: !completionTokens,
      };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (req.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
      if (link.timedOut) throw new ProviderError('timeout', `Local model did not respond within ${Math.round(req.firstTokenTimeoutMs / 1000)}s`);
      throw new ProviderError('network', `Ollama unreachable: ${(e as Error).message}`);
    } finally {
      link.dispose();
      if (totalTimer) clearTimeout(totalTimer);
    }
  },
};
