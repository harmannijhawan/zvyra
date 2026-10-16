/**
 * ZVYRA shared integration contract — push events (backend → UI).
 *
 * Ownership: SHARED. The backend emits these through `ZvyraBackend.subscribe`;
 * main broadcasts them to every renderer on 'zvyra:event'. Upsert events carry
 * the full entity so the UI can replace its copy without re-fetching.
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
  Interaction,
  PermissionRequest,
  Project,
  SwarmConnection,
  Task,
  TaskEvent,
  TerminalRun,
  ToolActivity,
  VoiceStatus
} from './types'

export interface ZvyraEventMap {
  'settings.changed': AppSettings
  'voice.status': VoiceStatus
  /** Microphone input level 0..1, ~15 Hz while capturing or in standby. */
  'voice.level': { level: number }
  'voice.transcript': { text: string; final: boolean }
  'assistant.interaction': Interaction
  'task.upsert': Task
  'task.event': TaskEvent
  'task.removed': { id: string }
  'permission.requested': PermissionRequest
  'permission.resolved': { id: string; decision: 'allow_once' | 'allow_task' | 'deny' | 'expired' }
  'chat.conversation': Conversation
  'chat.conversationRemoved': { id: string }
  'chat.message': ChatMessage
  'chat.delta': { conversationId: string; messageId: string; delta: string }
  'swarm.connection': SwarmConnection
  'agents.update': AgentInfo
  'agents.runtime': AgentRuntime
  'computer.status': ComputerStatus
  'computer.action': ComputerAction
  'terminal.output': { runId: string; stream: 'stdout' | 'stderr'; chunk: string }
  'terminal.run': TerminalRun
  'project.upsert': Project
  'project.removed': { id: string }
  'project.active': { id: string | null }
  'activity.new': ActivityEntry
  'automation.upsert': Automation
  'automation.removed': { id: string }
  'notification.new': AppNotification
  /** A desktop tool started, progressed or finished (research, media, camera, builder…). */
  'tool.activity': ToolActivity
  /** Personal wake-word recording progress (samples still to record, samples saved). */
  'voice.wakeTraining': { recording: number; templates: number }
  /** Live camera preview in the Dynamic Island. */
  'camera.state': CameraState
}

export type ZvyraEventType = keyof ZvyraEventMap

export type ZvyraEvent = {
  [K in ZvyraEventType]: { type: K; payload: ZvyraEventMap[K] }
}[ZvyraEventType]
