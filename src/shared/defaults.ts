/**
 * Shared defaults and helpers (SHARED). Backends may use these as their
 * initial persisted values; the shell uses them when settings are unavailable.
 */
import type { AppSettings, DeepPartial, NotificationPolicy, RoutingConfig } from './contract/types'

export const DEFAULT_SETTINGS: AppSettings = {
  profile: { name: '' },
  appearance: { theme: 'midnight', reduceMotion: false, uiScale: 1 },
  island: { enabled: true, alwaysOnTop: true, closeBehavior: 'hide', showWaveform: true, expandOnWake: true },
  voice: {
    wakeWordEnabled: false,
    wakeEngine: '',
    sensitivity: 0.6,
    micDeviceId: null,
    listenTimeoutSec: 10,
    silenceTimeoutMs: 1200,
    sttProvider: '',
    ttsProvider: '',
    ttsVoice: null,
    ttsRate: 1,
    speakResponses: true
  },
  assistant: { stayAwake: false, autonomous: false },
  startup: { openAtLogin: false, startHidden: false },
  tray: { closeToTray: true },
  background: { allowBackgroundTasks: true, maxConcurrentTasks: 2, resumeQueuedOnStart: true },
  data: { keepTaskHistoryDays: 90, keepActivityDays: 30 },
  shortcuts: {
    toggleIsland: 'Control+Alt+Z',
    pushToTalk: 'Control+Alt+Space',
    stopAll: 'Control+Alt+Backspace',
    showMain: 'Control+Alt+O'
  },
  diagnostics: { logLevel: 'info' }
}

export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = {
  enabled: true,
  desktop: true,
  spoken: false,
  spokenMinPriority: 'high',
  categories: {
    task_completed: true,
    task_blocked: true,
    error: true,
    discovery: true,
    long_running: true,
    custom: true
  },
  quietHours: { enabled: false, start: '22:00', end: '07:00', allowCritical: true },
  doNotDisturb: false,
  snoozedUntil: null
}

export const DEFAULT_ROUTING: RoutingConfig = {
  mode: 'auto',
  roles: { conversation: null, coding: null, research: null, computer: null, general: null, voice: null },
  fallbacks: [],
  timeoutMs: 60000,
  maxRetries: 2
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep-merge a partial into a base value. Arrays and primitives replace. */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    const current = out[k]
    out[k] = isPlainObject(current) && isPlainObject(v) ? deepMerge(current, v) : v
  }
  return out as T
}
