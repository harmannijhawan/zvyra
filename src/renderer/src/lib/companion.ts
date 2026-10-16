/**
 * Pure derivation of the companion (pet) state from real application state.
 * See docs/CONTRACT.md → "Companion (pet) state". Never reports work that
 * is not happening: "executing" requires a task in running/verifying.
 */
import type { ConnectionStatus, Interaction, PermissionRequest, Task, VoiceState } from '@shared/contract'

export type CompanionState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'planning'
  | 'speaking'
  | 'executing'
  | 'waiting_permission'
  | 'completed'
  | 'error'
  | 'offline'
  | 'dnd'

export interface CompanionInput {
  voice: VoiceState | null
  tasks: Task[]
  permissions: PermissionRequest[]
  interactions: Interaction[]
  swarm: ConnectionStatus | null
  dnd: boolean
  now: number
}

export interface CompanionView {
  state: CompanionState
  headline: string
  detail?: string
  taskId?: string
}

const COMPLETED_WINDOW = 4000
const ERROR_WINDOW = 6000

const finishedWithin = (t: Task, now: number, ms: number) => !!t.finishedAt && now - Date.parse(t.finishedAt) <= ms

export function deriveCompanion(i: CompanionInput, wakePhrase = 'Hey Zvyra'): CompanionView {
  const v = i.voice
  if (v === 'listening' || v === 'wake_detected') return { state: 'listening', headline: 'Listening…', detail: 'Go ahead, I’m listening' }
  if (v === 'transcribing') return { state: 'thinking', headline: 'Understanding…', detail: 'Transcribing what you said' }
  if (v === 'speaking') return { state: 'speaking', headline: 'Speaking', detail: 'Tap stop to interrupt' }
  if (i.permissions.length > 0) {
    const p = i.permissions[0]
    return { state: 'waiting_permission', headline: 'Needs your approval', detail: p.title, taskId: p.taskId }
  }
  const planning = i.tasks.find((t) => t.status === 'planning')
  const running = i.tasks.find((t) => t.status === 'running' || t.status === 'verifying')
  if (running) {
    return {
      state: 'executing',
      headline: running.status === 'verifying' ? 'Verifying' : 'Working',
      detail: running.currentAction ?? running.title,
      taskId: running.id
    }
  }
  if (planning) return { state: 'planning', headline: 'Planning', detail: planning.title, taskId: planning.id }
  if (i.interactions.some((x) => x.status === 'pending')) return { state: 'thinking', headline: 'Thinking…' }
  if (i.interactions.some((x) => x.status === 'streaming')) return { state: 'thinking', headline: 'Replying…' }
  if (v === 'error') return { state: 'error', headline: 'Voice needs attention', detail: 'Open voice settings to fix it' }
  const failed = i.tasks.find((t) => t.status === 'failed' && finishedWithin(t, i.now, ERROR_WINDOW))
  if (failed) return { state: 'error', headline: 'Task failed', detail: failed.error ?? failed.title, taskId: failed.id }
  const done = i.tasks.find((t) => t.status === 'completed' && finishedWithin(t, i.now, COMPLETED_WINDOW))
  if (done) return { state: 'completed', headline: 'Done', detail: done.title, taskId: done.id }
  if (i.dnd) return { state: 'dnd', headline: 'Do not disturb', detail: 'Notifications are paused' }
  if (i.swarm !== 'connected') return { state: 'offline', headline: 'Models offline', detail: 'Connect an AI provider to get started' }
  if (v === 'standby') return { state: 'idle', headline: 'ZVYRA', detail: `Say “${wakePhrase}”` }
  return { state: 'idle', headline: 'ZVYRA', detail: 'Ready when you are' }
}

/** When the next time-based transition (completed/error fade) will happen, or null. */
export function nextCompanionTick(tasks: Task[], now: number): number | null {
  let next: number | null = null
  for (const t of tasks) {
    if (!t.finishedAt) continue
    const end = Date.parse(t.finishedAt) + (t.status === 'failed' ? ERROR_WINDOW : t.status === 'completed' ? COMPLETED_WINDOW : 0)
    if (end > now && (next === null || end < next)) next = end
  }
  return next
}
