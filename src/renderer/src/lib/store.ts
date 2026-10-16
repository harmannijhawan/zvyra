/**
 * Renderer store: one shared AppState per window, fed by contract snapshots
 * and push events. Components read slices with `useStore(selector)`.
 */
import { useSyncExternalStore } from 'react'
import { ACTIVE_TASK_STATUSES, type ZvyraEvent } from '@shared/contract'
import { call, errorMessage, onEvent, onShellEvent, shellCall } from './client'
import { applyEvent, byId, initialState, type AppState } from './reducer'

let state: AppState = initialState
const listeners = new Set<() => void>()

export function getState() {
  return state
}

export function setState(update: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const patch = typeof update === 'function' ? update(state) : update
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state))
}

export function navigate(route: string) {
  setState({ route })
}

/* --------------------------------------------------------------- bootstrap */

let booted = false

async function settle<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p
  } catch {
    return undefined
  }
}

/** Snapshots that both windows need. */
async function loadCore() {
  const [backendMode, system, settings, voice, interactions, tasks, permissions, swarm, projects, active, notifications, policy] =
    await Promise.all([
      settle(shellCall('app.backendMode')),
      settle(call('system.info')),
      settle(call('settings.get')),
      settle(call('voice.status')),
      settle(call('assistant.recent', { limit: 20 })),
      settle(call('tasks.list', { limit: 200 })),
      settle(call('permissions.pending')),
      settle(call('swarm.connection')),
      settle(call('projects.list')),
      settle(call('projects.active')),
      settle(call('notifications.list', { limit: 50 })),
      settle(call('notifications.policy'))
    ])
  setState((s) => ({
    backendMode: backendMode ?? null,
    system: system ?? null,
    settings: settings ?? s.settings,
    voice: voice ?? null,
    interactions: interactions ?? [],
    tasks: { ...byId(tasks ?? []), ...s.tasks },
    permissions: permissions ?? [],
    swarm: swarm ?? null,
    projects: { ...byId(projects ?? []), ...s.projects },
    activeProjectId: active?.id ?? null,
    notifications: notifications ?? [],
    notificationPolicy: policy ?? null
  }))
}

/** Extra snapshots for the main window. */
async function loadMain() {
  const [conversations, agents, runtime, computer, activity, automations] = await Promise.all([
    settle(call('chat.list', {})),
    settle(call('agents.list')),
    settle(call('agents.runtime')),
    settle(call('computer.status')),
    settle(call('activity.list', { limit: 200 })),
    settle(call('automations.list'))
  ])
  setState((s) => ({
    conversations: { ...byId(conversations ?? []), ...s.conversations },
    agents: { ...byId(agents ?? []), ...s.agents },
    runtime: runtime ?? s.runtime,
    computer: computer ?? s.computer,
    activity: activity ?? s.activity,
    automations: { ...byId(automations ?? []), ...s.automations }
  }))
}

export async function bootstrap(kind: 'main' | 'island') {
  if (booted) return
  booted = true
  setState({ boot: 'loading' })
  // Subscribe first so nothing is lost between snapshot and live events.
  onEvent((e: ZvyraEvent) => setState((s) => applyEvent(s, e)))
  onShellEvent((e) => {
    if (e.type === 'shell.island') setState({ island: e.payload })
    if (e.type === 'shell.navigate' && kind === 'main') setState({ route: e.payload.route })
  })
  try {
    await loadCore()
    if (kind === 'main') {
      await loadMain()
      setState({ setup: (await settle(call('setup.state'))) ?? null })
    }
    if (kind === 'island') setState({ island: (await settle(shellCall('island.state'))) ?? null, camera: (await settle(call('camera.state'))) ?? { open: false } })
    setState({ boot: 'ready' })
  } catch (err) {
    setState({ boot: 'error', bootError: errorMessage(err) })
  }
}

/* --------------------------------------------------------------- loaders */

export async function loadTaskEvents(taskId: string) {
  const events = await call('tasks.events', { id: taskId, limit: 400 })
  setState((s) => {
    const live = s.taskEvents[taskId] ?? []
    const ids = new Set(events.map((e) => e.id))
    return { taskEvents: { ...s.taskEvents, [taskId]: [...events, ...live.filter((e) => !ids.has(e.id))] } }
  })
}

export async function loadMessages(conversationId: string) {
  const messages = await call('chat.messages', { id: conversationId })
  setState((s) => ({ messages: { ...s.messages, [conversationId]: messages } }))
}

/* --------------------------------------------------------------- selectors */

export const selectActiveTasks = (s: AppState) => s.tasks

export function activeTasks(tasks: AppState['tasks']) {
  return Object.values(tasks)
    .filter((t) => ACTIVE_TASK_STATUSES.includes(t.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function sortedTasks(tasks: AppState['tasks']) {
  return Object.values(tasks).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function useCapability(cap: keyof NonNullable<AppState['system']>['capabilities']): boolean | undefined {
  return useStore((s) => s.system?.capabilities[cap])
}
