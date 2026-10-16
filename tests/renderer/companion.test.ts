import { describe, expect, it } from 'vitest'
import type { Task } from '@shared/contract'
import { deriveCompanion, nextCompanionTick, type CompanionInput } from '@renderer/lib/companion'

const now = Date.parse('2026-10-15T12:00:00Z')

function task(p: Partial<Task>): Task {
  return {
    id: 't1',
    title: 'Write report',
    instruction: 'Write report',
    status: 'running',
    source: 'home',
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    plan: [],
    canPause: true,
    canResume: false,
    canRetry: false,
    ...p
  }
}

const base: CompanionInput = { voice: 'off', tasks: [], permissions: [], interactions: [], swarm: 'connected', dnd: false, now }

describe('deriveCompanion', () => {
  it('is idle when nothing is happening', () => {
    expect(deriveCompanion(base).state).toBe('idle')
  })

  it('prompts for the wake phrase in standby', () => {
    const v = deriveCompanion({ ...base, voice: 'standby' }, 'Hey Zvyra')
    expect(v.state).toBe('idle')
    expect(v.detail).toContain('Hey Zvyra')
  })

  it('only reports executing when a task is really running', () => {
    expect(deriveCompanion({ ...base, tasks: [task({ status: 'queued' })] }).state).toBe('idle')
    expect(deriveCompanion({ ...base, tasks: [task({ status: 'running', currentAction: 'Reading files' })] })).toMatchObject({
      state: 'executing',
      detail: 'Reading files'
    })
    expect(deriveCompanion({ ...base, tasks: [task({ status: 'planning' })] }).state).toBe('planning')
  })

  it('voice states win over task states', () => {
    const tasks = [task({ status: 'running' })]
    expect(deriveCompanion({ ...base, tasks, voice: 'listening' }).state).toBe('listening')
    expect(deriveCompanion({ ...base, tasks, voice: 'speaking' }).state).toBe('speaking')
    expect(deriveCompanion({ ...base, tasks, voice: 'transcribing' }).state).toBe('thinking')
  })

  it('surfaces pending permissions above running work', () => {
    const v = deriveCompanion({
      ...base,
      tasks: [task({ status: 'running' })],
      permissions: [{ id: 'p', category: 'run_commands', title: 'Run npm test?', description: '', risk: 'medium', createdAt: '' }]
    })
    expect(v).toMatchObject({ state: 'waiting_permission', detail: 'Run npm test?' })
  })

  it('shows completed and error briefly, then returns to idle', () => {
    const done = task({ status: 'completed', finishedAt: new Date(now - 1000).toISOString() })
    expect(deriveCompanion({ ...base, tasks: [done] }).state).toBe('completed')
    expect(deriveCompanion({ ...base, tasks: [done], now: now + 10_000 }).state).toBe('idle')
    const failed = task({ status: 'failed', finishedAt: new Date(now - 1000).toISOString(), error: 'boom' })
    expect(deriveCompanion({ ...base, tasks: [failed] })).toMatchObject({ state: 'error', detail: 'boom' })
  })

  it('is offline without a SWARM connection and dnd when focus mode is on', () => {
    expect(deriveCompanion({ ...base, swarm: 'disconnected' }).state).toBe('offline')
    expect(deriveCompanion({ ...base, dnd: true }).state).toBe('dnd')
  })

  it('schedules the next transition for fading states', () => {
    const done = task({ status: 'completed', finishedAt: new Date(now - 1000).toISOString() })
    expect(nextCompanionTick([done], now)).toBe(now + 3000)
    expect(nextCompanionTick([task({ status: 'running' })], now)).toBeNull()
  })
})
