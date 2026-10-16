// Adapted from SWARM desktop electron/providers/http.ts
import { ProviderError, type ChatMessage, type ChatRequest, type ChatResult } from './types';

/** Link a user/run signal with an internal timeout controller. */
export function linkedController(parent: AbortSignal | undefined, timeoutMs: number) {
  const ctrl = new AbortController();
  let timedOut = false;
  if (parent?.aborted) ctrl.abort();
  let t = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    get timedOut() { return timedOut; },
    abort: () => ctrl.abort(),
    resetTimer: (ms: number) => { clearTimeout(t); return t = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms); },
    dispose: () => { clearTimeout(t); parent?.removeEventListener('abort', onAbort); },
  };
}

/** Retry hints embedded in provider error bodies: Groq "try again in 7m12.5s", Gemini "retryDelay": "34s". */
export function bodyRetryMs(lower: string): number | undefined {
  const m = lower.match(/(?:try again in|retry in|retry after|retrydelay"?\s*:\s*"?)\s*((?:\d+(?:\.\d+)?\s*(?:ms|[hms])\s*)+)/);
  if (!m) return undefined;
  let ms = 0;
  for (const [, n, unit] of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|[hms])/g)) ms += Number(n) * (unit === 'ms' ? 1 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000);
  return ms > 0 ? Math.ceil(ms) : undefined;
}

export function classifyHttp(status: number, body: string, headers?: Headers): ProviderError {
  const lower = body.toLowerCase();
  const retryAfter = headers?.get('retry-after');
  const parsedRetry = retryAfter ? (Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : NaN;
  const retryMs = Number.isFinite(parsedRetry) && parsedRetry >= 0 ? parsedRetry : bodyRetryMs(lower);
  const snippet = 'Upstream response withheld';
  if (status === 429) {
    // Daily/plan quotas do not recover in a minute; treating them as short rate limits caused repeated quota hits.
    if (/limit:\s*0\b|quota.*exceeded.*free|exceeded your current quota|quota exceeded|insufficient_quota|billing|per day|tokens per day|requests per day|\b(rpd|tpd)\b|daily limit|daily quota|free.?tier.*limit|credits/.test(lower)) return new ProviderError('quota', `Quota unavailable (429): ${snippet}`, status, retryMs);
    return new ProviderError('rate_limit', `Rate limited (429): ${snippet}`, status, retryMs ?? 60_000);
  }
  if (status === 401 || status === 403) return new ProviderError('auth', `Authentication failed (${status}): ${snippet}`, status);
  // Gemini reports an invalid key as HTTP 400 API_KEY_INVALID rather than 401.
  if (status === 400 && /api_key_invalid|api key not valid|invalid api key|invalid_api_key|incorrect api key/.test(lower))
    return new ProviderError('auth', `Authentication failed (${status}): ${snippet}`, status);
  if (status === 402) return new ProviderError('quota', `Payment required (402): ${snippet}`, status);
  if (status === 404) return new ProviderError('not_found', `Model or endpoint not found (404): ${snippet}`, status);
  if (status === 413 || /context length|context_length|maximum context|too many tokens|prompt is too long|reduce the length/.test(lower))
    return new ProviderError('context', `Context overflow (${status}): ${snippet}`, status);
  if (status >= 500) return new ProviderError('server', `Provider error (${status}): ${snippet}`, status);
  if (status === 400 && /not supported|unsupported|does not support|not a chat model|invalid model/.test(lower))
    return new ProviderError('unsupported', `Unsupported request (400): ${snippet}`, status);
  return new ProviderError('bad_request', `Request rejected (${status}): ${snippet}`, status);
}

export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const link = linkedController(init.signal ?? undefined, init.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, { ...init, signal: link.signal });
    const text = await res.text();
    if (!res.ok) throw classifyHttp(res.status, text, res.headers);
    try { return JSON.parse(text) as T; } catch { throw new ProviderError('invalid', 'Invalid JSON from provider'); }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (link.timedOut) throw new ProviderError('timeout', `Request timed out: ${new URL(url).host}`);
    if (init.signal?.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', 'Connection to provider failed');
  } finally { link.dispose(); }
}

export function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.dataUrl } })),
    };
  });
}

