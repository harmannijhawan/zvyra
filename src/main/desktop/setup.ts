/**
 * OWNER: Kiro. First-run setup helpers: the provider catalogue and a key
 * tester that sends one tiny real request to each provider.
 */
import type { KeyTestResult, SetupProvider, SetupProviderId } from '../../shared/contract'

export const SETUP_PROVIDERS: Omit<SetupProvider, 'configured'>[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    purpose: 'Voice conversations, research, camera vision and the builder agent',
    required: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza…'
  },
  { id: 'openrouter', name: 'OpenRouter', purpose: 'Hundreds of models (many free) for background agents', required: false, keyUrl: 'https://openrouter.ai/settings/keys', keyHint: 'sk-or-…' },
  { id: 'groq', name: 'Groq', purpose: 'Very fast replies for chat and agents', required: false, keyUrl: 'https://console.groq.com/keys', keyHint: 'gsk_…' },
  { id: 'mistral', name: 'Mistral', purpose: 'Mistral and Codestral models for coding agents', required: false, keyUrl: 'https://console.mistral.ai/api-keys', keyHint: 'Mistral API key' },
  { id: 'huggingface', name: 'Hugging Face', purpose: 'Open models through Inference Providers', required: false, keyUrl: 'https://huggingface.co/settings/tokens', keyHint: 'hf_…' },
  { id: 'nvidia', name: 'NVIDIA NIM', purpose: 'Free hosted Llama, Nemotron and DeepSeek models', required: false, keyUrl: 'https://build.nvidia.com/settings/api-keys', keyHint: 'nvapi-…' }
]

/** SWARM's provider id for each setup provider. */
export const SWARM_ID: Record<SetupProviderId, string> = { gemini: 'google', openrouter: 'openrouter', groq: 'groq', mistral: 'mistral', huggingface: 'huggingface', nvidia: 'nvidia' }

const timeout = () => AbortSignal.timeout(20_000)

async function body(r: Response) {
  const t = await r.text().catch(() => '')
  try {
    const j = JSON.parse(t) as { error?: { message?: string } | string; message?: string }
    return typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message ?? t)
  } catch {
    return t
  }
}

function explain(status: number, detail: string): string {
  if (status === 401 || status === 403 || /invalid|unauthori[sz]ed|api key not valid/i.test(detail)) return 'The provider rejected this key. Copy it again and check it isn’t revoked.'
  if (status === 429 || /quota|rate/i.test(detail)) return 'The key works, but its quota is used up right now.'
  return `The provider answered ${status}: ${detail.slice(0, 160)}`
}

/** OpenAI-compatible: one 1-token chat completion; falls back to listing models if the test model is gone. */
async function openAiCompat(base: string, key: string, model: string): Promise<{ ok: boolean; status: number; detail: string }> {
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] }), signal: timeout() })
  if (r.ok) return { ok: true, status: r.status, detail: '' }
  const detail = await body(r)
  if ((r.status === 404 || r.status === 400 || r.status === 422) && !/key|auth/i.test(detail)) {
    const m = await fetch(`${base}/models`, { headers, signal: timeout() })
    return { ok: m.ok, status: m.status, detail: m.ok ? '' : await body(m) }
  }
  return { ok: false, status: r.status, detail }
}

export async function testProviderKey(provider: SetupProviderId, raw: string): Promise<KeyTestResult> {
  const key = raw.trim()
  if (key.length < 12 || /\s/.test(key)) return { ok: false, message: 'That doesn’t look like an API key.' }
  const t0 = Date.now()
  try {
    let res: { ok: boolean; status: number; detail: string }
    switch (provider) {
      case 'gemini': {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent'
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with OK' }] }], generationConfig: { maxOutputTokens: 4 } }),
          signal: timeout()
        })
        res = { ok: r.ok, status: r.status, detail: r.ok ? '' : await body(r) }
        if (!r.ok && r.status === 404) {
          const m = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key }, signal: timeout() })
          res = { ok: m.ok, status: m.status, detail: m.ok ? '' : await body(m) }
        }
        break
      }
      case 'openrouter': {
        const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, signal: timeout() })
        res = { ok: r.ok, status: r.status, detail: r.ok ? '' : await body(r) }
        break
      }
      case 'groq':
        res = await openAiCompat('https://api.groq.com/openai/v1', key, 'llama-3.1-8b-instant')
        break
      case 'mistral':
        res = await openAiCompat('https://api.mistral.ai/v1', key, 'mistral-small-latest')
        break
      case 'nvidia':
        res = await openAiCompat('https://integrate.api.nvidia.com/v1', key, 'meta/llama-3.1-8b-instruct')
        break
      case 'huggingface': {
        const r = await fetch('https://huggingface.co/api/whoami-v2', { headers: { Authorization: `Bearer ${key}` }, signal: timeout() })
        res = { ok: r.ok, status: r.status, detail: r.ok ? '' : await body(r) }
        break
      }
      default:
        return { ok: false, message: 'Unknown provider' }
    }
    const latencyMs = Date.now() - t0
    if (res.ok) return { ok: true, message: `Connected · ${latencyMs} ms`, latencyMs }
    // A quota error still proves the key is real; let the user keep it.
    if (res.status === 429) return { ok: true, message: 'Key is valid, but its quota is used up for now. It will work again once the limit resets.', latencyMs }
    return { ok: false, message: explain(res.status, res.detail), latencyMs }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: /abort|timeout/i.test(msg) ? 'The provider didn’t answer within 20 seconds. Check your internet connection.' : `Couldn’t reach the provider: ${msg.slice(0, 140)}` }
  }
}
