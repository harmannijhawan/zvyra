/**
 * Runs a contract call with pending state, error toasts and optional
 * "Fix" deep links (from ZvyraError.fixRoute). Every button that talks to the
 * backend goes through this so failures are always visible.
 */
import { useCallback, useRef, useState } from 'react'
import { ClientError, errorMessage, shellCall } from './client'
import { getState, navigate } from './store'
import { toast } from './toast'

const CODE_TITLE: Record<string, string> = {
  NOT_IMPLEMENTED: 'Not available yet',
  NOT_CONFIGURED: 'Setup required',
  UNAVAILABLE: 'Unavailable',
  PERMISSION_DENIED: 'Not allowed',
  NOT_FOUND: 'Not found',
  INVALID_ARGS: 'Couldn’t do that',
  TIMEOUT: 'Timed out',
  CANCELLED: 'Cancelled',
  BACKEND_ERROR: 'Something went wrong'
}

export function goTo(route: string) {
  if (document.body.dataset.window === 'island') void shellCall('main.show', { route }).catch(() => undefined)
  else navigate(route)
}

export function reportError(err: unknown, title?: string) {
  const code = err instanceof ClientError ? err.code : 'BACKEND_ERROR'
  const fix = err instanceof ClientError ? err.fixRoute : undefined
  toast({
    tone: code === 'NOT_IMPLEMENTED' || code === 'NOT_CONFIGURED' ? 'warning' : 'danger',
    title: title ?? CODE_TITLE[code] ?? 'Error',
    message: errorMessage(err),
    action: fix ? { label: 'Fix', run: () => goTo(fix) } : undefined
  })
}

export async function attempt<T>(fn: () => Promise<T>, opts: { success?: string; errorTitle?: string } = {}): Promise<T | undefined> {
  try {
    const r = await fn()
    if (opts.success) toast({ tone: 'success', title: opts.success })
    return r
  } catch (err) {
    reportError(err, opts.errorTitle)
    return undefined
  }
}

export function useAction() {
  const [pending, setPending] = useState(false)
  const inflight = useRef(0)
  const run = useCallback(async <T,>(fn: () => Promise<T>, opts: { success?: string; errorTitle?: string } = {}) => {
    inflight.current++
    setPending(true)
    try {
      return await attempt(fn, opts)
    } finally {
      inflight.current--
      if (inflight.current === 0) setPending(false)
    }
  }, [])
  return [run, pending] as const
}

export const isMock = () => getState().backendMode?.mode === 'mock' || getState().system?.backend === 'mock'
