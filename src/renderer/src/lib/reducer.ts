/**
 * Pure state + event reducer for the renderer. Kept free of React and IPC so
 * it can be unit-tested. Every backend push event maps to one immutable update.
 */
import type {
  ActivityEntry,
  AgentInfo,
  AgentRuntime,
  AppNotification,
  AppSettings,
  Automation,
  CameraState,
  ChatMessage,
  ComputerAction,
  ComputerStatus,
  Conversation,
  DesktopToast,
  Interaction,
  NotificationPolicy,
  PermissionRequest,
  Project,
  SwarmConnection,
  SystemInfo,
  Task,
  TaskEvent,
  SetupState,
  TerminalRun,
  ToolActivity,
  VoiceStatus,
  ZvyraEvent
} from '@shared/contract'
import type { IslandState } from '@shared/shell'

export type LoadState = 'idle' | 'loading' | 'ready' | 'error'

export interface AppState {
  boot: LoadState
  bootError?: string
  backendMode: { mode: 'real' | 'mock'; reason?: string } | null
  system: SystemInfo | null
  settings: AppSettings | null
  voice: VoiceStatus | null
  voiceLevel: number
  liveTranscript: string
  interactions: Interaction[]
  tasks: Record<string, Task>
  taskEvents: Record<string, TaskEvent[]>
  permissions: PermissionRequest[]
  conversations: Record<string, Conversation>
  messages: Record<string, ChatMessage[]>
  swarm: SwarmConnection | null
  agents: Record<string, AgentInfo>
  runtime: AgentRuntime | null
  computer: ComputerStatus | null
  computerActions: ComputerAction[]
  terminalRuns: Record<string, TerminalRun>
  terminalOutput: Record<string, string>
  projects: Record<string, Project>
  activeProjectId: string | null
  activity: ActivityEntry[]
  automations: Record<string, Automation>
  notifications: AppNotification[]
  notificationPolicy: NotificationPolicy | null
  island: IslandState | null
  route: string
  /** Live tool cards (newest first). */
  tools: ToolActivity[]
  camera: CameraState
  setup: SetupState | null
  wakeTraining: { recording: number; templates: number } | null
  /** Notifications shown in the Dynamic Island (newest first). */
  notices: DesktopToast[]
}

export const initialState: AppState = {
  boot: 'idle',
  backendMode: null,
  system: null,
  settings: null,
  voice: null,
  voiceLevel: 0,
  liveTranscript: '',
  interactions: [],
  tasks: {},
  taskEvents: {},
  permissions: [],
  conversations: {},
  messages: {},
  swarm: null,
  agents: {},
  runtime: null,
  computer: null,
  computerActions: [],
  terminalRuns: {},
  terminalOutput: {},
  projects: {},
  activeProjectId: null,
  activity: [],
  automations: {},
  notifications: [],
  notificationPolicy: null,
  island: null,
  route: 'home',
  tools: [],
  camera: { open: false },
  setup: null,
  wakeTraining: null,
  notices: []
}

const MAX_TASK_EVENTS = 400
const MAX_ACTIVITY = 500
const MAX_TERMINAL_CHARS = 200_000

function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const next = { ...rec }
  delete next[key]
  return next
}

function upsertById<T extends { id: string }>(list: T[], item: T, prepend = true): T[] {
  const idx = list.findIndex((x) => x.id === item.id)
  if (idx >= 0) {
    const next = list.slice()
    next[idx] = item
    return next
  }
  return prepend ? [item, ...list] : [...list, item]
}