const estimateTokens = (s: string) => Math.ceil(s.length / 4);
export const estimatePromptTokens = (messages: ChatMessage[]) =>
  messages.reduce((n, m) => n + (typeof m.content === 'string' ? estimateTokens(m.content) : m.content.reduce((k, p) => k + (p.type === 'text' ? estimateTokens(p.text) : 800), 0)), 0);

const noStreamOptions = new Set<string>();

/** OpenAI-compatible chat completion with SSE streaming, first-token and total timeouts. */
export async function openAIChat(
  url: string,
  headers: Record<string, string>,
  modelId: string,
  req: ChatRequest,
  extraBody: Record<string, unknown> = {},
  providerKey = url,
): Promise<ChatResult> {
  const started = Date.now();
  const link = linkedController(req.signal, Math.min(req.firstTokenTimeoutMs, req.totalTimeoutMs));
  let totalTimer: NodeJS.Timeout | null = null;
  let receivedToken = false;
  const deadline = started + req.totalTimeoutMs;
  const body: Record<string, unknown> = {
    model: modelId,
    messages: toOpenAIMessages(req.messages),
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    stream: req.stream,
    ...(req.json ? { response_format: { type: 'json_object' } } : {}),
    ...extraBody,
  };
  if (req.stream && !noStreamOptions.has(providerKey)) body.stream_options = { include_usage: true };
  try {
    let res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: link.signal });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 400 && body.stream_options && /stream_options/i.test(text)) {
        noStreamOptions.add(providerKey);
        delete body.stream_options;
        res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: link.signal });
        if (!res.ok) throw classifyHttp(res.status, await res.text(), res.headers);
      } else throw classifyHttp(res.status, text, res.headers);
    }
    let text = '';
    let ttft: number | null = null;
    let finish: string | null = null;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;

    if (!req.stream || !res.body || !(res.headers.get('content-type') ?? '').includes('event-stream')) {
      const json = JSON.parse(await res.text()) as { choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: typeof usage };
      text = json.choices?.[0]?.message?.content ?? '';
      finish = json.choices?.[0]?.finish_reason ?? null;
      usage = json.usage ?? null;
      ttft = Date.now() - started;
      if (text) req.onToken?.(text);
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let gotAnything = false;
      let completed = false;
      try { reading: for (;;) {
        const { done, value } = await reader.read();
        if (Date.now() >= deadline) throw new ProviderError('timeout', 'Response exceeded total timeout');
        if (receivedToken) link.resetTimer(Math.max(1, Math.min(15000, deadline - Date.now())));
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { completed = true; break reading; }
          let chunk: { choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }[]; usage?: typeof usage; error?: { message?: string; code?: number } };
          try { chunk = JSON.parse(data); } catch { throw new ProviderError('invalid', 'Malformed provider stream'); }
          if (chunk.error) throw new ProviderError(chunk.error.code === 429 ? 'rate_limit' : 'server', 'Provider stream failed');
          const delta = chunk.choices?.[0]?.delta;
          if (!gotAnything && (delta?.content || delta?.reasoning_content || delta?.reasoning)) {
            gotAnything = true;
            ttft = Date.now() - started;
            // First token received: switch from first-token timeout to total timeout.
            receivedToken = true;
            totalTimer = link.resetTimer(Math.max(1, Math.min(15000, deadline - Date.now())));
          }
          if (delta?.content) { text += delta.content; req.onToken?.(delta.content); }
          if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
          if (chunk.usage) usage = chunk.usage;
        }
      }
      if (req.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
      if (!completed && !finish) throw new ProviderError('network', 'Provider connection closed before the response completed');
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    const u = usage as { prompt_tokens?: number; completion_tokens?: number } | null;
    const completionTokens = u?.completion_tokens ?? estimateTokens(text);
    const promptTokens = u?.prompt_tokens ?? estimatePromptTokens(req.messages);
    return { text, promptTokens, completionTokens, finishReason: finish, latencyMs: Date.now() - started, ttftMs: ttft, usageEstimated: !u };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (req.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    if (link.timedOut) throw new ProviderError('timeout', receivedToken ? 'Response exceeded total timeout' : `No response within ${Math.round(req.firstTokenTimeoutMs / 1000)}s`);
    throw new ProviderError('network', 'Connection to provider failed');
  } finally {
    link.dispose();
    if (totalTimer) clearTimeout(totalTimer);
  }
}
