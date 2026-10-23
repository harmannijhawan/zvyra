/**
 * OWNER: Kiro (UI). iOS PREVIEW ADAPTER — NOT A BACKEND.
 *
 * Browser-safe port of src/main/mock/mockBackend.ts for the standalone iOS
 * app. It runs entirely inside the WKWebView — no Node, no Electron, no OS
 * access — and implements the shared contract in memory so the same ZVYRA UI
 * and animations can run on iPhone/iPad.
 *
 * Only three things differ from the desktop preview adapter, all because this
 * runs in a browser instead of the Electron main process:
 *  - IDs use the Web Crypto `crypto.randomUUID()` instead of node:crypto.
 *  - `projects.pickFolder` has no native folder dialog, so it returns null.
 *  - `system.info().platform` reports 'ios' and onboarding is always complete
 *    (there is no process.argv to carry `--onboarding`).
 *
 * Honesty rules are unchanged:
 *  - system.info().backend === 'mock' → the UI shows a persistent preview banner.
 *  - It never touches the OS: no capture, no input, no commands, no network.
 *  - Simulated tasks/replies say so in their text.
 *  - It reports no SWARM models and cannot connect.
 */
import {
  CONTRACT_VERSION,
  ZvyraError,
  type ActivityEntry,
  type AgentInfo,
  type AppNotification,
  type AppSettings,
  type Automation,
  type CallProviderStatus,
  type ChatMessage,
  type Conversation,
  type Interaction,
  type MemoryItem,
  type MemorySettings,
  type MethodArgs,
  type MethodName,
  type MethodResult,
  type NotificationPolicy,
  type PermissionCategory,
  type PermissionPolicyEntry,
  type PermissionRequest,
  type Project,
  type RoutingConfig,
  type SwarmConnection,
  type Task,
  type TaskEvent,
  type VoiceStatus,
  type ZvyraBackend,
  type ZvyraEvent,
  type ZvyraEventMap
} from '@shared/contract'
import { DEFAULT_NOTIFICATION_POLICY, DEFAULT_ROUTING, DEFAULT_SETTINGS, deepMerge } from '@shared/defaults'

type Handlers = { [K in MethodName]: (args: MethodArgs<K>) => Promise<MethodResult<K>> | MethodResult<K> }

/** Browser timer handle (setTimeout/setInterval return a number on the web). */
type Timer = ReturnType<typeof setTimeout>

const now = () => new Date().toISOString()
const id = () => crypto.randomUUID()
const PREVIEW = 'Preview backend: '

const unavailable = (what: string): never => {
  throw new ZvyraError('UNAVAILABLE', `${PREVIEW}${what} is provided by the real backend, which is not connected yet.`)
}

const AGENTS: Omit<AgentInfo, 'state' | 'activeTaskIds'>[] = [
  { id: 'general', name: 'Assistant', role: 'general', description: 'Understands requests, plans work and delegates to specialists.', tools: ['plan', 'memory', 'notify'], enabled: true },
  { id: 'coding', name: 'Code', role: 'coding', description: 'Reads and edits project files, runs builds and tests.', tools: ['files', 'terminal', 'editor'], enabled: true },
  { id: 'research', name: 'Research', role: 'research', description: 'Searches and reads the web, summarises findings with sources.', tools: ['web.fetch', 'browser', 'memory'], enabled: true },
  { id: 'browser', name: 'Browser', role: 'general', description: 'Opens pages and works inside the default browser.', tools: ['browser', 'computer'], enabled: true },
  { id: 'files', name: 'Files', role: 'general', description: 'Organises, moves and summarises files in authorised folders.', tools: ['files'], enabled: true },
  { id: 'computer', name: 'Computer', role: 'computer', description: 'Observes the screen and uses mouse and keyboard with approval.', tools: ['screen', 'mouse', 'keyboard', 'apps'], enabled: true }
]

function pickAgent(text: string): string {
  const t = text.toLowerCase()
  if (/\b(code|bug|build|test|refactor|function|repo|compile)\b/.test(t)) return 'coding'
  if (/\b(research|find out|compare|summari[sz]e|look up|search)\b/.test(t)) return 'research'
  if (/\b(open|website|browser|url|tab)\b/.test(t)) return 'browser'
  if (/\b(file|folder|organi[sz]e|rename|move)\b/.test(t)) return 'files'
  if (/\b(click|type|screen|window|mouse|keyboard)\b/.test(t)) return 'computer'
  return 'general'
}

function riskyCategory(text: string): PermissionCategory | null {
  const t = text.toLowerCase()
  if (/\b(delete|remove|erase)\b/.test(t)) return 'delete_files'
  if (/\b(send|email|post|message|reply)\b/.test(t)) return 'external_communication'
  if (/\b(run|install|command|terminal|npm|build)\b/.test(t)) return 'run_commands'
  if (/\b(click|type|press)\b/.test(t)) return 'computer_input'
  if (/\b(write|edit|save|create|update)\b/.test(t)) return 'write_files'
  return null
}

interface SimRun {
  step: number
  timer: Timer | null
  paused: boolean
  permissionId?: string
  allowTask?: boolean
}