export function applyEvent(s: AppState, e: ZvyraEvent): AppState {
  switch (e.type) {
    case 'settings.changed':
      return { ...s, settings: e.payload }
    case 'voice.status':
      return {
        ...s,
        voice: e.payload,
        liveTranscript: e.payload.state === 'listening' ? (e.payload.partialTranscript ?? s.liveTranscript) : s.liveTranscript,
        voiceLevel: e.payload.state === 'listening' || e.payload.state === 'standby' ? s.voiceLevel : 0
      }
    case 'voice.level':
      return { ...s, voiceLevel: Math.max(0, Math.min(1, e.payload.level)) }
    case 'voice.transcript':
      return { ...s, liveTranscript: e.payload.text }
    case 'assistant.interaction':
      return { ...s, interactions: upsertById(s.interactions, e.payload).slice(0, 50) }
    case 'task.upsert':
      return { ...s, tasks: { ...s.tasks, [e.payload.id]: e.payload } }
    case 'task.event': {
      const list = s.taskEvents[e.payload.taskId] ?? []
      if (list.some((x) => x.id === e.payload.id)) return s
      return { ...s, taskEvents: { ...s.taskEvents, [e.payload.taskId]: [...list, e.payload].slice(-MAX_TASK_EVENTS) } }
    }
    case 'task.removed':
      return { ...s, tasks: omit(s.tasks, e.payload.id), taskEvents: omit(s.taskEvents, e.payload.id) }
    case 'permission.requested':
      return { ...s, permissions: upsertById(s.permissions, e.payload, false) }
    case 'permission.resolved':
      return { ...s, permissions: s.permissions.filter((p) => p.id !== e.payload.id), notices: s.notices.filter((n) => n.permissionId !== e.payload.id) }
    case 'desktop.toast':
      return { ...s, notices: [e.payload, ...s.notices.filter((n) => n.id !== e.payload.id)].slice(0, 10) }
    case 'desktop.toastDismiss':
      return { ...s, notices: s.notices.filter((n) => n.id !== e.payload.id) }
    case 'chat.conversation':
      return { ...s, conversations: { ...s.conversations, [e.payload.id]: e.payload } }
    case 'chat.conversationRemoved':
      return { ...s, conversations: omit(s.conversations, e.payload.id), messages: omit(s.messages, e.payload.id) }
    case 'chat.message': {
      const list = s.messages[e.payload.conversationId] ?? []
      return { ...s, messages: { ...s.messages, [e.payload.conversationId]: upsertById(list, e.payload, false) } }
    }
    case 'chat.delta': {
      const list = s.messages[e.payload.conversationId]
      if (!list) return s
      const idx = list.findIndex((m) => m.id === e.payload.messageId)
      if (idx < 0) return s
      const next = list.slice()
      next[idx] = { ...next[idx], content: next[idx].content + e.payload.delta, status: 'streaming' }
      return { ...s, messages: { ...s.messages, [e.payload.conversationId]: next } }
    }
    case 'swarm.connection':
      return { ...s, swarm: e.payload }
    case 'agents.update':
      return { ...s, agents: { ...s.agents, [e.payload.id]: e.payload } }
    case 'agents.runtime':
      return { ...s, runtime: e.payload }
    case 'computer.status':
      return { ...s, computer: e.payload }
    case 'computer.action':
      return { ...s, computerActions: upsertById(s.computerActions, e.payload).slice(0, 300) }
    case 'terminal.run':
      return { ...s, terminalRuns: { ...s.terminalRuns, [e.payload.id]: e.payload } }
    case 'terminal.output': {
      const prev = s.terminalOutput[e.payload.runId] ?? ''
      const text = (prev + e.payload.chunk).slice(-MAX_TERMINAL_CHARS)
      return { ...s, terminalOutput: { ...s.terminalOutput, [e.payload.runId]: text } }
    }
    case 'project.upsert':
      return { ...s, projects: { ...s.projects, [e.payload.id]: e.payload } }
    case 'project.removed':
      return {
        ...s,
        projects: omit(s.projects, e.payload.id),
        activeProjectId: s.activeProjectId === e.payload.id ? null : s.activeProjectId
      }
    case 'project.active':
      return { ...s, activeProjectId: e.payload.id }
    case 'activity.new':
      if (s.activity.some((a) => a.id === e.payload.id)) return s
      return { ...s, activity: [e.payload, ...s.activity].slice(0, MAX_ACTIVITY) }
    case 'automation.upsert':
      return { ...s, automations: { ...s.automations, [e.payload.id]: e.payload } }
    case 'automation.removed':
      return { ...s, automations: omit(s.automations, e.payload.id) }
    case 'notification.new':
      return { ...s, notifications: upsertById(s.notifications, e.payload).slice(0, 200) }
    case 'tool.activity':
      return { ...s, tools: upsertById(s.tools, e.payload).slice(0, 20) }
    case 'camera.state':
      return { ...s, camera: e.payload }
    case 'voice.wakeTraining':
      return { ...s, wakeTraining: e.payload }
    default:
      return s
  }
}

export function byId<T extends { id: string }>(list: T[]): Record<string, T> {
  const out: Record<string, T> = {}
  for (const x of list) out[x.id] = x
  return out
}
