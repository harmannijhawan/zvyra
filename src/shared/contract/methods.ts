/**
 * ZVYRA shared integration contract — request/response methods.
 *
 * Ownership: SHARED (UI ↔ backend). The backend implements every method in
 * `ZvyraMethods`. Methods it does not support yet must reject with
 * `{ code: 'NOT_IMPLEMENTED' }` so the UI can render an honest state.
 *
 * Transport: renderer → preload `window.zvyra.invoke(method, args)` →
 * ipcMain 'zvyra:invoke' → `ZvyraBackend.invoke(method, args)`.
 */
import type {
  ActiveWindowInfo,
  ActivityEntry,
  AgentInfo,
  AgentRuntime,
  AppNotification,
  AppSettings,
  Attachment,
  Automation,
  AutomationRun,
  CallProviderStatus,
  CameraState,
  CommandRule,
  CommandShell,
  KeyTestResult,
  SetupProviderId,
  SetupState,
  ChatMessage,
  ComputerAction,
  ComputerStatus,
  Conversation,
  CreateTaskInput,
  DeepPartial,
  DiagnosticCheck,
  FileContent,
  FileEntry,
  FileRoot,
  Integration,
  Interaction,
  InteractionSource,
  LaunchableApp,
  LogEntry,
  LogLevel,
  MemoryItem,
  MemoryKind,
  MemorySettings,
  MicDevice,
  ModelInfo,
  NotificationPolicy,
  PermissionCategory,
  PermissionDecision,
  PermissionPolicy,
  PermissionPolicyEntry,
  PermissionRequest,
  Project,
  RoutingConfig,
  Schedule,
  SchedulerStatus,
  ScreenCapture,
  SwarmConnection,
  SystemInfo,
  Task,
  TaskEvent,
  TaskStatus,
  TerminalRun,
  VoiceEngineOption,
  VoiceStatus
} from './types'

type M<A, R> = { args: A; result: R }
type Id = { id: string }

export interface ZvyraMethods {
  /* System ------------------------------------------------------------ */
  'system.info': M<void, SystemInfo>
  'system.diagnostics': M<void, DiagnosticCheck[]>
  'system.logs': M<{ limit?: number; level?: LogLevel; query?: string }, LogEntry[]>
  'system.openLogsFolder': M<void, void>
  'system.openDataFolder': M<void, void>
  /** Emergency stop: cancel all tasks, stop computer control, capture and speech. */
  'system.stopAll': M<void, { cancelledTasks: number }>

  /* Settings ---------------------------------------------------------- */
  'settings.get': M<void, AppSettings>
  'settings.update': M<DeepPartial<AppSettings>, AppSettings>

  /* Voice ------------------------------------------------------------- */
  'voice.status': M<void, VoiceStatus>
  'voice.setWakeWord': M<{ enabled: boolean }, VoiceStatus>
  /** Push-to-talk start. Resolves once capture has started (not when it ends). */
  'voice.startListening': M<{ source: InteractionSource }, VoiceStatus>
  /** Finish capture now and transcribe what was recorded. */
  'voice.stopListening': M<void, VoiceStatus>
  /** Abort capture/transcription without submitting. */
  'voice.cancel': M<void, VoiceStatus>
  'voice.speak': M<{ text: string }, void>
  'voice.stopSpeaking': M<void, void>
  'voice.devices': M<void, MicDevice[]>
  'voice.selectDevice': M<{ deviceId: string | null }, VoiceStatus>
  'voice.engines': M<void, VoiceEngineOption[]>
  /** Secret fields are write-only; send empty string to keep the stored value. */
  'voice.configureEngine': M<{ engineId: string; values: Record<string, string | number | boolean> }, VoiceEngineOption[]>
  'voice.testEngine': M<{ engineId: string }, { ok: boolean; message: string }>

  /* Assistant entry point ------------------------------------------- */
  'assistant.submit': M<{ text: string; source: InteractionSource; projectId?: string; model?: string }, Interaction>
  'assistant.cancel': M<Id, void>
  'assistant.recent': M<{ limit?: number }, Interaction[]>

