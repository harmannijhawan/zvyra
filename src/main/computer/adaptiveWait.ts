/**
 * Adaptive, state-based waiting to eliminate arbitrary sleeps and excessive polling intervals.
 * Replaces fixed delays with responsive predicate-based event polling.
 */

export interface AdaptiveWaitOptions {
  timeoutMs?: number
  minIntervalMs?: number
  maxIntervalMs?: number
  signal?: AbortSignal
  description?: string
}

export async function waitForCondition<T>(
  predicate: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  options: AdaptiveWaitOptions = {}
): Promise<T> {
  const {
    timeoutMs = 5000,
    minIntervalMs = 20,
    maxIntervalMs = 100,
    signal,
    description = 'condition'
  } = options

  signal?.throwIfAborted()
  const started = Date.now()
  let interval = minIntervalMs

  while (Date.now() - started <= timeoutMs) {
    signal?.throwIfAborted()
    try {
      const result = await predicate()
      if (result) return result
    } catch (err) {
      // Allow transient inspection errors during settling
      signal?.throwIfAborted()
    }

    const elapsed = Date.now() - started
    if (elapsed >= timeoutMs) break

    // Back off slightly from minInterval to maxInterval to balance responsiveness and CPU
    interval = Math.min(maxIntervalMs, Math.round(interval * 1.25))
    const sleepDuration = Math.min(interval, Math.max(0, timeoutMs - elapsed))

    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, sleepDuration)
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer)
          reject(signal.reason ?? new Error('Aborted'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)
}

/**
 * Adaptive wait for a window matching the criteria to appear.
 */
export async function waitForWindowMatching<W>(
  getWindows: () => Promise<W[]>,
  matchFn: (wins: W[]) => W | undefined,
  timeoutMs = 6000,
  signal?: AbortSignal
): Promise<W> {
  return waitForCondition(
    async () => {
      const wins = await getWindows()
      return matchFn(wins) ?? false
    },
    { timeoutMs, minIntervalMs: 25, maxIntervalMs: 120, signal, description: 'window to open' }
  )
}

/**
 * Adaptive wait for a specific window HWND to become the foreground window.
 */
export async function waitForForegroundHwnd(
  getActiveHwnd: () => Promise<number>,
  targetHwnd: number,
  timeoutMs = 3000,
  signal?: AbortSignal
): Promise<boolean> {
  return waitForCondition(
    async () => {
      const active = await getActiveHwnd()
      return active === targetHwnd ? true : false
    },
    { timeoutMs, minIntervalMs: 20, maxIntervalMs: 80, signal, description: `window ${targetHwnd} to activate` }
  )
}
