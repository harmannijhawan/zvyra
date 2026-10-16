import { describe, expect, it } from 'vitest'
import type { ChatMessage, ZvyraEvent } from '@shared/contract'
import { applyEvent, initialState, type AppState } from '@renderer/lib/reducer'

const run = (events: ZvyraEvent[], s: AppState = initialState) => events.reduce(applyEvent, s)

const msg = (p: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1',
  conversationId: 'c1',
  role: 'assistant',
  content: '',
  createdAt: '',
  status: 'streaming',
  ...p
})

describe('applyEvent', () => {
  it('streams chat deltas into the placeholder and finalises with an upsert', () => {
    const s = run([
      { type: 'chat.message', payload: msg({}) },
      { type: 'chat.delta', payload: { conversationId: 'c1', messageId: 'm1', delta: 'Hel' } },
      { type: 'chat.delta', payload: { conversationId: 'c1', messageId: 'm1', delta: 'lo' } }
    ])
    expect(s.messages.c1[0].content).toBe('Hello')
    const done = applyEvent(s, { type: 'chat.message', payload: msg({ content: 'Hello', status: 'complete' }) })
    expect(done.messages.c1).toHaveLength(1)
    expect(done.messages.c1[0].status).toBe('complete')
  })

  it('ignores deltas for unknown conversations', () => {
    const s = applyEvent(initialState, { type: 'chat.delta', payload: { conversationId: 'x', messageId: 'y', delta: 'z' } })
    expect(s).toBe(initialState)
  })

  it('tracks permissions until resolved', () => {
    const req = { id: 'p1', category: 'write_files' as const, title: 't', description: 'd', risk: 'low' as const, createdAt: '' }
    const s = run([{ type: 'permission.requested', payload: req }])
    expect(s.permissions).toHaveLength(1)
    expect(applyEvent(s, { type: 'permission.resolved', payload: { id: 'p1', decision: 'deny' } }).permissions).toHaveLength(0)
  })

  it('dedupes task events and activity by id', () => {
    const ev = { id: 'e1', taskId: 't1', ts: '', kind: 'status' as const, message: 'x' }
    const s = run([
      { type: 'task.event', payload: ev },
      { type: 'task.event', payload: ev }
    ])
    expect(s.taskEvents.t1).toHaveLength(1)
    const a = { id: 'a1', ts: '', type: 'task.started', title: 'x', level: 'info' as const }
    expect(run([{ type: 'activity.new', payload: a }, { type: 'activity.new', payload: a }]).activity).toHaveLength(1)
  })

  it('removes a project and clears it as active', () => {
    const p = { id: 'p1', name: 'P', path: 'C:/p', favorite: false, status: 'open' as const, createdAt: '' }
    const s = run([
      { type: 'project.upsert', payload: p },
      { type: 'project.active', payload: { id: 'p1' } },
      { type: 'project.removed', payload: { id: 'p1' } }
    ])
    expect(s.projects.p1).toBeUndefined()
    expect(s.activeProjectId).toBeNull()
  })

  it('clamps microphone level and resets it when capture stops', () => {
    let s = applyEvent(initialState, { type: 'voice.level', payload: { level: 3 } })
    expect(s.voiceLevel).toBe(1)
    s = applyEvent(s, {
      type: 'voice.status',
      payload: {
        state: 'off',
        wakeWordEnabled: false,
        wakePhrase: 'Hey Zvyra',
        wake: { id: 'w', name: 'w', ready: true, processing: 'local' },
        stt: { id: 's', name: 's', ready: true, processing: 'local' },
        tts: { id: 't', name: 't', ready: true, processing: 'local' },
        micAvailable: true,
        micDeviceId: null
      }
    })
    expect(s.voiceLevel).toBe(0)
  })
})