  /* Tasks ------------------------------------------------------------- */
  'tasks.list': M<{ status?: TaskStatus[]; projectId?: string; limit?: number }, Task[]>
  'tasks.get': M<Id, Task>
  'tasks.events': M<{ id: string; limit?: number }, TaskEvent[]>
  'tasks.create': M<CreateTaskInput, Task>
  'tasks.cancel': M<Id, Task>
  'tasks.pause': M<Id, Task>
  'tasks.resume': M<Id, Task>
  'tasks.retry': M<Id, Task>
  /** Redirect or follow up on a running task without losing its context. */
  'tasks.message': M<{ id: string; text: string }, Task>
  'tasks.delete': M<Id, void>
  'tasks.clearHistory': M<void, { removed: number }>

  /* Permissions ------------------------------------------------------- */
  'permissions.pending': M<void, PermissionRequest[]>
  'permissions.respond': M<{ id: string; decision: PermissionDecision }, void>
  'permissions.policies': M<void, PermissionPolicyEntry[]>
  'permissions.setPolicy': M<{ category: PermissionCategory; policy: PermissionPolicy }, PermissionPolicyEntry[]>
  /** (1.4.0) Saved "Always allow" command rules. */
  'permissions.rules': M<void, CommandRule[]>
  /** (1.4.0) Revoke one saved rule; returns the remaining rules. */
  'permissions.revokeRule': M<Id, CommandRule[]>

  /* Chat -------------------------------------------------------------- */
  'chat.list': M<{ projectId?: string }, Conversation[]>
  'chat.create': M<{ title?: string; projectId?: string; model?: string }, Conversation>
  'chat.rename': M<{ id: string; title: string }, Conversation>
  'chat.delete': M<Id, void>
  'chat.setModel': M<{ id: string; model: string | null }, Conversation>
  'chat.messages': M<Id, ChatMessage[]>
  /** Resolves with the assistant placeholder message; content streams via 'chat.delta'. */
  'chat.send': M<{ conversationId: string; text: string; attachmentIds?: string[]; model?: string }, ChatMessage>
  'chat.stop': M<{ conversationId: string }, void>
  'chat.retry': M<{ conversationId: string }, ChatMessage>
  /** Backend opens a native file dialog; renderer never receives raw paths. */
  'chat.pickAttachments': M<void, Attachment[]>
  'chat.runAsTask': M<{ conversationId: string; messageId: string }, Task>

  /* SWARM & models ---------------------------------------------------- */
  'swarm.connection': M<void, SwarmConnection>
  /** apiKey: undefined = keep stored key; '' = clear. */
  'swarm.configure': M<{ baseUrl: string; apiKey?: string }, SwarmConnection>
  'swarm.test': M<void, SwarmConnection>
  'models.list': M<{ refresh?: boolean }, ModelInfo[]>
  'routing.get': M<void, RoutingConfig>
  'routing.set': M<Partial<RoutingConfig>, RoutingConfig>

  /* Agents ------------------------------------------------------------ */
  'agents.list': M<void, AgentInfo[]>
  'agents.runtime': M<void, AgentRuntime>
  'agents.setEnabled': M<{ id: string; enabled: boolean }, AgentInfo>
  'agents.setModel': M<{ id: string; model: string | null }, AgentInfo>
  'agents.stop': M<Id, AgentInfo>

  /* Computer control -------------------------------------------------- */
  'computer.status': M<void, ComputerStatus>
  'computer.setEnabled': M<{ enabled: boolean }, ComputerStatus>
  'computer.stop': M<void, ComputerStatus>
  'computer.capture': M<void, ScreenCapture>
  'computer.activeWindow': M<void, ActiveWindowInfo | null>
  'computer.windows': M<void, ActiveWindowInfo[]>
  'computer.history': M<{ limit?: number }, ComputerAction[]>

  /* Apps & integrations ---------------------------------------------- */
  'apps.integrations': M<void, Integration[]>
  'apps.launchable': M<void, LaunchableApp[]>
  'apps.launch': M<Id, void>
  'apps.add': M<void, LaunchableApp | null>
  'apps.remove': M<Id, void>
  'apps.setPinned': M<{ id: string; pinned: boolean }, LaunchableApp>
  'browser.open': M<{ url: string }, void>
  'code.openInEditor': M<{ projectId?: string; path?: string }, void>

