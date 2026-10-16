/**
 * Minimal structured logger for the shell. Writes JSON lines to
 * userData/logs/shell-YYYY-MM-DD.log and redacts obvious secrets.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ShellLogger } from './backendContext'

const SECRET_KEY = /(key|token|secret|password|authorization)/i

function redact(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : v
  return out
}

export function createLogger(dir: string): ShellLogger {
  let ready: Promise<unknown> | null = null
  const write = (level: string, scope: string, message: string, data?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, scope, message, data: redact(data) })
    if (level !== 'debug') console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${scope}] ${message}`)
    ready ??= mkdir(dir, { recursive: true })
    const file = join(dir, `shell-${new Date().toISOString().slice(0, 10)}.log`)
    void ready.then(() => appendFile(file, line + '\n')).catch(() => undefined)
  }
  return {
    debug: (s, m, d) => write('debug', s, m, d),
    info: (s, m, d) => write('info', s, m, d),
    warn: (s, m, d) => write('warn', s, m, d),
    error: (s, m, d) => write('error', s, m, d)
  }
}
