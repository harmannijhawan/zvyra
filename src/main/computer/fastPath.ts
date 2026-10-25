/**
 * Fast Path execution engine for simple, deterministic computer control tasks.
 * Bypasses heavy LLM reasoning and repeated screenshots for straightforward tasks like:
 * - Launching applications and verifying ready state
 * - Closing applications and verifying exit
 * - Window actions (minimize, maximize, focus)
 * - Safe single-step key combinations or text insertion
 */

import { pcControl, matchWindows } from '../tools/pcControl'
import { runDesktopTool, type DesktopToolHost } from '../voice/desktopTools'
import { waitForCondition } from './adaptiveWait'
import { TaskStateMachine } from './taskLifecycle'
import type { TaskTelemetry } from './instrumentation'

export interface FastPathIntent {
  kind: 'launch' | 'close' | 'window' | 'keys' | 'unknown'
  targetApp?: string
  windowAction?: 'minimize' | 'maximize' | 'restore' | 'focus'
  keys?: string
  confidence: number
}

const LAUNCH_RE = /^(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?([a-z0-9 _-]+?)(?:\s+app|\s+application|\s+program)?(?:\s*\.|\s*$)/i
const CLOSE_RE = /^(?:please\s+)?(?:close|exit|quit|terminate)\s+(?:the\s+)?([a-z0-9 _-]+?)(?:\s+app|\s+application|\s+program)?(?:\s*\.|\s*$)/i
const WINDOW_RE = /^(?:please\s+)?(minimize|maximize|restore|focus|switch\s+to)\s+(?:the\s+)?([a-z0-9 _-]+?)(?:\s+app|\s+window)?(?:\s*\.|\s*$)/i
const KEYS_RE = /^(?:please\s+)?(?:press|hit|send\s+keys?)\s+([a-z0-9+_-]+)(?:\s*\.|\s*$)/i

export function parseFastPathIntent(text: string): FastPathIntent {
  const clean = text.trim()

  const launch = LAUNCH_RE.exec(clean)
  if (launch) {
    const app = launch[1].trim()
    // Exclude compound instructions like "open notepad and write..."
    if (!/\b(and|then|after|write|type|draw|click|search|read)\b/i.test(app)) {
      return { kind: 'launch', targetApp: app, confidence: 0.95 }
    }
  }

  const close = CLOSE_RE.exec(clean)
  if (close) {
    const app = close[1].trim()
    if (!/\b(and|then|after)\b/i.test(app)) {
      return { kind: 'close', targetApp: app, confidence: 0.95 }
    }
  }

  const win = WINDOW_RE.exec(clean)
  if (win) {
    const rawAction = win[1].toLowerCase().trim()
    const app = win[2].trim()
    const action = rawAction.startsWith('switch') ? 'focus' : rawAction as 'minimize' | 'maximize' | 'restore' | 'focus'
    return { kind: 'window', targetApp: app, windowAction: action, confidence: 0.95 }
  }

  const keys = KEYS_RE.exec(clean)
  if (keys) {
    return { kind: 'keys', keys: keys[1].trim(), confidence: 0.9 }
  }

  return { kind: 'unknown', confidence: 0 }
}

export function canUseFastPath(text: string): boolean {
  const intent = parseFastPathIntent(text)
  return intent.kind !== 'unknown' && intent.confidence >= 0.9
}

export interface FastPathResult {
  ok: boolean
  summary: string
  action: string
  canFallback: boolean
  error?: string
  hwnd?: number
}

export async function executeFastPath(
  intent: FastPathIntent,
  host: DesktopToolHost,
  lifecycle: TaskStateMachine,
  telemetry?: TaskTelemetry,
  signal?: AbortSignal
): Promise<FastPathResult> {
  signal?.throwIfAborted()
  telemetry?.startActionExecution()

  try {
    switch (intent.kind) {
      case 'launch': {
        if (!intent.targetApp) throw new Error('Missing target application')
        const appName = intent.targetApp

        lifecycle.transition('EXECUTING', `Launching ${appName}`)

        // 1. Launch via desktop tool or native fallback
        let launched: Record<string, unknown> = {}
        if (host && typeof host.userApps === 'function') {
          launched = await runDesktopTool(host, 'launch_app', { name: appName }, signal)
        } else {
          // Native Windows fallback for fast path
          const { spawn } = await import('node:child_process')
          spawn(`${appName}.exe`, [], { detached: true, stdio: 'ignore' }).unref()
          launched = { ok: true, name: appName }
        }
        if (launched.error) {
          throw new Error(String(launched.error))
        }

        lifecycle.transition('VERIFYING', `Waiting for ${appName} window ready state`)

        // 2. Adaptive wait for window readiness
        const readyWin = await waitForCondition(async () => {
          signal?.throwIfAborted()
          const wins = await pcControl.windows()
          const matches = matchWindows(appName, wins, new Set()).matched
          if (matches.length > 0) {
            // Find active or top-level window
            const activeHwnd = (await pcControl.metrics()).hwnd
            const active = matches.find(w => w.hwnd === activeHwnd)
            const target = active ?? matches[0]

            // Ensure window is focused and ready
            if (target.hwnd !== activeHwnd) {
              await pcControl.show(target, 'focus').catch(() => undefined)
            }
            return target
          }
          return null
        }, { timeoutMs: 7000, minIntervalMs: 30, maxIntervalMs: 150, signal, description: `${appName} window ready state` })

        lifecycle.setActiveWindow(readyWin)
        lifecycle.complete(`Launched ${appName} successfully. Window is active and ready.`)
        telemetry?.stopActionExecution(true)

        return {
          ok: true,
          action: 'launch',
          summary: `Opened ${appName}. The window is ready.`,
          hwnd: readyWin.hwnd,
          canFallback: false
        }
      }

      case 'close': {
        if (!intent.targetApp) throw new Error('Missing target application')
        const appName = intent.targetApp

        lifecycle.transition('EXECUTING', `Closing ${appName}`)
        const wins = await pcControl.windows()
        const matches = matchWindows(appName, wins, new Set()).matched
        if (!matches.length) {
          lifecycle.complete(`${appName} is already closed.`)
          return { ok: true, action: 'close', summary: `${appName} was not running.`, canFallback: false }
        }

        const remaining = await pcControl.close(matches, 2500)
        if (remaining.length > 0) {
          throw new Error(`${appName} did not close cleanly (may have unsaved changes)`)
        }

        lifecycle.complete(`Closed ${appName}.`)
        telemetry?.stopActionExecution(true)
        return { ok: true, action: 'close', summary: `Closed ${appName}.`, canFallback: false }
      }

      case 'window': {
        if (!intent.targetApp || !intent.windowAction) throw new Error('Missing window target or action')
        const appName = intent.targetApp
        const action = intent.windowAction

        lifecycle.transition('EXECUTING', `${action} ${appName}`)
        const wins = await pcControl.windows()
        const matches = matchWindows(appName, wins, new Set()).matched
        if (!matches.length) {
          throw new Error(`Window for ${appName} not found`)
        }

        const target = matches[0]
        await pcControl.show(target, action)
        lifecycle.complete(`${action} completed for ${appName}.`)
        telemetry?.stopActionExecution(true)
        return { ok: true, action: 'window', summary: `Updated ${appName} window state to ${action}.`, hwnd: target.hwnd, canFallback: false }
      }

      case 'keys': {
        if (!intent.keys) throw new Error('Missing keys')
        lifecycle.transition('EXECUTING', `Pressing ${intent.keys}`)
        await pcControl.keys(intent.keys, 1, 0)
        lifecycle.complete(`Pressed ${intent.keys}.`)
        telemetry?.stopActionExecution(true)
        return { ok: true, action: 'keys', summary: `Pressed ${intent.keys}.`, canFallback: false }
      }

      default:
        return { ok: false, action: 'unknown', summary: 'Not a fast-path operation', canFallback: true }
    }
  } catch (err) {
    telemetry?.stopActionExecution(false)
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, action: intent.kind, summary: msg, error: msg, canFallback: true }
  }
}
