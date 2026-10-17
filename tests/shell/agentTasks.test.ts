import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task, TaskEvent } from '../../src/shared/contract'
import { AgentTasks, type AgentTasksState } from '../../src/main/desktop/agentTasks'
import { JsonDoc } from '../../src/main/desktop/jsonDoc'

let dir = ''
let upserts: Task[] = []
let events: TaskEvent[] = []
let tasks: AgentTasks
const mk = () => new AgentTasks(new JsonDoc<AgentTasksState>(join(dir, 'tasks.json'), { tasks: [], events: {} }), (t) => upserts.push(t), (e) => events.push(e))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zvyra-agent-tasks-'))
  upserts = []
  events = []
  tasks = mk()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('agent tasks', () => {
  it('shows a build as a running task with live steps, then completed', () => {
    const t = tasks.start('Make me a calculator\n\nContext from saved memory:\n- x', 'voice', new AbortController())
    expect(t.status).toBe('running')
    expect(t.instruction).toBe('Make me a calculator')
    tasks.step(t.id, 'Writing calculator/index.html')
    tasks.step(t.id, 'Opening index.html')
    expect(tasks.get(t.id)!.plan.map((s) => s.status)).toEqual(['done', 'running'])
    tasks.finish(t.id, { status: 'completed', summary: 'Built it', files: ['C:\\x\\index.html'] })
    const done = tasks.get(t.id)!
    expect(done.status).toBe('completed')
    expect(done.plan.every((s) => s.status === 'done')).toBe(true)
    expect(done.finishedAt).toBeTruthy()
    expect(upserts.at(-1)!.status).toBe('completed')
    expect(tasks.events(t.id).map((e) => e.message)).toContain('Completed')
  })
  it('cancel aborts the running job', () => {
    const ctrl = new AbortController()
    const t = tasks.start('Build a store', 'island', ctrl)
    tasks.cancel(t.id)
    expect(ctrl.signal.aborted).toBe(true)
  })
  it('marks tasks left running by a previous app run as interrupted', async () => {
    const t = tasks.start('Long build', 'voice', new AbortController())
    // Force the pending write, then reload.
    await (tasks as unknown as { doc: JsonDoc<AgentTasksState> }).doc.flush()
    const again = mk()
    expect(again.get(t.id)!.status).toBe('interrupted')
    expect(again.get(t.id)!.canRetry).toBe(true)
  })
  it('clears only finished tasks', () => {
    const a = tasks.start('a', 'voice', new AbortController())
    const b = tasks.start('b', 'voice', new AbortController())
    tasks.finish(a.id, { status: 'failed', error: 'x' })
    expect(tasks.clearFinished()).toEqual([a.id])
    expect(tasks.has(b.id)).toBe(true)
  })
})
