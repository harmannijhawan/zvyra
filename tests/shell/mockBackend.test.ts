import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZvyraEvent } from '../../src/shared/contract'

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))

const { MockBackend } = await import('../../src/main/mock/mockBackend')

describe('preview backend honesty and task lifecycle', () => {
  let b: InstanceType<typeof MockBackend>
  let events: ZvyraEvent[]

  beforeEach(() => {
    vi.useFakeTimers()
    b = new MockBackend()
    events = []
    b.subscribe((e) => events.push(e))
  })
  afterEach(async () => {
    await b.dispose()
    vi.useRealTimers()
  })

  it('identifies itself as mock and never invents models or OS access', async () => {
    expect((await b.invoke('system.info', undefined)).backend).toBe('mock')
    expect(await b.invoke('models.list', {})).toEqual([])
    const test = await b.invoke('swarm.test', undefined)
    expect(test.status).toBe('error')
    await expect(b.invoke('computer.capture', undefined)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(b.invoke('terminal.run', { command: 'dir' })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('runs a risky task through planning → waiting_permission → completed', async () => {
    const t = await b.invoke('tasks.create', { instruction: 'Delete old logs', source: 'home' })
    expect(t.status).toBe('queued')
    await vi.advanceTimersByTimeAsync(8000)
    const waiting = await b.invoke('tasks.get', { id: t.id })
    expect(waiting.status).toBe('waiting_permission')
    const [req] = await b.invoke('permissions.pending', undefined)
    expect(req.category).toBe('delete_files')
    await b.invoke('permissions.respond', { id: req.id, decision: 'allow_once' })
    await vi.advanceTimersByTimeAsync(10000)
    const done = await b.invoke('tasks.get', { id: t.id })
    expect(done.status).toBe('completed')
    expect(done.summary).toMatch(/No real work was performed/)
    expect(done.progress).toEqual({ completed: 4, total: 4 })
    const statuses = events.filter((e) => e.type === 'task.upsert').map((e) => (e.payload as { status: string }).status)
    expect(statuses).toContain('planning')
    expect(statuses).toContain('running')
    expect(events.some((e) => e.type === 'permission.resolved')).toBe(true)
  })

  it('denying a permission fails the task and cancel stops it', async () => {
    const t = await b.invoke('tasks.create', { instruction: 'Send the email', source: 'home' })
    await vi.advanceTimersByTimeAsync(8000)
    const [req] = await b.invoke('permissions.pending', undefined)
    await b.invoke('permissions.respond', { id: req.id, decision: 'deny' })
    expect((await b.invoke('tasks.get', { id: t.id })).status).toBe('failed')

    const t2 = await b.invoke('tasks.create', { instruction: 'Summarise notes', source: 'home' })
    await vi.advanceTimersByTimeAsync(1000)
    expect((await b.invoke('tasks.cancel', { id: t2.id })).status).toBe('cancelled')
  })

  it('locks dangerous categories out of "allow"', async () => {
    await expect(b.invoke('permissions.setPolicy', { category: 'delete_files', policy: 'allow' })).rejects.toMatchObject({ code: 'INVALID_ARGS' })
  })

  it('streams chat replies and supports stop', async () => {
    const c = await b.invoke('chat.create', {})
    const placeholder = await b.invoke('chat.send', { conversationId: c.id, text: 'hello' })
    expect(placeholder.status).toBe('streaming')
    await vi.advanceTimersByTimeAsync(200)
    await b.invoke('chat.stop', { conversationId: c.id })
    const msgs = await b.invoke('chat.messages', { id: c.id })
    expect(msgs.at(-1)?.status).toBe('stopped')
    expect(events.some((e) => e.type === 'chat.delta')).toBe(true)
  })

  it('push-to-talk walks listening → transcribing → resting state', async () => {
    await b.invoke('voice.startListening', { source: 'island' })
    expect((await b.invoke('voice.status', undefined)).state).toBe('listening')
    await b.invoke('voice.stopListening', undefined)
    expect((await b.invoke('voice.status', undefined)).state).toBe('transcribing')
    await vi.advanceTimersByTimeAsync(1000)
    expect((await b.invoke('voice.status', undefined)).state).toBe('off')
  })
})