  /* Terminal (backend enforces run_commands permission) -------------- */
  /** (1.4.0) `shell` picks Command Prompt or Windows PowerShell (default). */
  'terminal.run': M<{ command: string; cwd?: string; projectId?: string; shell?: CommandShell }, TerminalRun>
  'terminal.kill': M<Id, TerminalRun>
  'terminal.runs': M<{ limit?: number }, TerminalRun[]>
  'terminal.openExternal': M<{ cwd?: string }, void>

  /* Files (restricted to authorised roots) --------------------------- */
  'files.roots': M<void, FileRoot[]>
  'files.addRoot': M<void, FileRoot | null>
  'files.removeRoot': M<{ path: string }, void>
  'files.list': M<{ path: string }, FileEntry[]>
  'files.read': M<{ path: string }, FileContent>
  'files.write': M<{ path: string; content: string }, FileContent>
  'files.reveal': M<{ path: string }, void>
  'files.openExternal': M<{ path: string }, void>

  /* Projects ---------------------------------------------------------- */
  'projects.list': M<void, Project[]>
  'projects.active': M<void, Project | null>
  'projects.pickFolder': M<void, string | null>
  'projects.create': M<{ name: string; path: string; createFolder?: boolean }, Project>
  'projects.open': M<Id, Project>
  'projects.close': M<Id, Project>
  'projects.setActive': M<{ id: string | null }, Project | null>
  'projects.rename': M<{ id: string; name: string }, Project>
  'projects.setFavorite': M<{ id: string; favorite: boolean }, Project>
  'projects.updateContext': M<{ id: string; context: string }, Project>
  /** Removes ZVYRA metadata. trashFolder moves the folder to the Recycle Bin. */
  'projects.delete': M<{ id: string; trashFolder: boolean }, void>

  /* Activity ---------------------------------------------------------- */
  'activity.list': M<{ query?: string; types?: string[]; limit?: number; before?: string }, ActivityEntry[]>
  'activity.clear': M<void, void>

  /* Memory ------------------------------------------------------------ */
  'memory.list': M<{ query?: string; kind?: MemoryKind; projectId?: string }, MemoryItem[]>
  'memory.create': M<Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt' | 'source'>, MemoryItem>
  'memory.update': M<{ id: string } & Partial<Omit<MemoryItem, 'id' | 'createdAt' | 'source'>>, MemoryItem>
  'memory.delete': M<Id, void>
  'memory.clear': M<{ kind?: MemoryKind }, { removed: number }>
  'memory.settings': M<void, MemorySettings>
  'memory.setSettings': M<Partial<MemorySettings>, MemorySettings>

  /* Automations ------------------------------------------------------- */
  'automations.list': M<void, Automation[]>
  'automations.scheduler': M<void, SchedulerStatus>
  'automations.create': M<{ name: string; instruction: string; schedule: Schedule; enabled: boolean; agentId?: string; projectId?: string }, Automation>
  'automations.update': M<{ id: string } & Partial<Omit<Automation, 'id' | 'createdAt'>>, Automation>
  'automations.delete': M<Id, void>
  'automations.runNow': M<Id, Task>
  'automations.runs': M<{ id: string; limit?: number }, AutomationRun[]>

  /* Notifications & calls -------------------------------------------- */
  'notifications.list': M<{ limit?: number; unreadOnly?: boolean }, AppNotification[]>
  'notifications.markRead': M<{ id?: string }, void>
  'notifications.clear': M<void, void>
  'notifications.policy': M<void, NotificationPolicy>
  'notifications.setPolicy': M<DeepPartial<NotificationPolicy>, NotificationPolicy>
  'notifications.snooze': M<{ minutes: number | null }, NotificationPolicy>
  'notifications.test': M<void, AppNotification>
  'calls.status': M<void, CallProviderStatus>
  'calls.configure': M<{ provider: string; values: Record<string, string | number | boolean> }, CallProviderStatus>
  'calls.setEnabled': M<{ enabled: boolean; minPriority?: AppNotification['priority'] }, CallProviderStatus>
  /** Places a real test call. Rejects with NOT_CONFIGURED when no provider is set up. */
  'calls.test': M<void, CallProviderStatus>

  /** Teach the wake word with the user's own voice: start = record the next 5 phrases; clear = forget them. */
  'voice.trainWake': M<{ action: 'start' | 'clear' }, { templates: number; recording: number }>

