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

export async function generateWithFallback(
  key: string,
  req: Omit<GenerateContentParameters, 'model' | 'config'> & { config?: GenerateContentConfig },
  opts: { timeoutMs: number; models?: string[]; signal?: AbortSignal; onFallback?: (model: string, message: string) => void }
): Promise<{ res: GenerateContentResponse; model: string }> {
  const ai = new GoogleGenAI({ apiKey: key })
  let lastErr: unknown = new Error('No Gemini model was reachable')
  for (const model of opts.models ?? FLASH_MODELS) {
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
      return { res, model }
    } catch (err) {
      lastErr = err
      if (opts.signal?.aborted) throw err
      if (!attempt.aborted && !isRetryable(err)) throw err
      opts.onFallback?.(model, (err instanceof Error ? err.message : String(err)).slice(0, 200))
    }
  }
  throw lastErr
}
