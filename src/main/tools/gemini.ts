/**
 * OWNER: Kiro. One place for the Gemini model ladder used by the text agent
 * and the research / vision tools. Overloaded (503), rate-limited (429) or
 * retired (404) models fall through to the next one.
 */
import { GoogleGenAI, type GenerateContentConfig, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai'

export const FLASH_MODELS = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest']

const RETRYABLE = /404|not found|not supported|no longer available|unavailable|503|overloaded|high demand|429|exhausted|500|internal|deadline|timed? ?out/i

export function isRetryable(err: unknown) {
  return RETRYABLE.test(err instanceof Error ? err.message : String(err))
}

/*
 * Shared health of the model ladder. A model that just answered 503/429/404 is
 * skipped for a while by every agent and tool, instead of each new request
 * waiting ~10 s on it again (that was a large part of "ZVYRA is slow").
 */
const cooldownUntil = new Map<string, number>()
let lastGood: string | null = null
const COOLDOWN_MS: [RegExp, number][] = [
  [/404|not found|not supported|no longer available/i, 6 * 3600_000],
  [/429|exhausted|quota/i, 10 * 60_000],
  [/503|overloaded|high demand|unavailable|500|internal/i, 5 * 60_000]
]

export function markModelFailed(model: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  const ms = COOLDOWN_MS.find(([re]) => re.test(msg))?.[1] ?? 2 * 60_000
  cooldownUntil.set(model, Date.now() + ms)
  if (lastGood === model) lastGood = null
}

export function markModelOk(model: string) {
  cooldownUntil.delete(model)
  lastGood = model
}

/** The ladder in the order to try right now: last working model first, cooling-down models last. */
export function modelOrder(models: string[] = FLASH_MODELS, preferred?: string): string[] {
  const now = Date.now()
  const first = [preferred, lastGood].filter((m): m is string => !!m && models.includes(m))
  const ordered = [...new Set([...first, ...models])]
  const ready = ordered.filter((m) => (cooldownUntil.get(m) ?? 0) <= now)
  const cooling = ordered.filter((m) => (cooldownUntil.get(m) ?? 0) > now)
  return [...ready, ...cooling]
}

export async function generateWithFallback(
  key: string,
  req: Omit<GenerateContentParameters, 'model' | 'config'> & { config?: GenerateContentConfig },
  opts: { timeoutMs: number; models?: string[]; signal?: AbortSignal; onFallback?: (model: string, message: string) => void }
): Promise<{ res: GenerateContentResponse; model: string }> {
  const ai = new GoogleGenAI({ apiKey: key })
  let lastErr: unknown = new Error('No Gemini model was reachable')
  for (const model of modelOrder(opts.models ?? FLASH_MODELS)) {
    if (opts.signal?.aborted) throw new Error('Cancelled')
    const attempt = AbortSignal.timeout(opts.timeoutMs)
    try {
      const res = await ai.models.generateContent({
        ...req,
        model,
        config: {
          ...req.config,
          abortSignal: opts.signal ? AbortSignal.any([opts.signal, attempt]) : attempt,
          httpOptions: { retryOptions: { attempts: 1 } }
        }
      })
      if (!opts.models) markModelOk(model)
      return { res, model }
    } catch (err) {
      lastErr = err
      if (opts.signal?.aborted) throw err
      if (!attempt.aborted && !isRetryable(err)) throw err
      markModelFailed(model, attempt.aborted ? new Error('timed out') : err)
      opts.onFallback?.(model, (err instanceof Error ? err.message : String(err)).slice(0, 200))
    }
  }
  throw lastErr
}
