import { useEffect, useMemo, useState } from 'react'
import type { InteractionSource } from '@shared/contract'
import { call, ClientError } from './client'
import { deriveCompanion, nextCompanionTick, type CompanionView } from './companion'
import { activeTasks, getState, useStore } from './store'
import { attempt, reportError } from './useAction'

/** Re-render every `ms` (for clocks and relative times). */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function useCompanion(): CompanionView {
  const voice = useStore((s) => s.voice)
  const tasks = useStore((s) => s.tasks)
  const permissions = useStore((s) => s.permissions)
  const interactions = useStore((s) => s.interactions)
  const swarm = useStore((s) => s.swarm?.status ?? null)
  const dnd = useStore((s) => !!s.notificationPolicy?.doNotDisturb)
  const [tick, setTick] = useState(0)
  const list = useMemo(() => Object.values(tasks), [tasks])
  const view = useMemo(
    () =>
      deriveCompanion(
        { voice: voice?.state ?? null, tasks: list, permissions, interactions, swarm, dnd, now: Date.now() },
        voice?.wakePhrase
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [voice, list, permissions, interactions, swarm, dnd, tick]
  )
  useEffect(() => {
    const next = nextCompanionTick(list, Date.now())
    if (next === null) return
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(50, next - Date.now() + 30))
    return () => clearTimeout(t)
  }, [list, tick])
  return view
}

export function useActiveTasks() {
  const tasks = useStore((s) => s.tasks)
  return useMemo(() => activeTasks(tasks), [tasks])
}

/* --------------------------------------------------------------- voice */

export async function toggleListening(source: InteractionSource) {
  const v = getState().voice
  if (!v) return reportError(new ClientError({ code: 'UNAVAILABLE', message: 'Voice status is not available yet.' }))
  if (v.state === 'speaking') return attempt(() => call('voice.stopSpeaking'))
  if (v.state === 'listening' || v.state === 'wake_detected') {
    try {
      await call('voice.stopListening')
    } catch (err) {
      if (err instanceof ClientError && err.code === 'NOT_IMPLEMENTED') await attempt(() => call('voice.cancel'))
      else reportError(err)
    }
    return
  }
  if (v.state === 'transcribing') return attempt(() => call('voice.cancel'))
  return attempt(() => call('voice.startListening', { source }), { errorTitle: 'Couldn’t start listening' })
}

export function setWakeWord(enabled: boolean) {
  return attempt(() => call('voice.setWakeWord', { enabled }), {
    success: enabled ? 'Listening for “Hey Zvyra”' : 'Wake word off',
    errorTitle: 'Wake word'
  })
}

/* --------------------------------------------------------------- assistant */

export async function submitInstruction(text: string, source: InteractionSource, model?: string) {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const projectId = getState().activeProjectId ?? undefined
  return attempt(() => call('assistant.submit', { text: trimmed, source, projectId, model }), { errorTitle: 'Couldn’t send that' })
}
