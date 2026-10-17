/**
 * OWNER: Kiro. Tasks for work done by ZVYRA's own desktop agent (builder jobs
 * from voice/run_task and typed commands that do real work). They appear in
 * the Tasks screen next to engine tasks, with live steps, events, the result
 * and cancel / retry. Persisted so history survives restarts.
 */
import { randomUUID } from 'node:crypto'
import type { InteractionSource, Task, TaskEvent, TaskEventKind, TaskStep } from '../../shared/contract'
import type { JsonDoc } from './jsonDoc'

export interface AgentTasksState {
  tasks: Task[]
  events: Record<string, TaskEvent[]>
}

const MAX_TASKS = 200
const MAX_EVENTS = 300
const MAX_STEPS = 24

export class AgentTasks {
  private controllers = new Map<string, AbortController>()

  constructor(
    private readonly doc: JsonDoc<AgentTasksState>,
    private readonly emitTask: (t: Task) => void,
    private readonly emitEvent: (e: TaskEvent) => void
  ) {
    // Anything still running belongs to a previous run of the app.
    const now = new Date().toISOString()
    doc.set((s) => ({
      tasks: s.tasks.map((t) => (['running', 'planning', 'queued', 'verifying'].includes(t.status) ? { ...t, status: 'interrupted' as const, finishedAt: t.finishedAt ?? now, updatedAt: now, canRetry: true } : t))
    }))
  }

  has(id: string) {
    return this.doc.get().tasks.some((t) => t.id === id)
  }
  get(id: string) {
    return this.doc.get().tasks.find((t) => t.id === id)
  }
  list() {
    return this.doc.get().tasks
  }
  events(id: string, limit = 400) {
    return (this.doc.get().events[id] ?? []).slice(-limit)
  }

  start(instruction: string, source: InteractionSource, ctrl: AbortController, title?: string): Task {
    const now = new Date().toISOString()
    const clean = instruction.split('\n\nContext from saved memory:')[0].trim()
    const t: Task = {
      id: `zt-${randomUUID()}`,
      title: (title ?? clean).replace(/\s+/g, ' ').slice(0, 80) || 'Task',
      instruction: clean,
      status: 'running',
      source,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      plan: [],
      currentAction: 'Planning…',
      canPause: false,
      canResume: false,
      canRetry: false
    }
    this.controllers.set(t.id, ctrl)
    this.save(t)
    this.event(t.id, 'status', 'Started')
    return t
  }

  /** A new step started (previous one is done). */
  step(id: string, action: string) {
    const t = this.get(id)
    if (!t || t.status !== 'running') return
    const plan: TaskStep[] = t.plan.map((s) => (s.status === 'running' ? { ...s, status: /— failed$/.test(s.title) ? 'failed' : 'done' } : s))
    plan.push({ id: randomUUID(), title: action, status: 'running' })
    this.save({ ...t, plan: plan.slice(-MAX_STEPS), currentAction: action })
    this.event(id, 'tool_call', action)
  }

  progress(id: string, note: string) {
    const t = this.get(id)
    if (!t || t.status !== 'running' || t.currentAction === note) return
    this.save({ ...t, currentAction: note })
  }

  finish(id: string, outcome: { status: 'completed' | 'failed' | 'cancelled'; summary?: string; error?: string; files?: string[] }) {
    const t = this.get(id)
    if (!t) return
    this.controllers.delete(id)
    const now = new Date().toISOString()
    const stepStatus = outcome.status === 'completed' ? 'done' : outcome.status === 'cancelled' ? 'skipped' : 'failed'
    const plan = t.plan.map((s) => (s.status === 'running' || s.status === 'pending' ? { ...s, status: stepStatus as TaskStep['status'] } : s))
    const output = outcome.files?.length ? `Files:\n${outcome.files.join('\n')}` : undefined
    this.save({ ...t, status: outcome.status, plan, summary: outcome.summary, error: outcome.error, output, currentAction: undefined, finishedAt: now, canRetry: outcome.status !== 'completed' })
    this.event(id, outcome.status === 'failed' ? 'error' : 'status', outcome.status === 'completed' ? 'Completed' : outcome.status === 'cancelled' ? 'Cancelled' : `Failed: ${outcome.error ?? ''}`.trim())
  }

  cancel(id: string): Task | undefined {
    this.controllers.get(id)?.abort()
    return this.get(id)
  }

  cancelAll() {
    for (const c of this.controllers.values()) c.abort()
  }

  remove(id: string) {
    this.controllers.get(id)?.abort()
    this.doc.set((s) => {
      const events = { ...s.events }
      delete events[id]
      return { tasks: s.tasks.filter((t) => t.id !== id), events }
    })
  }

  /** Removes finished tasks; returns their ids. */
  clearFinished(): string[] {
    const done = this.list().filter((t) => !this.controllers.has(t.id)).map((t) => t.id)
    for (const id of done) this.remove(id)
    return done
  }

  private save(t: Task) {
    const next = { ...t, updatedAt: new Date().toISOString() }
    this.doc.set((s) => ({ tasks: [next, ...s.tasks.filter((x) => x.id !== t.id)].slice(0, MAX_TASKS) }))
    this.emitTask(next)
  }

  private event(taskId: string, kind: TaskEventKind, message: string) {
    const e: TaskEvent = { id: randomUUID(), taskId, ts: new Date().toISOString(), kind, message }
    this.doc.set((s) => ({ events: { ...s.events, [taskId]: [...(s.events[taskId] ?? []), e].slice(-MAX_EVENTS) } }))
    this.emitEvent(e)
  }
}