  /* First-run setup --------------------------------------------------- */
  'setup.state': M<void, SetupState>
  /** Sends a tiny real request with the key; saves it when it works. */
  'setup.testKey': M<{ provider: SetupProviderId; key: string }, KeyTestResult>
  /** Plays sample live cards in the Dynamic Island. */
  'setup.demo': M<void, void>
  'setup.complete': M<{ name?: string }, SetupState>

  /* Camera (preview lives in the Dynamic Island) ---------------------- */
  'camera.state': M<void, CameraState>
  /** Island → main: a still frame (JPEG data URL) for a pending capture, or why it failed. */
  'camera.frame': M<{ captureId: string; dataUrl?: string; error?: string }, void>
  'camera.close': M<void, CameraState>
}

export type MethodName = keyof ZvyraMethods
export type MethodArgs<K extends MethodName> = ZvyraMethods[K]['args']
export type MethodResult<K extends MethodName> = ZvyraMethods[K]['result']

/** Runtime list used by main to reject unknown channels. Keep in sync with ZvyraMethods. */
export const METHOD_NAMES = [
  'system.info', 'system.diagnostics', 'system.logs', 'system.openLogsFolder', 'system.openDataFolder', 'system.stopAll',
  'settings.get', 'settings.update',
  'voice.status', 'voice.setWakeWord', 'voice.startListening', 'voice.stopListening', 'voice.cancel', 'voice.speak',
  'voice.stopSpeaking', 'voice.devices', 'voice.selectDevice', 'voice.engines', 'voice.configureEngine', 'voice.testEngine',
  'assistant.submit', 'assistant.cancel', 'assistant.recent',
  'tasks.list', 'tasks.get', 'tasks.events', 'tasks.create', 'tasks.cancel', 'tasks.pause', 'tasks.resume', 'tasks.retry',
  'tasks.message', 'tasks.delete', 'tasks.clearHistory',
  'permissions.pending', 'permissions.respond', 'permissions.policies', 'permissions.setPolicy', 'permissions.rules',
  'permissions.revokeRule',
  'chat.list', 'chat.create', 'chat.rename', 'chat.delete', 'chat.setModel', 'chat.messages', 'chat.send', 'chat.stop',
  'chat.retry', 'chat.pickAttachments', 'chat.runAsTask',
  'swarm.connection', 'swarm.configure', 'swarm.test', 'models.list', 'routing.get', 'routing.set',
  'agents.list', 'agents.runtime', 'agents.setEnabled', 'agents.setModel', 'agents.stop',
  'computer.status', 'computer.setEnabled', 'computer.stop', 'computer.capture', 'computer.activeWindow', 'computer.windows',
  'computer.history',
  'apps.integrations', 'apps.launchable', 'apps.launch', 'apps.add', 'apps.remove', 'apps.setPinned', 'browser.open',
  'code.openInEditor',
  'terminal.run', 'terminal.kill', 'terminal.runs', 'terminal.openExternal',
  'files.roots', 'files.addRoot', 'files.removeRoot', 'files.list', 'files.read', 'files.write', 'files.reveal',
  'files.openExternal',
  'projects.list', 'projects.active', 'projects.pickFolder', 'projects.create', 'projects.open', 'projects.close',
  'projects.setActive', 'projects.rename', 'projects.setFavorite', 'projects.updateContext', 'projects.delete',
  'activity.list', 'activity.clear',
  'memory.list', 'memory.create', 'memory.update', 'memory.delete', 'memory.clear', 'memory.settings', 'memory.setSettings',
  'automations.list', 'automations.scheduler', 'automations.create', 'automations.update', 'automations.delete',
  'automations.runNow', 'automations.runs',
  'notifications.list', 'notifications.markRead', 'notifications.clear', 'notifications.policy', 'notifications.setPolicy',
  'notifications.snooze', 'notifications.test',
  'calls.status', 'calls.configure', 'calls.setEnabled', 'calls.test', 'voice.trainWake',
  'setup.state', 'setup.testKey', 'setup.demo', 'setup.complete',
  'camera.state', 'camera.frame', 'camera.close'
] as const satisfies readonly MethodName[]

// Compile-time guard: every ZvyraMethods key must appear in METHOD_NAMES.
type _Missing = Exclude<MethodName, (typeof METHOD_NAMES)[number]>
export const _methodNamesComplete: [_Missing] extends [never] ? true : _Missing = true
