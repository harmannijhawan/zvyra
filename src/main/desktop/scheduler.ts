/**
 * OWNER: Kiro. Scheduler for once / daily / interval automations. Runs only
 * while ZVYRA is running; each run starts a real task through the engine.
 * Missed runs (app closed) are recorded and skipped, never replayed blindly.
 */
import { randomUUID } from 'node:crypto'
import { ZvyraError, type Automation, type AutomationRun, type Schedule, type Task } from '../../shared/contract'
import type { JsonDoc } from './jsonDoc'
import { nextRun } from './pure'

export interface SchedulerState {
  automations: Automation[]
  runs: AutomationRun[]
}

const TICK_MS = 15_000
const GRACE_MS = 90_000

export class Scheduler {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly doc: JsonDoc<SchedulerState>,
    private readonly startTask: (a: Automation) => Promise<Task>,
    private readonly onChange: (a: Automation) => void
  ) {}

  start() {
    const now = Date.now()
    // Reconcile schedules missed while the app was closed.
    for (const a of this.doc.get().automations) {
      if (!a.enabled || !a.nextRunAt) continue
      const due = Date.parse(a.nextRunAt)
      if (due < now - GRACE_MS) {
        const next = nextRun(a.schedule, now)
        this.save({ ...a, nextRunAt: next ? new Date(next).toISOString() : undefined, enabled: next !== null && a.enabled, lastResult: `Missed run at ${new Date(due).toLocaleString()} (ZVYRA was closed)` })
      }
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list() {
    return this.doc.get().automations
  }

  has(id: string) {
    return this.doc.get().automations.some((a) => a.id === id)
  }

  private save(a: Automation) {
    this.doc.set((s) => ({ automations: [...s.automations.filter((x) => x.id !== a.id), a] }))
    this.onChange(a)
    return a
  }

  private schedule(s: Schedule, from = Date.now()) {
    const n = nextRun(s, from)
    return n ? new Date(n).toISOString() : undefined
  }

  create(input: { name: string; instruction: string; schedule: Schedule; enabled: boolean; agentId?: string; projectId?: string }): Automation {
    const nextRunAt = this.schedule(input.schedule)
    if (!nextRunAt) throw new ZvyraError('INVALID_ARGS', 'That schedule has no future run time')
    return this.save({ ...input, id: randomUUID(), createdAt: new Date().toISOString(), nextRunAt: input.enabled ? nextRunAt : undefined })
  }

  update(id: string, patch: Partial<Omit<Automation, 'id' | 'createdAt'>>): Automation {
    const cur = this.doc.get().automations.find((a) => a.id === id)
    if (!cur) throw new ZvyraError('NOT_FOUND', 'Automation not found')
    const next = { ...cur, ...patch }
    const nextRunAt = next.enabled ? this.schedule(next.schedule) : undefined
    if (next.enabled && !nextRunAt) throw new ZvyraError('INVALID_ARGS', 'That schedule has no future run time')
    return this.save({ ...next, nextRunAt })
  }

  delete(id: string) {
    this.doc.set((s) => ({ automations: s.automations.filter((a) => a.id !== id), runs: s.runs.filter((r) => r.automationId !== id) }))
  }

  runs(id: string, limit = 50) {
    return this.doc
      .get()
      .runs.filter((r) => r.automationId === id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
  }

  async runNow(id: string): Promise<Task> {
    const a = this.doc.get().automations.find((x) => x.id === id)
    if (!a) throw new ZvyraError('NOT_FOUND', 'Automation not found')
    return this.fire(a, false)
  }

  private async fire(a: Automation, scheduled: boolean): Promise<Task> {
    const startedAt = new Date().toISOString()
    let next: Automation = scheduled
      ? { ...a, nextRunAt: a.schedule.type === 'once' ? undefined : this.schedule(a.schedule), enabled: a.schedule.type === 'once' ? false : a.enabled }
      : a
    try {
      const task = await this.startTask(a)
      next = { ...next, lastRunAt: startedAt, lastTaskId: task.id, lastStatus: task.status, lastResult: undefined }
      this.doc.set((s) => ({ runs: [{ id: randomUUID(), automationId: a.id, taskId: task.id, startedAt, status: task.status }, ...s.runs].slice(0, 500) }))
      this.save(next)
      return task
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.doc.set((s) => ({ runs: [{ id: randomUUID(), automationId: a.id, startedAt, finishedAt: startedAt, status: 'failed' as const, summary: msg }, ...s.runs].slice(0, 500) }))
      this.save({ ...next, lastRunAt: startedAt, lastStatus: 'failed', lastResult: msg })
      throw err
    }
  }

  async tick(now = Date.now()) {
    for (const a of this.doc.get().automations) {
      if (!a.enabled || !a.nextRunAt || Date.parse(a.nextRunAt) > now) continue
      await this.fire(a, true).catch(() => undefined)
    }
  }

  /** Keeps lastStatus / run history in sync with the engine's task updates. */
  onTask(task: Task) {
    const s = this.doc.get()
    const run = s.runs.find((r) => r.taskId === task.id)
    if (!run) return
    const done = ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)
    this.doc.set({
      runs: s.runs.map((r) => (r.taskId === task.id ? { ...r, status: task.status, summary: task.summary ?? task.error ?? r.summary, finishedAt: done ? (task.finishedAt ?? new Date().toISOString()) : undefined } : r))
    })
    const a = s.automations.find((x) => x.lastTaskId === task.id)
    if (a && a.lastStatus !== task.status) this.save({ ...a, lastStatus: task.status, lastResult: done ? (task.summary ?? task.error ?? a.lastResult) : a.lastResult })
  }
}