export class IosBackend implements ZvyraBackend {
  private listeners = new Set<(e: ZvyraEvent) => void>()
  private settings: AppSettings = deepMerge(DEFAULT_SETTINGS, { voice: { wakeEngine: 'preview', sttProvider: 'preview', ttsProvider: 'preview' } })
  private voice: VoiceStatus = {
    state: 'off',
    wakeWordEnabled: false,
    wakePhrase: 'Hey Zvyra',
    wake: { id: 'preview', name: 'Simulated detector (preview)', ready: false, processing: 'local', setupRequired: 'The real wake-word engine is provided by the backend.' },
    stt: { id: 'preview', name: 'Simulated transcription (preview)', ready: false, processing: 'local', setupRequired: 'Speech recognition is provided by the backend.' },
    tts: { id: 'preview', name: 'Simulated speech (preview)', ready: false, processing: 'local', setupRequired: 'Speech output is provided by the backend.' },
    micAvailable: false,
    micDeviceId: null
  }
  private interactions: Interaction[] = []
  private tasks = new Map<string, Task>()
  private events = new Map<string, TaskEvent[]>()
  private runs = new Map<string, SimRun>()
  private permissions = new Map<string, PermissionRequest>()
  private policies: PermissionPolicyEntry[] = (
    [
      ['read_files', 'allow'], ['write_files', 'ask'], ['delete_files', 'ask'], ['run_commands', 'ask'], ['open_apps', 'allow'],
      ['browser', 'allow'], ['network', 'allow'], ['computer_input', 'ask'], ['screen_capture', 'ask'], ['memory_write', 'ask'],
      ['external_communication', 'ask'], ['system_settings', 'ask']
    ] as [PermissionCategory, PermissionPolicyEntry['policy']][]
  ).map(([category, policy]) => ({
    category,
    policy,
    allowedPolicies: category === 'delete_files' || category === 'external_communication' ? ['ask', 'deny'] : ['allow', 'ask', 'deny']
  }))
  private conversations = new Map<string, Conversation>()
  private messages = new Map<string, ChatMessage[]>()
  private streams = new Map<string, Timer>()
  private swarm: SwarmConnection = { status: 'disconnected', baseUrl: '', hasApiKey: false }
  private routing: RoutingConfig = DEFAULT_ROUTING
  private agentEnabled = new Map(AGENTS.map((a) => [a.id, true]))
  private agentModel = new Map<string, string | undefined>()
  private projects = new Map<string, Project>()
  private activeProject: string | null = null
  private activity: ActivityEntry[] = []
  private memory = new Map<string, MemoryItem>()
  private memorySettings: MemorySettings = { enabled: true, agentMaySave: 'ask', includeInContext: true, retentionDays: null }
  private automations = new Map<string, Automation>()
  private notifications: AppNotification[] = []
  private policy: NotificationPolicy = DEFAULT_NOTIFICATION_POLICY
  private levelTimer: Timer | null = null
  private captureTimer: Timer | null = null

  constructor() {
    this.log('system.started', 'ZVYRA started with the preview backend', 'warning', 'No real services are connected. Actions are simulated.')
  }

