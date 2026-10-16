import { describe, expect, it, vi } from 'vitest'
import type { Automation, Task } from '../../src/shared/contract'
import { Scheduler, type SchedulerState } from '../../src/main/desktop/scheduler'
import type { JsonDoc } from '../../src/main/desktop/jsonDoc'

function memDoc(init: SchedulerState): JsonDoc<SchedulerState> {
  let v = init
  return {
    get: () => v,
    set: (u: Partial<SchedulerState> | ((s: SchedulerState) => Partial<SchedulerState>)) => (v = { ...v, ...(typeof u === 'function' ? u(v) : u) }),
    flush: async () => undefined
  } as unknown as JsonDoc<SchedulerState>
}

const task = (id: string, status: Task['status'] = 'queued'): Task => ({
  id, title: 't', instruction: 'i', status, source: 'automation', createdAt: '', updatedAt: '', plan: [], canPause: false, canResume: false, canRetry: false
})

describe('Scheduler', () => {
  it('creates, fires due automations through the engine, and reschedules intervals', async () => {
    const start = vi.fn(async () => task('t1'))
    const changes: Automation[] = []
    const s = new Scheduler(memDoc({ automations: [], runs: [] }), start, (a) => changes.push(a))
    const a = s.create({ name: 'n', instruction: 'do it', schedule: { type: 'interval', everyMinutes: 5 }, enabled: true })
    expect(a.nextRunAt).toBeDefined()
    await s.tick(Date.parse(a.nextRunAt!) + 1)
    expect(start).toHaveBeenCalledOnce()
    const after = s.list()[0]
    expect(after.lastTaskId).toBe('t1')
    expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(Date.parse(a.nextRunAt!))
    expect(s.runs(a.id)).toHaveLength(1)
  })

  it('disables one-time automations after they run and tracks task status', async () => {
    const s = new Scheduler(memDoc({ automations: [], runs: [] }), async () => task('t2'), () => undefined)
    const at = new Date(Date.now() + 60_000).toISOString()
    const a = s.create({ name: 'once', instruction: 'x', schedule: { type: 'once', at }, enabled: true })
    await s.tick(Date.parse(at) + 1)
    expect(s.list()[0].enabled).toBe(false)
    s.onTask({ ...task('t2', 'completed'), summary: 'All done', finishedAt: new Date().toISOString() })
    expect(s.list()[0].lastStatus).toBe('completed')
    expect(s.runs(a.id)[0].summary).toBe('All done')
  })

  it('skips runs missed while closed instead of replaying them', () => {
    const missed: Automation = { id: 'm', name: 'm', instruction: 'x', schedule: { type: 'interval', everyMinutes: 60 }, enabled: true, createdAt: '', nextRunAt: new Date(Date.now() - 3600_000).toISOString() }
    const start = vi.fn(async () => task('t3'))
    const s = new Scheduler(memDoc({ automations: [missed], runs: [] }), start, () => undefined)
    s.start()
    s.stop()
    const a = s.list()[0]
    expect(a.lastResult).toMatch(/Missed run/)
    expect(Date.parse(a.nextRunAt!)).toBeGreaterThan(Date.now())
    expect(start).not.toHaveBeenCalled()
  })

  it('rejects schedules with no future run', () => {
    const s = new Scheduler(memDoc({ automations: [], runs: [] }), async () => task('x'), () => undefined)
    expect(() => s.create({ name: 'n', instruction: 'i', schedule: { type: 'daily', time: '09:00', days: [] }, enabled: true })).toThrow(/no future run/)
  })
})