  subscribe(listener: (e: ZvyraEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async dispose() {
    for (const r of this.runs.values()) if (r.timer) clearTimeout(r.timer)
    for (const t of this.streams.values()) clearInterval(t)
    if (this.levelTimer) clearInterval(this.levelTimer)
  }

  invoke<K extends MethodName>(method: K, args: MethodArgs<K>): Promise<MethodResult<K>> {
    const fn = this.handlers[method] as (a: MethodArgs<K>) => Promise<MethodResult<K>> | MethodResult<K>
    return Promise.resolve().then(() => fn(args))
  }

  private emit<K extends keyof ZvyraEventMap>(type: K, payload: ZvyraEventMap[K]) {
    const event = { type, payload } as ZvyraEvent
    for (const l of this.listeners) l(event)
  }

  private log(type: string, title: string, level: ActivityEntry['level'] = 'info', detail?: string, taskId?: string) {
    const entry: ActivityEntry = { id: id(), ts: now(), type, title, level, detail, taskId }
    this.activity.unshift(entry)
    this.activity = this.activity.slice(0, 2000)
    this.emit('activity.new', entry)
  }

  private notify(title: string, body: string, priority: AppNotification['priority'], category: AppNotification['category'], taskId?: string) {
    const n: AppNotification = { id: id(), ts: now(), title, body, priority, category, read: false, taskId, delivered: { desktop: false, spoken: false } }
    this.notifications.unshift(n)
    this.emit('notification.new', n)
  }

  /* ---------------------------------------------------------------- voice */

  private setVoice(patch: Partial<VoiceStatus>) {
    this.voice = { ...this.voice, ...patch }
    this.emit('voice.status', this.voice)
  }

  private restingVoiceState(): VoiceStatus['state'] {
    return this.voice.wakeWordEnabled ? 'standby' : 'off'
  }

  private startLevels() {
    if (this.levelTimer) return
    let t = 0
    this.levelTimer = setInterval(() => {
      t += 1
      const speaking = this.voice.state === 'listening'
      const level = speaking ? Math.max(0, 0.35 + 0.3 * Math.sin(t / 2.3) + 0.25 * Math.sin(t / 0.9) * Math.random()) : 0.04 * Math.random()
      this.emit('voice.level', { level: Math.min(1, level) })
    }, 66)
  }

  private stopLevels() {
    if (this.levelTimer) clearInterval(this.levelTimer)
    this.levelTimer = null
    this.emit('voice.level', { level: 0 })
  }

  private finishCapture(submit: boolean, source: Interaction['source'] = 'voice') {
    if (this.captureTimer) clearTimeout(this.captureTimer)
    this.captureTimer = null
    this.stopLevels()
    if (!submit) {
      this.setVoice({ state: this.restingVoiceState(), partialTranscript: undefined })
      return
    }
    this.setVoice({ state: 'transcribing', partialTranscript: undefined })
    setTimeout(() => {
      const text = 'Preview voice command (no speech recognition connected)'
      this.emit('voice.transcript', { text, final: true })
      this.setVoice({ state: this.restingVoiceState(), lastTranscript: text })
      void this.submit(text, source)
    }, 900)
  }

  private speak(text: string) {
    if (!this.settings.voice.speakResponses) return
    this.setVoice({ state: 'speaking' })
    setTimeout(() => {
      if (this.voice.state === 'speaking') this.setVoice({ state: this.restingVoiceState() })
    }, Math.min(6000, 600 + text.length * 35))
  }

  /* ---------------------------------------------------------------- assistant */

  private upsertInteraction(i: Interaction) {
    const idx = this.interactions.findIndex((x) => x.id === i.id)
    if (idx >= 0) this.interactions[idx] = i
    else this.interactions.unshift(i)
    this.interactions = this.interactions.slice(0, 50)
    this.emit('assistant.interaction', i)
  }

  private submit(text: string, source: Interaction['source'], projectId?: string): Interaction {
    const created = now()
    let interaction: Interaction = { id: id(), source, input: text, status: 'pending', createdAt: created, updatedAt: created }
    this.upsertInteraction(interaction)
    const task = this.createTask({ instruction: text, source, projectId })
    const reply = `I'm running in preview mode, so nothing on your PC will change. I created a simulated task for “${text.slice(0, 80)}” so you can see how ZVYRA tracks the work.`
    const words = reply.split(' ')
    let n = 0
    setTimeout(() => {
      const timer = setInterval(() => {
        n += 1
        interaction = { ...interaction, status: n >= words.length ? 'done' : 'streaming', response: words.slice(0, n).join(' '), taskId: task.id, updatedAt: now() }
        this.upsertInteraction(interaction)
        if (n >= words.length) {
          clearInterval(timer)
          this.speak(reply)
        }
      }, 45)
    }, 700)
    return interaction
  }

  /* ---------------------------------------------------------------- tasks */

  private upsertTask(task: Task) {
    task.updatedAt = now()
    this.tasks.set(task.id, task)
    this.emit('task.upsert', { ...task, plan: task.plan.map((s) => ({ ...s })) })
    this.emitAgents()
  }

  private taskEvent(taskId: string, kind: TaskEvent['kind'], message: string, data?: Record<string, unknown>) {
    const ev: TaskEvent = { id: id(), taskId, ts: now(), kind, message, data }
    const list = this.events.get(taskId) ?? []
    list.push(ev)
    this.events.set(taskId, list)
    this.emit('task.event', ev)
  }

  private createTask(input: MethodArgs<'tasks.create'>): Task {
    const t = now()
    const agentId = input.agentId ?? pickAgent(input.instruction)
    const task: Task = {
      id: id(),
      title: input.instruction.length > 64 ? input.instruction.slice(0, 61) + '…' : input.instruction,
      instruction: input.instruction,
      status: 'queued',
      source: input.source,
      agentId,
      projectId: input.projectId ?? this.activeProject ?? undefined,
      model: input.model,
      createdAt: t,
      updatedAt: t,
      plan: [],
      canPause: true,
      canResume: false,
      canRetry: false
    }
    this.upsertTask(task)
    this.taskEvent(task.id, 'status', 'Queued (preview simulation)')
    this.runs.set(task.id, { step: -1, timer: null, paused: false })
    this.schedule(task.id, 500)
    return task
  }

  private schedule(taskId: string, ms: number) {
    const run = this.runs.get(taskId)
    if (!run) return
    if (run.timer) clearTimeout(run.timer)
    run.timer = setTimeout(() => this.advance(taskId), ms)
  }

  private advance(taskId: string) {
    const task = this.tasks.get(taskId)
    const run = this.runs.get(taskId)
    if (!task || !run || run.paused) return
    run.timer = null
    if (run.step === -1) {
      task.status = 'planning'
      task.startedAt = now()
      task.currentAction = 'Drafting a plan'
      this.upsertTask(task)
      this.taskEvent(taskId, 'status', 'Planning')
      this.log('task.started', `Started: ${task.title}`, 'info', 'Preview simulation', taskId)
      run.step = 0
      this.schedule(taskId, 1200)
      return
    }
    if (task.plan.length === 0) {
      task.plan = ['Understand the request', 'Gather context', 'Carry out the work', 'Verify the result'].map((title) => ({ id: id(), title, status: 'pending' }))
      task.status = 'running'
      task.progress = { completed: 0, total: task.plan.length }
      this.taskEvent(taskId, 'plan', 'Plan ready', { steps: task.plan.map((s) => s.title) })
    }
    const step = task.plan[run.step]
    if (!step) return
    if (step.status === 'pending') {
      step.status = 'running'
      task.status = run.step === task.plan.length - 1 ? 'verifying' : 'running'
      task.currentAction = step.title
      this.upsertTask(task)
      this.taskEvent(taskId, 'tool_call', `${step.title} (simulated)`)
      const risky = riskyCategory(task.instruction)
      if (run.step === 2 && risky && !run.allowTask) {
        const policy = this.policies.find((p) => p.category === risky)?.policy
        if (policy === 'deny') return this.failTask(task, 'Blocked by your permission settings')
        if (policy === 'ask') return this.requestPermission(task, risky)
      }
      this.schedule(taskId, 1400)
      return
    }
    step.status = 'done'
    task.progress = { completed: run.step + 1, total: task.plan.length }
    this.taskEvent(taskId, 'tool_result', `${step.title}: done (simulated)`)
    run.step += 1
    if (run.step >= task.plan.length) {
      task.status = 'completed'
      task.finishedAt = now()
      task.currentAction = undefined
      task.canPause = false
      task.canResume = false
      task.canRetry = true
      task.summary = 'Preview simulation finished. No real work was performed — connect the backend to execute tasks.'
      this.upsertTask(task)
      this.taskEvent(taskId, 'status', 'Completed (simulated)')
      this.log('task.completed', `Completed: ${task.title}`, 'success', 'Preview simulation', taskId)
      this.notify('Task finished (preview)', task.title, 'normal', 'task_completed', taskId)
      this.runs.delete(taskId)
      return
    }
    this.upsertTask(task)
    this.schedule(taskId, 600)
  }

  private requestPermission(task: Task, category: PermissionCategory) {
    const req: PermissionRequest = {
      id: id(),
      taskId: task.id,
      agentId: task.agentId,
      category,
      title: `Allow ${category.replace(/_/g, ' ')}?`,
      description: `The task “${task.title}” wants to perform an action in the “${category.replace(/_/g, ' ')}” category. (Preview: nothing will actually run.)`,
      risk: category === 'delete_files' || category === 'external_communication' ? 'high' : 'medium',
      details: [
        { label: 'Task', value: task.title },
        { label: 'Agent', value: AGENTS.find((a) => a.id === task.agentId)?.name ?? 'Assistant' }
      ],
      createdAt: now(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
    }
    this.permissions.set(req.id, req)
    const run = this.runs.get(task.id)!
    run.permissionId = req.id
    task.status = 'waiting_permission'
    task.currentAction = 'Waiting for your approval'
    this.upsertTask(task)
    this.taskEvent(task.id, 'permission', req.title, { category })
    this.emit('permission.requested', req)
    this.log('permission.requested', req.title, 'warning', task.title, task.id)
    this.notify('Approval needed', task.title, 'high', 'task_blocked', task.id)
  }

  private failTask(task: Task, error: string) {
    task.status = 'failed'
    task.error = error
    task.finishedAt = now()
    task.canRetry = true
    task.canPause = false
    task.canResume = false
    task.currentAction = undefined
    const run = task.plan.find((s) => s.status === 'running')
    if (run) run.status = 'failed'
    this.upsertTask(task)
    this.taskEvent(task.id, 'error', error)
    this.log('task.failed', `Failed: ${task.title}`, 'error', error, task.id)
    this.runs.delete(task.id)
  }

  private cancelTask(taskId: string) {
    const task = this.getTask(taskId)
    const run = this.runs.get(taskId)
    if (run?.timer) clearTimeout(run.timer)
    if (run?.permissionId) this.resolvePermission(run.permissionId, 'deny', false)
    this.runs.delete(taskId)
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task
    task.status = 'cancelled'
    task.finishedAt = now()
    task.canPause = false
    task.canResume = false
    task.canRetry = true
    task.currentAction = undefined
    this.upsertTask(task)
    this.taskEvent(taskId, 'status', 'Cancelled by you')
    this.log('task.cancelled', `Cancelled: ${task.title}`, 'warning', undefined, taskId)
    return task
  }

  private resolvePermission(pid: string, decision: 'allow_once' | 'allow_task' | 'allow_always' | 'deny', continueTask = true) {
    const req = this.permissions.get(pid)
    if (!req) throw new ZvyraError('NOT_FOUND', 'Permission request not found or already answered')
    this.permissions.delete(pid)
    this.emit('permission.resolved', { id: pid, decision })
    if (!continueTask || !req.taskId) return
    const task = this.tasks.get(req.taskId)
    const run = this.runs.get(req.taskId)
    if (!task || !run) return
    run.permissionId = undefined
    if (decision === 'deny') return this.failTask(task, 'You denied the requested permission')
    if (decision === 'allow_task') run.allowTask = true
    task.status = 'running'
    this.upsertTask(task)
    this.taskEvent(task.id, 'permission', decision === 'allow_task' ? 'Approved for this task' : 'Approved once')
    this.schedule(task.id, 900)
  }

  private getTask(taskId: string): Task {
    const t = this.tasks.get(taskId)
    if (!t) throw new ZvyraError('NOT_FOUND', 'Task not found')
    return t
  }

  private agentsList(): AgentInfo[] {
    const active = [...this.tasks.values()].filter((t) => ['planning', 'running', 'verifying', 'waiting_permission', 'paused'].includes(t.status))
    return AGENTS.map((a) => {
      const mine = active.filter((t) => t.agentId === a.id)
      const enabled = this.agentEnabled.get(a.id) ?? true
      return {
        ...a,
        enabled,
        model: this.agentModel.get(a.id),
        activeTaskIds: mine.map((t) => t.id),
        state: !enabled ? 'disabled' : mine.some((t) => t.status === 'waiting_permission') ? 'waiting' : mine.length ? 'running' : 'idle'
      }
    })
  }

  private emitAgents() {
    const tasks = [...this.tasks.values()]
    this.emit('agents.runtime', {
      mode: 'parallel',
      maxConcurrentTasks: this.settings.background.maxConcurrentTasks,
      runningTasks: tasks.filter((t) => ['planning', 'running', 'verifying', 'waiting_permission'].includes(t.status)).length,
      queuedTasks: tasks.filter((t) => t.status === 'queued').length
    })
    for (const a of this.agentsList()) this.emit('agents.update', a)
  }

  /* ---------------------------------------------------------------- chat */

  private conv(cid: string) {
    const c = this.conversations.get(cid)
    if (!c) throw new ZvyraError('NOT_FOUND', 'Conversation not found')
    return c
  }

  private streamReply(cid: string, model?: string): ChatMessage {
    const conv = this.conv(cid)
    const list = this.messages.get(cid) ?? []
    const lastUser = [...list].reverse().find((m) => m.role === 'user')
    const msg: ChatMessage = { id: id(), conversationId: cid, role: 'assistant', content: '', createdAt: now(), status: 'streaming', model: model ?? conv.model }
    list.push(msg)
    this.messages.set(cid, list)
    this.emit('chat.message', msg)
    const text =
      `This is a simulated reply from the preview backend — no model is connected, so I can't actually answer “${(lastUser?.content ?? '').slice(0, 80)}”.\n\n` +
      'Once the real backend and an AI provider are configured in **Settings → AI & models**, responses will stream from the model you choose here.'
    const tokens = text.split(/(\s+)/)
    let i = 0
    const timer = setInterval(() => {
      const delta = tokens.slice(i, i + 2).join('')
      i += 2
      msg.content += delta
      this.emit('chat.delta', { conversationId: cid, messageId: msg.id, delta })
      if (i >= tokens.length) {
        clearInterval(timer)
        this.streams.delete(cid)
        msg.status = 'complete'
        this.emit('chat.message', { ...msg })
        conv.preview = msg.content.slice(0, 90)
        conv.updatedAt = now()
        conv.messageCount = list.length
        this.emit('chat.conversation', { ...conv })
      }
    }, 35)
    this.streams.set(cid, timer)
    return { ...msg }
  }

  /* ---------------------------------------------------------------- handlers */

  private handlers: Handlers = {
    'system.info': () => ({
      contractVersion: CONTRACT_VERSION,
      backend: 'mock',
      backendVersion: 'preview',
      appVersion: '0.1.0',
      platform: 'ios',
      capabilities: {
        voice: true, wakeWord: true, chat: true, chatStreaming: true, chatAttachments: false, tasks: true, taskPause: true,
        agents: true, computerControl: false, terminal: false, files: false, browser: false, codeEditor: false, projects: true,
        memory: true, automations: true, notifications: true, apps: false, diagnostics: true
      }
    }),
    'system.diagnostics': () => [
      { id: 'backend', label: 'Backend', status: 'warning', detail: 'Preview adapter active. Real services are not connected.' },
      { id: 'ai', label: 'AI provider', status: 'error', detail: 'Not connected', fixRoute: 'settings/ai' },
      { id: 'wake', label: 'Wake-word engine', status: 'warning', detail: this.voice.wake.setupRequired, fixRoute: 'settings/voice' },
      { id: 'mic', label: 'Microphone', status: 'unknown', detail: 'Detected by the real backend' },
      { id: 'computer', label: 'Computer control adapter', status: 'warning', detail: 'Not available in preview' }
    ],
    'system.logs': () => [],
    'system.openLogsFolder': () => unavailable('Log files'),
    'system.openDataFolder': () => unavailable('Data storage'),
    'system.stopAll': () => {
      let cancelled = 0
      for (const t of this.tasks.values()) {
        if (['queued', 'planning', 'running', 'paused', 'waiting_permission', 'verifying'].includes(t.status)) {
          this.cancelTask(t.id)
          cancelled++
        }
      }
      this.finishCapture(false)
      this.setVoice({ state: this.restingVoiceState() })
      this.log('system.stopAll', 'Emergency stop', 'warning', `${cancelled} task(s) cancelled`)
      return { cancelledTasks: cancelled }
    },

    'settings.get': () => this.settings,
    'settings.update': (patch) => {
      this.settings = deepMerge(this.settings, patch)
      this.emit('settings.changed', this.settings)
      if (patch.voice?.wakeWordEnabled !== undefined) this.handlers['voice.setWakeWord']({ enabled: patch.voice.wakeWordEnabled })
      return this.settings
    },

    'voice.status': () => this.voice,
    'voice.setWakeWord': ({ enabled }) => {
      this.settings = deepMerge(this.settings, { voice: { wakeWordEnabled: enabled } })
      this.emit('settings.changed', this.settings)
      this.setVoice({ wakeWordEnabled: enabled, state: enabled ? 'standby' : this.voice.state === 'standby' ? 'off' : this.voice.state })
      this.log('voice.wake', enabled ? 'Wake word listening enabled (simulated)' : 'Wake word listening disabled')
      return this.voice
    },
    'voice.startListening': ({ source }) => {
      if (this.voice.state === 'listening') return this.voice
      this.setVoice({ state: 'listening', partialTranscript: undefined, error: undefined })
      this.startLevels()
      this.captureTimer = setTimeout(() => this.finishCapture(true, source === 'island' ? 'voice' : source), 4000)
      return this.voice
    },
    'voice.stopListening': () => {
      if (this.voice.state === 'listening') this.finishCapture(true)
      return this.voice
    },
    'voice.cancel': () => {
      this.finishCapture(false)
      return this.voice
    },
    'voice.speak': ({ text }) => this.speak(text),
    'voice.stopSpeaking': () => {
      if (this.voice.state === 'speaking') this.setVoice({ state: this.restingVoiceState() })
    },
    'voice.devices': () => [],
    'voice.selectDevice': ({ deviceId }) => {
      this.setVoice({ micDeviceId: deviceId })
      return this.voice
    },
    'voice.engines': () => [
      { id: 'preview', kind: 'wake', name: 'Simulated detector (preview)', processing: 'local', description: 'Stands in for the real wake-word engine while the backend is not connected.', installed: true, fields: [] }
    ],
    'voice.configureEngine': () => unavailable('Voice engine configuration'),
    'voice.testEngine': () => ({ ok: false, message: `${PREVIEW}engines cannot be tested in preview.` }),

    'assistant.submit': ({ text, source, projectId }) => this.submit(text, source, projectId),
    'assistant.cancel': ({ id: iid }) => {
      const i = this.interactions.find((x) => x.id === iid)
      if (i?.taskId) this.cancelTask(i.taskId)
      if (i) this.upsertInteraction({ ...i, status: 'cancelled', updatedAt: now() })
    },
    'assistant.recent': ({ limit = 20 }) => this.interactions.slice(0, limit),

    'tasks.list': ({ status, projectId, limit = 200 }) =>
      [...this.tasks.values()]
        .filter((t) => (!status || status.includes(t.status)) && (!projectId || t.projectId === projectId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit),
    'tasks.get': ({ id: tid }) => this.getTask(tid),
    'tasks.events': ({ id: tid, limit = 500 }) => (this.events.get(tid) ?? []).slice(-limit),
    'tasks.create': (input) => this.createTask(input),
    'tasks.cancel': ({ id: tid }) => this.cancelTask(tid),
    'tasks.pause': ({ id: tid }) => {
      const task = this.getTask(tid)
      const run = this.runs.get(tid)
      if (!run || !task.canPause) throw new ZvyraError('INVALID_ARGS', 'This task cannot be paused right now')
      if (run.timer) clearTimeout(run.timer)
      run.paused = true
      task.status = 'paused'
      task.canPause = false
      task.canResume = true
      this.upsertTask(task)
      this.taskEvent(tid, 'status', 'Paused')
      return task
    },
    'tasks.resume': ({ id: tid }) => {
      const task = this.getTask(tid)
      const run = this.runs.get(tid)
      if (!run || task.status !== 'paused') throw new ZvyraError('INVALID_ARGS', 'Task is not paused')
      run.paused = false
      task.status = 'running'
      task.canPause = true
      task.canResume = false
      this.upsertTask(task)
      this.taskEvent(tid, 'status', 'Resumed')
      this.schedule(tid, 400)
      return task
    },
    'tasks.retry': ({ id: tid }) => {
      const old = this.getTask(tid)
      return this.createTask({ instruction: old.instruction, source: old.source, agentId: old.agentId, projectId: old.projectId })
    },
    'tasks.message': ({ id: tid, text }) => {
      const task = this.getTask(tid)
      this.taskEvent(tid, 'message', text, { from: 'user' })
      return task
    },
    'tasks.delete': ({ id: tid }) => {
      this.cancelTask(tid)
      this.tasks.delete(tid)
      this.events.delete(tid)
      this.emit('task.removed', { id: tid })
    },
    'tasks.clearHistory': () => {
      let removed = 0
      for (const t of [...this.tasks.values()]) {
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(t.status)) {
          this.tasks.delete(t.id)
          this.emit('task.removed', { id: t.id })
          removed++
        }
      }
      return { removed }
    },

    'permissions.pending': () => [...this.permissions.values()],
    'permissions.respond': ({ id: pid, decision }) => this.resolvePermission(pid, decision),
    'permissions.policies': () => this.policies,
    'permissions.rules': () => [],
    'permissions.revokeRule': () => [],
    'permissions.setPolicy': ({ category, policy }) => {
      this.policies = this.policies.map((p) => {
        if (p.category !== category) return p
        if (!p.allowedPolicies.includes(policy)) throw new ZvyraError('INVALID_ARGS', `“${policy}” is not allowed for ${category}`)
        return { ...p, policy }
      })
      return this.policies
    },

    'chat.list': ({ projectId }) =>
      [...this.conversations.values()].filter((c) => !projectId || c.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    'chat.create': ({ title, projectId, model }) => {
      const c: Conversation = { id: id(), title: title || 'New conversation', createdAt: now(), updatedAt: now(), projectId, model, messageCount: 0 }
      this.conversations.set(c.id, c)
      this.messages.set(c.id, [])
      this.emit('chat.conversation', c)
      return c
    },
    'chat.rename': ({ id: cid, title }) => {
      const c = { ...this.conv(cid), title, updatedAt: now() }
      this.conversations.set(cid, c)
      this.emit('chat.conversation', c)
      return c
    },
    'chat.delete': ({ id: cid }) => {
      this.conversations.delete(cid)
      this.messages.delete(cid)
      this.emit('chat.conversationRemoved', { id: cid })
    },
    'chat.setModel': ({ id: cid, model }) => {
      const c = { ...this.conv(cid), model: model ?? undefined }
      this.conversations.set(cid, c)
      this.emit('chat.conversation', c)
      return c
    },
    'chat.messages': ({ id: cid }) => (this.messages.get(cid) ?? []).map((m) => ({ ...m })),
    'chat.send': ({ conversationId, text, model }) => {
      const conv = this.conv(conversationId)
      const list = this.messages.get(conversationId) ?? []
      const user: ChatMessage = { id: id(), conversationId, role: 'user', content: text, createdAt: now(), status: 'complete' }
      list.push(user)
      this.messages.set(conversationId, list)
      this.emit('chat.message', user)
      if (conv.messageCount === 0 && conv.title === 'New conversation') conv.title = text.slice(0, 48)
      conv.messageCount = list.length
      conv.updatedAt = now()
      this.emit('chat.conversation', { ...conv })
      return this.streamReply(conversationId, model)
    },
    'chat.stop': ({ conversationId }) => {
      const t = this.streams.get(conversationId)
      if (!t) return
      clearInterval(t)
      this.streams.delete(conversationId)
      const msg = [...(this.messages.get(conversationId) ?? [])].reverse().find((m) => m.status === 'streaming')
      if (msg) {
        msg.status = 'stopped'
        this.emit('chat.message', { ...msg })
      }
    },
    'chat.retry': ({ conversationId }) => {
      const list = this.messages.get(conversationId) ?? []
      const last = list[list.length - 1]
      if (last?.role === 'assistant') list.pop()
      return this.streamReply(conversationId)
    },
    'chat.pickAttachments': () => unavailable('Attachments'),
    'chat.runAsTask': ({ conversationId, messageId }) => {
      const msg = (this.messages.get(conversationId) ?? []).find((m) => m.id === messageId)
      if (!msg) throw new ZvyraError('NOT_FOUND', 'Message not found')
      return this.createTask({ instruction: msg.content, source: 'chat' })
    },

    'swarm.connection': () => this.swarm,
    'swarm.configure': ({ baseUrl, apiKey }) => {
      this.swarm = { ...this.swarm, baseUrl, hasApiKey: apiKey === undefined ? this.swarm.hasApiKey : apiKey.length > 0, status: 'disconnected', error: undefined }
      this.emit('swarm.connection', this.swarm)
      return this.swarm
    },
    'swarm.test': () => {
      this.swarm = { ...this.swarm, status: 'error', lastCheckedAt: now(), error: `${PREVIEW}cannot reach an AI provider. Connection tests run in the real backend.` }
      this.emit('swarm.connection', this.swarm)
      this.log('model.connection', 'AI connection test not available', 'warning', 'Preview backend')
      return this.swarm
    },
    'models.list': () => [],
    'routing.get': () => this.routing,
    'routing.set': (patch) => {
      this.routing = { ...this.routing, ...patch, roles: { ...this.routing.roles, ...(patch.roles ?? {}) } }
      return this.routing
    },

    'agents.list': () => this.agentsList(),
    'agents.runtime': () => {
      const tasks = [...this.tasks.values()]
      return {
        mode: 'parallel',
        maxConcurrentTasks: this.settings.background.maxConcurrentTasks,
        runningTasks: tasks.filter((t) => ['planning', 'running', 'verifying', 'waiting_permission'].includes(t.status)).length,
        queuedTasks: tasks.filter((t) => t.status === 'queued').length
      }
    },
    'agents.setEnabled': ({ id: aid, enabled }) => {
      this.agentEnabled.set(aid, enabled)
      this.emitAgents()
      return this.agentsList().find((a) => a.id === aid)!
    },
    'agents.setModel': ({ id: aid, model }) => {
      this.agentModel.set(aid, model ?? undefined)
      this.emitAgents()
      return this.agentsList().find((a) => a.id === aid)!
    },
    'agents.stop': ({ id: aid }) => {
      for (const t of this.tasks.values()) if (t.agentId === aid) this.cancelTask(t.id)
      return this.agentsList().find((a) => a.id === aid)!
    },

    'computer.status': () => ({
      enabled: false,
      available: false,
      adapter: 'None (preview)',
      phase: 'idle',
      capabilities: { screenCapture: false, mouse: false, keyboard: false, windowInfo: false, appLaunch: false },
      stopShortcut: this.settings.shortcuts.stopAll,
      error: 'Computer control adapters are provided by the real backend.'
    }),
    'computer.setEnabled': () => unavailable('Computer control'),
    'computer.stop': () => this.handlers['computer.status'](undefined),
    'computer.capture': () => unavailable('Screen capture'),
    'computer.activeWindow': () => null,
    'computer.windows': () => [],
    'computer.history': () => [],

    'apps.integrations': () => [
      { id: 'vscode', name: 'Visual Studio Code', category: 'editor', status: 'needs_setup', detail: 'Detected by the real backend' },
      { id: 'browser', name: 'Default browser', category: 'browser', status: 'needs_setup', detail: 'Detected by the real backend' },
      { id: 'terminal', name: 'Windows Terminal / PowerShell', category: 'terminal', status: 'needs_setup', detail: 'Detected by the real backend' },
      { id: 'explorer', name: 'File Explorer', category: 'files', status: 'needs_setup', detail: 'Detected by the real backend' }
    ],
    'apps.launchable': () => [],
    'apps.launch': () => unavailable('App launching'),
    'apps.add': () => unavailable('App launching'),
    'apps.remove': () => unavailable('App launching'),
    'apps.setPinned': () => unavailable('App launching'),
    'browser.open': () => unavailable('Browser control'),
    'code.openInEditor': () => unavailable('Editor integration'),

    'terminal.run': () => unavailable('The terminal'),
    'terminal.kill': () => unavailable('The terminal'),
    'terminal.runs': () => [],
    'terminal.openExternal': () => unavailable('The terminal'),

    'files.roots': () =>
      [...this.projects.values()].map((p) => ({ path: p.path, label: p.name, source: 'project' as const, projectId: p.id })),
    'files.addRoot': () => unavailable('File access'),
    'files.removeRoot': () => unavailable('File access'),
    'files.list': () => unavailable('File browsing'),
    'files.read': () => unavailable('File reading'),
    'files.write': () => unavailable('File writing'),
    'files.reveal': () => unavailable('File Explorer integration'),
    'files.openExternal': () => unavailable('File Explorer integration'),

    'projects.list': () => [...this.projects.values()].sort((a, b) => (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt)),
    'projects.active': () => (this.activeProject ? this.projects.get(this.activeProject) ?? null : null),
    'projects.pickFolder': () => null,
    'projects.create': ({ name, path, createFolder }) => {
      if (createFolder) unavailable('Creating folders')
      const p: Project = { id: id(), name, path, favorite: false, status: 'open', createdAt: now(), lastOpenedAt: now(), taskCount: 0, conversationCount: 0 }
      this.projects.set(p.id, p)
      this.emit('project.upsert', p)
      this.log('project.created', `Project added: ${name}`, 'success', path)
      return p
    },
    'projects.open': ({ id: pid }) => this.patchProject(pid, { status: 'open', lastOpenedAt: now() }),
    'projects.close': ({ id: pid }) => {
      if (this.activeProject === pid) this.handlers['projects.setActive']({ id: null })
      return this.patchProject(pid, { status: 'closed' })
    },
    'projects.setActive': ({ id: pid }) => {
      this.activeProject = pid
      this.emit('project.active', { id: pid })
      return pid ? this.patchProject(pid, { status: 'open', lastOpenedAt: now() }) : null
    },
    'projects.rename': ({ id: pid, name }) => this.patchProject(pid, { name }),
    'projects.setFavorite': ({ id: pid, favorite }) => this.patchProject(pid, { favorite }),
    'projects.updateContext': ({ id: pid, context }) => this.patchProject(pid, { context }),
    'projects.delete': ({ id: pid, trashFolder }) => {
      if (trashFolder) unavailable('Moving folders to the Recycle Bin')
      this.projects.delete(pid)
      if (this.activeProject === pid) this.handlers['projects.setActive']({ id: null })
      this.emit('project.removed', { id: pid })
    },

    'activity.list': ({ query, types, limit = 200, before }) => {
      const q = query?.toLowerCase()
      return this.activity
        .filter((a) => (!q || `${a.title} ${a.detail ?? ''} ${a.type}`.toLowerCase().includes(q)) && (!types?.length || types.some((t) => a.type.startsWith(t))) && (!before || a.ts < before))
        .slice(0, limit)
    },
    'activity.clear': () => {
      this.activity = []
    },

    'memory.list': ({ query, kind, projectId }) => {
      const q = query?.toLowerCase()
      return [...this.memory.values()]
        .filter((m) => (!kind || m.kind === kind) && (!projectId || m.projectId === projectId) && (!q || `${m.title} ${m.content} ${m.tags.join(' ')}`.toLowerCase().includes(q)))
        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
    },
    'memory.create': (input) => {
      const m: MemoryItem = { ...input, id: id(), source: 'user', createdAt: now(), updatedAt: now() }
      this.memory.set(m.id, m)
      this.log('memory.saved', `Memory saved: ${m.title}`, 'info')
      return m
    },
    'memory.update': ({ id: mid, ...patch }) => {
      const m = this.memory.get(mid)
      if (!m) throw new ZvyraError('NOT_FOUND', 'Memory not found')
      const next = { ...m, ...patch, updatedAt: now() }
      this.memory.set(mid, next)
      return next
    },
    'memory.delete': ({ id: mid }) => {
      this.memory.delete(mid)
    },
    'memory.clear': ({ kind }) => {
      let removed = 0
      for (const m of [...this.memory.values()]) if (!kind || m.kind === kind) {
        this.memory.delete(m.id)
        removed++
      }
      return { removed }
    },
    'memory.settings': () => this.memorySettings,
    'memory.setSettings': (patch) => (this.memorySettings = { ...this.memorySettings, ...patch }),

    'automations.list': () => [...this.automations.values()],
    'automations.scheduler': () => ({ running: false, note: 'Preview backend has no scheduler — automations are saved but will not run on schedule.' }),
    'automations.create': (input) => {
      const a: Automation = { ...input, id: id(), createdAt: now() }
      this.automations.set(a.id, a)
      this.emit('automation.upsert', a)
      return a
    },
    'automations.update': ({ id: aid, ...patch }) => {
      const a = this.automations.get(aid)
      if (!a) throw new ZvyraError('NOT_FOUND', 'Automation not found')
      const next = { ...a, ...patch }
      this.automations.set(aid, next)
      this.emit('automation.upsert', next)
      return next
    },
    'automations.delete': ({ id: aid }) => {
      this.automations.delete(aid)
      this.emit('automation.removed', { id: aid })
    },
    'automations.runNow': ({ id: aid }) => {
      const a = this.automations.get(aid)
      if (!a) throw new ZvyraError('NOT_FOUND', 'Automation not found')
      const task = this.createTask({ instruction: a.instruction, source: 'automation', agentId: a.agentId, projectId: a.projectId })
      const next: Automation = { ...a, lastRunAt: now(), lastTaskId: task.id, lastStatus: 'queued' }
      this.automations.set(aid, next)
      this.emit('automation.upsert', next)
      return task
    },
    'automations.runs': () => [],

    'notifications.list': ({ limit = 50, unreadOnly }) => this.notifications.filter((n) => !unreadOnly || !n.read).slice(0, limit),
    'notifications.markRead': ({ id: nid }) => {
      this.notifications = this.notifications.map((n) => (!nid || n.id === nid ? { ...n, read: true } : n))
    },
    'notifications.clear': () => {
      this.notifications = []
    },
    'notifications.policy': () => this.policy,
    'notifications.setPolicy': (patch) => (this.policy = deepMerge(this.policy, patch)),
    'notifications.snooze': ({ minutes }) =>
      (this.policy = { ...this.policy, snoozedUntil: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null }),
    'notifications.test': () => {
      this.notify('Test notification (preview)', 'Desktop delivery is handled by the real backend.', 'normal', 'custom')
      return this.notifications[0]
    },
    'whatsappCalls.state': () => ({ defaultContact: 'Rachna', autoCallEnabled: false, minPriority: 'high' }),
    'whatsappCalls.update': (a) => {
      const cur = { defaultContact: '+91 9999653622', autoCallEnabled: false, minPriority: 'high' }
      return { ...cur, ...a }
    },
    'whatsappCalls.checkReadiness': () => ({ ok: false, outputs: [], error: 'WhatsApp calls require the desktop backend.' }),
    'whatsappCalls.resolveContact': () => ({ found: false, error: 'Contact search requires the desktop backend.' }),
    'whatsappCalls.startCall': () => ({ called: false, error: 'WhatsApp calls require the desktop backend.' }),
    'whatsappCalls.endCall': () => undefined,
    'whatsappCalls.getStatus': () => ({ state: 'idle', contact: null, lines: [], note: '' }),
    'whatsappCalls.handBack': () => false,
    'whatsappCalls.takeOver': () => false,
    'whatsappCalls.isActive': () => false,
    'voice.trainWake': ({ action }) => {
      if (action === 'clear') return { templates: 0, recording: 0 }
      for (let i = 1; i <= 5; i++) setTimeout(() => this.emit('voice.wakeTraining', { recording: 5 - i, templates: i }), i * 900)
      this.emit('voice.wakeTraining', { recording: 5, templates: 0 })
      return { templates: 0, recording: 5 }
    },
    'setup.state': () => ({
      onboarded: true,
      providers: [
        { id: 'gemini', name: 'Google Gemini', purpose: 'Voice conversations, research, camera vision and the builder agent', required: true, configured: false, keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…' },
        { id: 'groq', name: 'Groq', purpose: 'Very fast replies for chat and agents', required: false, configured: false, keyUrl: 'https://console.groq.com/keys', keyHint: 'gsk_…' }
      ],
      wakeSamples: 0
    }),
    'setup.testKey': async ({ key }) => {
      await new Promise((r) => setTimeout(r, 700))
      return key.trim().length > 12 ? { ok: true, message: 'Connected · 312 ms (preview)', latencyMs: 312 } : { ok: false, message: 'That doesn’t look like an API key.' }
    },
    'setup.demo': () => undefined,
    'setup.complete': () => ({ onboarded: true, providers: [], wakeSamples: 0 }),
    'camera.state': () => ({ open: false }),
    'camera.frame': () => undefined,
    'camera.close': () => ({ open: false })
  }

  private patchProject(pid: string, patch: Partial<Project>): Project {
    const p = this.projects.get(pid)
    if (!p) throw new ZvyraError('NOT_FOUND', 'Project not found')
    const next = { ...p, ...patch }
    this.projects.set(pid, next)
    this.emit('project.upsert', next)
    return next
  }
}
