/**
 * OWNER: Kiro. Desktop-services layer.
 *
 * Wraps the real engine backend (Astra) and fills in contract methods the
 * engine does not implement yet with real Windows/Electron integrations:
 * files, terminal, apps, editor, browser, window info, calls, recurring
 * automations, notification policy, memory context and task follow-ups.
 *
 * Rules:
 *  - The engine stays the source of truth for AI, tasks, chat, voice, memory.
 *  - Where the engine implements a method we delegate (`prefer`) and only fall
 *    back when it reports NOT_IMPLEMENTED, so engine upgrades win automatically.
 *  - Internal engine branding is removed from user-visible strings.
 */
import { Notification, safeStorage, shell, BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import {
  ZvyraError,
  type ActivityEntry,
  type AgentInfo,
  type AppNotification,
  type AppSettings,
  type Attachment,
  type Automation,
  type CameraState,
  type ChatMessage,
  type Conversation,
  type Interaction,
  type DiagnosticCheck,
  type Integration,
  type MemoryItem,
  type MemorySettings,
  type MethodArgs,
  type MethodName,
  type MethodResult,
  type NotificationPolicy,
  type SwarmConnection,
  type SetupState,
  type Task,
  type TaskEvent,
  type ToolActivity,
  type ZvyraBackend,
  type ZvyraEvent,
  type ZvyraEventMap
} from '../../shared/contract'
import { DEFAULT_NOTIFICATION_POLICY, deepMerge } from '../../shared/defaults'
import type { BackendContext } from '../backendContext'
import { AppsService, findVSCode, type AppsState } from './apps'
import { CALLS_DEFAULT, CallService, type CallsState } from './calls'
import { FileService, type FilesState } from './files'
import { JsonDoc } from './jsonDoc'
import { atLeast, debrand, inQuietHours, isInside, relevance, stripToolMarkup, toWholeHour } from './pure'
import { Scheduler, type SchedulerState } from './scheduler'
import { SecretStore } from './secrets'
import { TerminalService, type Notify, type TerminalState } from './terminal'
import { ApprovalService, type RulesState } from './approvals'
import type { CommandContext } from './commandRisk'
import { PROJECTS_DIR, resolveUserPath } from '../voice/desktopTools'
import { WindowsInfo } from './windowsInfo'
import { friendlyError, VoiceEngine, type VoiceConfig } from '../voice/engine'
import { TextAgent } from '../voice/textAgent'
import type { ToolHost } from '../voice/extraTools'
import { SETUP_PROVIDERS, SWARM_ID, testProviderKey } from './setup'
import { DEFAULT_LIVE_MODEL, DEFAULT_VOICE, GEMINI_VOICES } from '../voice/catalog'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

interface Prefs {
  voice: Partial<AppSettings['voice']>
  notify: NotificationPolicy
  notifyImported: boolean
  memory: { includeInContext: boolean; retentionDays: number | null }
  hiddenTasks: string[]
  hiddenProjects: string[]
  activity: ActivityEntry[]
  /** First-run setup finished. */
  onboarded: boolean
}

const PREFS_DEFAULT: Prefs = {
  voice: {},
  notify: DEFAULT_NOTIFICATION_POLICY,
  notifyImported: false,
  memory: { includeInContext: true, retentionDays: null },
  hiddenTasks: [],
  hiddenProjects: [],
  activity: [],
  onboarded: false
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|toml|ini|cfg|conf|log|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|cs|c|h|cpp|hpp|swift|php|sh|ps1|bat|sql|env\.example|gitignore)$/i
const MAX_ATTACHMENT = 200 * 1024
const ACTIVE = ['queued', 'planning', 'running', 'paused', 'waiting_permission', 'verifying']

const isNotImplemented = (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'NOT_IMPLEMENTED'

let notificationPatched = false

export function withDesktopServices(inner: ZvyraBackend, ctx: BackendContext): ZvyraBackend {
  const dir = join(ctx.userDataPath, 'desktop')
  const listeners = new Set<(e: ZvyraEvent) => void>()
  const emitRaw = (e: ZvyraEvent) => {
    for (const l of listeners) {
      try {
        l(e)
      } catch {
        /* a bad subscriber must not break others */
      }
    }
  }
  const emit = <K extends keyof ZvyraEventMap>(type: K, payload: ZvyraEventMap[K]) => emitRaw({ type, payload } as ZvyraEvent)
  const call = <K extends MethodName>(m: K, a: MethodArgs<K>) => inner.invoke(m, a)

  async function prefer<T>(m: MethodName, a: unknown, local: () => Promise<T> | T): Promise<T> {
    try {
      return (await inner.invoke(m, a as never)) as T
    } catch (e) {
      if (isNotImplemented(e)) return local()
      throw e
    }
  }

  /* --------------------------------------------------------------- state */

  const prefs = new JsonDoc<Prefs>(join(dir, 'prefs.json'), PREFS_DEFAULT)
  const filesDoc = new JsonDoc<FilesState>(join(dir, 'files.json'), { roots: [] })
  const terminalDoc = new JsonDoc<TerminalState>(join(dir, 'terminal.json'), { runs: [] })
  const appsDoc = new JsonDoc<AppsState>(join(dir, 'apps.json'), { apps: [] })
  const callsDoc = new JsonDoc<CallsState>(join(dir, 'calls.json'), CALLS_DEFAULT)
  const schedDoc = new JsonDoc<SchedulerState>(join(dir, 'automations.json'), { automations: [], runs: [] })
  const docs = [prefs, filesDoc, terminalDoc, appsDoc, callsDoc, schedDoc]
  const secrets = new SecretStore(ctx.userDataPath)
  const allowTask = new Set<string>()
  const attachments = new Map<string, { name: string; content: string; size: number }>()
  const windows = new WindowsInfo()

  const activity = (type: string, title: string, detail?: string, level: ActivityEntry['level'] = 'info') => {
    const e: ActivityEntry = { id: randomUUID(), ts: new Date().toISOString(), type, title, detail, level }
    prefs.set((s) => ({ activity: [e, ...s.activity].slice(0, 1000) }))
    emit('activity.new', e)
  }

  const visibleProjects = async () => {
    const hidden = new Set(prefs.get().hiddenProjects)
    return (await call('projects.list', undefined)).filter((p) => !hidden.has(p.id))
  }

  /* --------------------------------------------------------------- voice (Gemini Live + local wake word) */

  const GEMINI_KEY = 'gemini.apiKey'
  const voiceConfig = (): VoiceConfig => {
    const v = prefs.get().voice
    return {
      // On by default (on-device spotting only); the user can switch it off any time.
      wakeEnabled: v.wakeWordEnabled ?? true,
      sensitivity: v.sensitivity ?? 0.8,
      micDeviceId: v.micDeviceId ?? null,
      model: v.sttProvider && /live|native-audio/i.test(v.sttProvider) ? v.sttProvider : DEFAULT_LIVE_MODEL,
      voice: v.ttsVoice && GEMINI_VOICES.some((x) => x.name === v.ttsVoice) ? v.ttsVoice : DEFAULT_VOICE,
      idleTimeoutSec: v.listenTimeoutSec ?? 15,
      silenceMs: v.silenceTimeoutMs ?? 800,
      speakingRate: v.ttsRate ?? 1
    }
  }
  const voiceInteractions: Interaction[] = []
  const emitSettings = () =>
    void call('settings.get', undefined)
      .then((s) => emit('settings.changed', mergeSettings(s)))
      .catch(() => undefined)
  /** One-time key discovery: env vars, then the E.D.I.T.H config the user pointed ZVYRA at. */
  const importGeminiKey = () => {
    if (secrets.has(GEMINI_KEY)) return
    const env = process.env['GEMINI_API_KEY'] || process.env['GOOGLE_API_KEY']
    if (env) {
      secrets.set(GEMINI_KEY, env.trim())
      activity('voice.setup', 'Gemini API key imported from environment', 'Stored encrypted on this PC')
      return
    }
    const edith = join(homedir(), 'Documents', 'E.D.I.T.H', 'Mark-LIV-main', 'config', 'api_keys.json')
    if (!existsSync(edith)) return
    try {
      const cfg = JSON.parse(readFileSync(edith, 'utf8')) as { gemini_api_key?: string; voice_name?: string }
      if (cfg.gemini_api_key && /^[A-Za-z0-9_-]{20,}$/.test(cfg.gemini_api_key)) {
        secrets.set(GEMINI_KEY, cfg.gemini_api_key)
        if (cfg.voice_name && GEMINI_VOICES.some((x) => x.name === cfg.voice_name) && !prefs.get().voice.ttsVoice) prefs.set((s) => ({ voice: { ...s.voice, ttsVoice: cfg.voice_name } }))
        activity('voice.setup', 'Gemini API key imported from E.D.I.T.H', 'Stored encrypted on this PC', 'success')
      }
    } catch (err) {
      ctx.logger.warn('voice', 'Could not read E.D.I.T.H config', { message: String(err) })
    }
  }

  const files = new FileService(filesDoc, visibleProjects, activity)

  /* --------------------------------------------------------------- desktop notifications (right side) */

  // Same key inside the window → the existing toast is updated instead of a new one appearing.
  const toastKeys = new Map<string, { id: string; at: number }>()
  const notify: Notify = (t) => {
    // Approvals always show (the user has to act); everything else follows the notification policy.
    if (t.kind !== 'approval') {
      const p = prefs.get().notify
      const quiet = p.quietHours.enabled && inQuietHours(p.quietHours.start, p.quietHours.end, new Date())
      if (!p.enabled || !p.desktop || p.doNotDisturb || (!!p.snoozedUntil && Date.parse(p.snoozedUntil) > Date.now()) || (quiet && t.kind !== 'error')) return
    }
    const now = Date.now()
    for (const [k, v] of toastKeys) if (now - v.at > 15_000) toastKeys.delete(k)
    const prev = toastKeys.get(t.key)
    const id = t.id ?? (prev && now - prev.at < 10_000 ? prev.id : randomUUID())
    toastKeys.set(t.key, { id, at: now })
    emit('desktop.toast', { ...t, id, ts: new Date(now).toISOString() })
  }

  /* --------------------------------------------------------------- command approvals */

  const rulesDoc = new JsonDoc<RulesState>(join(dir, 'command-rules.json'), { rules: [] })
  docs.push(rulesDoc as never)
  const approvalToastId = (permissionId: string) => `approval-${permissionId}`
  const approvals = new ApprovalService(rulesDoc, {
    requested: (r) => {
      emit('permission.requested', r)
      notify({
        id: approvalToastId(r.id),
        key: `approval:${r.id}`,
        kind: 'approval',
        title: r.risk === 'high' ? 'High-risk command needs your OK' : 'Command awaiting approval',
        body: r.title,
        detail: r.command ? `${r.command.text.length > 140 ? `${r.command.text.slice(0, 138)}…` : r.command.text}` : undefined,
        timeoutMs: 0,
        permissionId: r.id
      })
    },
    resolved: (id, decision) => {
      emit('permission.resolved', { id, decision })
      emit('desktop.toastDismiss', { id: approvalToastId(id) })
    }
  })

  /** Working folders for commands: must exist and be inside the home folder or an authorised root. */
  const allowedRoots = async () => [PROJECTS_DIR, ...(await files.roots().catch(() => [])).map((r) => r.path)]
  const resolveCommandCwd = async (p: string) => {
    let real: string
    try {
      real = await realpath(resolveUserPath(p, homedir()))
    } catch {
      throw new ZvyraError('NOT_FOUND', `That folder doesn’t exist: ${p}`)
    }
    const st = await stat(real)
    if (!st.isDirectory()) throw new ZvyraError('INVALID_ARGS', `Not a folder: ${real}`)
    const roots = [homedir(), ...(await allowedRoots())]
    for (const r of roots) {
      const rr = await realpath(r).catch(() => r)
      if (isInside(rr, real)) return real
    }
    throw new ZvyraError('PERMISSION_DENIED', `Commands can only run in your user folders or folders you authorised in Files. “${real}” is outside them.`)
  }
  const classifyContext = async (cwd: string): Promise<CommandContext> => ({ cwd, home: homedir(), allowedRoots: await allowedRoots(), env: process.env })
  const terminal = new TerminalService(terminalDoc, resolveCommandCwd, emit, activity, approvals, classifyContext, notify)
  const apps = new AppsService(appsDoc, activity)
  const calls = new CallService(callsDoc, secrets, activity)

  /* --------------------------------------------------------------- debranding */

  const dbTask = (t: Task): Task => ({ ...t, summary: debrand(t.summary), error: debrand(t.error), currentAction: debrand(t.currentAction) })
  const dbEvent = (e: TaskEvent): TaskEvent => ({ ...e, message: debrand(e.message) })
  const dbActivity = (a: ActivityEntry): ActivityEntry => ({ ...a, title: debrand(a.title), detail: debrand(a.detail) })
  const dbConn = (c: SwarmConnection): SwarmConnection => ({
    ...c,
    error: debrand(c.error),
    account: c.account?.map((x) => ({ label: debrand(x.label), value: debrand(x.value) }))
  })
  const dbAgent = (a: AgentInfo): AgentInfo => ({ ...a, description: debrand(a.description), lastError: debrand(a.lastError) })
  const dbNote = (n: AppNotification): AppNotification => ({ ...n, title: debrand(n.title), body: debrand(n.body) })
  const UNSUPPORTED_REPLY = 'The model answered with an internal tool call instead of text. Press retry, or pick a different model in Settings → AI & models.'
  const dbMessage = (m: ChatMessage): ChatMessage => {
    if (m.role !== 'assistant') return m
    const content = debrand(stripToolMarkup(m.content))
    if (content === m.content) return m
    if (!content.trim() && m.status === 'complete') return { ...m, content: '', status: 'error', error: UNSUPPORTED_REPLY }
    return { ...m, content }
  }
  const dbConversation = (c: Conversation): Conversation => {
    if (!c.preview) return c
    const preview = debrand(stripToolMarkup(c.preview))
    return { ...c, preview: preview || 'The model returned no text' }
  }
  const dbInteraction = (i: Interaction): Interaction => {
    if (!i.response) return i
    const response = debrand(stripToolMarkup(i.response))
    if (response === i.response) return i
    if (!response.trim() && i.status === 'done') return { ...i, response: undefined, status: 'error', error: UNSUPPORTED_REPLY }
    return { ...i, response }
  }

  /* --------------------------------------------------------------- settings */

  const mergeSettings = (s: AppSettings): AppSettings => {
    const v = voiceConfig()
    return deepMerge(s, {
      voice: {
        ...prefs.get().voice,
        wakeWordEnabled: v.wakeEnabled,
        wakeEngine: 'zvyra-kws',
        sensitivity: v.sensitivity,
        micDeviceId: v.micDeviceId,
        listenTimeoutSec: v.idleTimeoutSec,
        silenceTimeoutMs: v.silenceMs,
        sttProvider: v.model,
        ttsProvider: 'gemini-live',
        ttsVoice: v.voice,
        ttsRate: v.speakingRate
      }
    })
  }

  /* --------------------------------------------------------------- notifications */

  const policy = () => prefs.get().notify
  const snoozed = (p = policy()) => !!p.snoozedUntil && Date.parse(p.snoozedUntil) > Date.now()
  const suppressed = (n: Pick<AppNotification, 'priority' | 'category'>) => {
    const p = policy()
    if (!p.enabled || !p.categories[n.category] || p.doNotDisturb || snoozed(p)) return true
    if (p.quietHours.enabled && inQuietHours(p.quietHours.start, p.quietHours.end, new Date())) return !(p.quietHours.allowCritical && n.priority === 'critical')
    return false
  }
  // The engine's own Do-Not-Disturb also mutes its desktop popups and spoken replies.
  const syncEngineQuiet = async () => {
    const p = policy()
    await call('notifications.setPolicy', { doNotDisturb: p.doNotDisturb || snoozed(p), quietHours: { enabled: false, start: toWholeHour(p.quietHours.start), end: toWholeHour(p.quietHours.end) } }).catch((e) =>
      ctx.logger.warn('desktop', 'Could not sync quiet settings to engine', { message: String((e as Error)?.message ?? e) })
    )
  }
  let snoozeTimer: NodeJS.Timeout | null = null
  const armSnooze = () => {
    if (snoozeTimer) clearTimeout(snoozeTimer)
    const p = policy()
    if (!snoozed(p)) return
    snoozeTimer = setTimeout(() => {
      prefs.set((s) => ({ notify: { ...s.notify, snoozedUntil: null } }))
      void syncEngineQuiet()
    }, Date.parse(p.snoozedUntil!) - Date.now() + 500)
  }

  // Desktop popups are raised by the engine with Electron's Notification. Gate
  // them on the full policy (master switch, desktop, categories, quiet hours).
  let lastNote: { n: AppNotification; at: number } | null = null
  if (!notificationPatched) {
    notificationPatched = true
    // No Windows/macOS pop-ups: every notification ZVYRA raises is shown in the Dynamic Island instead.
    Notification.prototype.show = function (this: Notification) {
      const p = policy()
      const recent = lastNote && Date.now() - lastNote.at < 3000 ? lastNote.n : null
      if (!p.enabled || !p.desktop || (recent && suppressed(recent))) return
      const title = debrand(this.title || 'ZVYRA')
      const body = debrand(this.body || '')
      notify({ key: `system:${title}:${body}`, kind: /fail|error|couldn|blocked/i.test(`${title} ${body}`) ? 'error' : /done|complete|finished|ready/i.test(title) ? 'success' : 'info', title, body, timeoutMs: 7000 })
    }
  }

  const deliver = (raw: AppNotification): AppNotification => {
    const n = dbNote(raw)
    lastNote = { n, at: Date.now() }
    const p = policy()
    const blocked = suppressed(n)
    const spoken = !blocked && p.spoken && atLeast(n.priority, p.spokenMinPriority)
    if (spoken) void voice.speak(`${n.title}. ${n.body}`.slice(0, 600)).catch(() => undefined)
    const callIt = !blocked && calls.shouldCall(n.priority, atLeast)
    if (callIt) void calls.place(`ZVYRA update. ${n.title}. ${n.body}`).catch(() => undefined)
    return { ...n, delivered: { desktop: !blocked && p.desktop, spoken, call: callIt } }
  }

  /* --------------------------------------------------------------- tasks */

  const hiddenTasks = () => new Set(prefs.get().hiddenTasks)

  async function createTask(input: MethodArgs<'tasks.create'>): Promise<Task> {
    let projectId = input.projectId
    if (!projectId) projectId = (await call('projects.active', undefined).catch(() => null))?.id
    let instruction = input.instruction
    if (prefs.get().memory.includeInContext) {
      const mems = await call('memory.list', {}).catch(() => [] as MemoryItem[])
      const picked = mems
        .map((m) => ({ m, score: (m.pinned || m.kind === 'preference' ? 1 : 0) + relevance(instruction, `${m.title} ${m.content}`) + (projectId && m.projectId === projectId ? 0.5 : 0) }))
        .filter((x) => x.score >= 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
      if (picked.length) instruction += `\n\nContext from saved memory:\n${picked.map(({ m }) => `- ${m.title}${m.content ? `: ${m.content.slice(0, 300)}` : ''}`).join('\n')}`
    }
    const t = await call('tasks.create', { instruction, source: input.source, projectId, model: input.model })
    return dbTask(t)
  }

  /* --------------------------------------------------------------- automations */

  const scheduler = new Scheduler(
    schedDoc,
    (a) => createTask({ instruction: a.instruction, source: 'automation', projectId: a.projectId }),
    (a) => emit('automation.upsert', a)
  )

  const innerAutomations = () => call('automations.list', undefined).catch(() => [] as Automation[])

  /* --------------------------------------------------------------- camera (preview + frames live in the island) */

  const camera = (() => {
    let open = false
    const pending = new Map<string, { resolve: (d: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
    const publish = (captureId?: string) => emit('camera.state', { open, captureId })
    const failAll = (why: string) => {
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(why))
      }
      pending.clear()
    }
    return {
      state: (): CameraState => ({ open }),
      open() {
        if (!open) activity('camera.opened', 'Camera preview on', 'Shown in the Dynamic Island')
        open = true
        publish()
      },
      close() {
        if (open) activity('camera.closed', 'Camera off')
        open = false
        failAll('The camera was closed')
        publish()
      },
      capture(): Promise<string> {
        const id = randomUUID()
        if (!open) activity('camera.opened', 'Camera preview on', 'Shown in the Dynamic Island')
        open = true
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error('The camera didn’t send a picture. Check a webcam is connected and Windows allows camera access for desktop apps (Settings → Privacy & security → Camera).'))
          }, 20_000)
          pending.set(id, { resolve, reject, timer })
          publish(id)
        })
      },
      frame(a: MethodArgs<'camera.frame'>) {
        const p = pending.get(a.captureId)
        if (!p) return
        clearTimeout(p.timer)
        pending.delete(a.captureId)
        if (a.error || !a.dataUrl) p.reject(new Error(a.error || 'The camera sent no picture'))
        else if (!/^data:image\/(jpeg|png|webp);base64,/.test(a.dataUrl) || a.dataUrl.length > 12_000_000) p.reject(new Error('The camera frame was invalid'))
        else p.resolve(a.dataUrl)
        publish()
      }
    }
  })()

  /* --------------------------------------------------------------- builder agent (background multi-file jobs) */

  const builds = new Map<string, AbortController>()
  const buildCards = new Map<string, ToolActivity & { files?: string[] }>()
  const toolActivity = (a: ToolActivity) => emit('tool.activity', a)

  function startBuild(instruction: string) {
    const id = randomUUID()
    const startedAt = new Date().toISOString()
    let card: ToolActivity = { id, tool: 'run_task', kind: 'build', label: 'Building', subject: instruction.slice(0, 160), status: 'running', steps: [], startedAt, updatedAt: startedAt }
    let files: string[] = []
    const update = (patch: Partial<ToolActivity>) => {
      card = { ...card, ...patch, updatedAt: new Date().toISOString() }
      buildCards.set(id, { ...card, files })
      toolActivity(card)
    }
    buildCards.set(id, card)
    toolActivity(card)
    activity('task.started', `Builder started: ${instruction.slice(0, 90)}`, undefined, 'info')
    const ctrl = new AbortController()
    builds.set(id, ctrl)
    // Fresh agent per job so parallel builds never share conversation history.
    const builder = new TextAgent(() => secrets.get(GEMINI_KEY), toolHost, systemContext, ctx.logger)
    void builder
      .run(
        instruction,
        (u) => {
          if (u.files) files = u.files
          if (u.action) update({ steps: [...(card.steps ?? []), u.action].slice(-8), summary: files.length ? `${files.length} file${files.length === 1 ? '' : 's'} written` : 'Planning…' })
          else if (u.thinking) update({ summary: files.length ? `${files.length} file${files.length === 1 ? '' : 's'} written · ${u.thinking}` : u.thinking })
        },
        ctrl.signal
      )
      .then((r) => {
        update({ status: 'done', label: 'Built', summary: r.reply.slice(0, 900) })
        activity('task.completed', `Builder finished: ${instruction.slice(0, 80)}`, r.files[0], 'success')
        notify({ key: `task:${id}`, kind: 'success', title: 'Task completed', body: r.reply.slice(0, 220), detail: r.files[0] ? r.files[0].replace(/[\\/][^\\/]+$/, '') : undefined, timeoutMs: 8000 })
      })
      .catch((err) => {
        const why = friendlyError(err).replace(/^Gemini Live: /, '')
        update({ status: 'error', label: 'Build stopped', summary: why })
        activity('task.failed', `Builder stopped: ${instruction.slice(0, 80)}`, String((err as Error)?.message ?? err).slice(0, 200), 'error')
        if (!ctrl.signal.aborted) notify({ key: `task:${id}`, kind: 'error', title: 'Task failed', body: why, detail: instruction.slice(0, 120), timeoutMs: 10_000 })
      })
      .finally(() => builds.delete(id))
    return { id, title: instruction.slice(0, 60), status: 'running' }
  }

  /** Timers and other one-off alerts: right-side ZVYRA notification (the shell falls back to a native one). */
  const notifyUser = (title: string, body: string) => notify({ key: `note:${title}:${body}`, kind: 'info', title, body, timeoutMs: 8000 })

  const toolHost: ToolHost = {
    activity,
    geminiKey: () => secrets.get(GEMINI_KEY),
    toolActivity,
    notify: notifyUser,
    notifyEvent: (t) => notify(t),
    camera,
    runCommand: (command, o) => terminal.execute(command, o.cwd, { source: 'agent', shell: o.shell, background: o.background, timeoutMs: o.timeoutMs, signal: o.signal, taskTitle: o.taskTitle }),
    workspace: async () => {
      const p = await call('projects.active', undefined).catch(() => null)
      if (p?.path && !prefs.get().hiddenProjects.includes(p.id) && existsSync(p.path)) return { name: p.name, path: p.path, selected: true }
      return { name: 'ZVYRA Projects', path: PROJECTS_DIR, selected: false }
    },
    projects: async () => (await visibleProjects()).map((p) => ({ id: p.id, name: p.name, path: p.path })),
    openInEditor: (path) => apps.openInEditor(path),
    runTask: async (instruction) => {
      if (!instruction.trim()) throw new Error('Empty instruction')
      if (!secrets.has(GEMINI_KEY)) {
        const t = await createTask({ instruction, source: 'voice' })
        activity('task.started', `Background task: ${t.title}`, undefined, 'info')
        return { id: t.id, title: t.title, status: t.status }
      }
      return startBuild(instruction)
    },
    extraRoots: async () => (await files.roots().catch(() => [])).map((r) => r.path),
    userApps: () => apps.list(),
    launchUserApp: (id) => apps.launch(id),
    status: async () => {
        const tasks = await call('tasks.list', { limit: 50 }).catch(() => [] as Task[])
        const hidden = hiddenTasks()
        const visible = tasks.filter((t) => !hidden.has(t.id))
        const active = visible.filter((t) => ACTIVE.includes(t.status))
        const recent = visible.filter((t) => t.status === 'completed' || t.status === 'failed').slice(0, 3)
        const approvals = await call('permissions.pending', undefined).catch(() => [])
        const conn = await call('swarm.connection', undefined).catch(() => null)
        const builderLines = [...buildCards.values()]
        .filter((b) => b.status === 'running' || Date.now() - Date.parse(b.updatedAt) < 30 * 60_000)
        .map((b) => {
          const where = b.files?.length ? ` Files are in ${b.files[0].replace(/[\\/][^\\/]+$/, '')} (${b.files.length} written: ${b.files.map((f) => f.split(/[\\/]/).pop()).slice(-8).join(', ')}).` : ''
          return b.status === 'running'
            ? `Builder is working on “${b.subject}”: ${b.summary ?? 'planning'}; last step: ${b.steps?.at(-1) ?? 'planning the files'}.${where}`
            : `Builder ${b.status === 'done' ? 'finished' : 'stopped'} “${b.subject}”: ${b.summary?.slice(0, 200) ?? ''}${where}`
        })
      return [
          ...builderLines,
          `AI provider: ${conn?.status === 'connected' ? 'connected' : 'not connected'}.`,
          active.length ? `Running: ${active.map((t) => `${t.title} (${t.status.replace('_', ' ')}${t.currentAction ? `: ${debrand(t.currentAction)}` : ''})`).join('; ')}.` : 'No tasks running.',
          approvals.length ? `${approvals.length} approval(s) waiting: ${approvals.map((p) => debrand(p.title)).join('; ')}.` : '',
          recent.length ? `Recent: ${recent.map((t) => `${t.title} — ${t.status}${t.summary ? `: ${debrand(t.summary)?.slice(0, 160)}` : ''}`).join('; ')}.` : ''
        ]
          .filter(Boolean)
          .join(' ')
      }
  }

  const systemContext = async () => {
        const s = await call('settings.get', undefined).catch(() => null)
        const project = await call('projects.active', undefined).catch(() => null)
        const mems = await call('memory.list', {}).catch(() => [] as MemoryItem[])
        const keep = mems.filter((m) => m.pinned || m.kind === 'preference').slice(0, 8)
        return [
          `Current date and time: ${new Date().toLocaleString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`,
          s?.profile.name ? `The user's name is ${s.profile.name}.` : '',
          project
            ? `Workspace: the selected project “${project.name}” at ${project.path}. Relative paths and new work go there; “this project” means it.`
            : `Workspace: no project is selected, so new work goes in ${PROJECTS_DIR}. Always tell the user the folder you used.`,
          keep.length ? `Things the user asked you to remember:\n${keep.map((m) => `- ${m.title}${m.content ? `: ${m.content.slice(0, 200)}` : ''}`).join('\n')}` : ''
        ]
          .filter(Boolean)
          .join('\n')
  }

  const voice = new VoiceEngine({
    resourcesPath: ctx.resourcesPath,
    workDir: join(dir, 'voice'),
    logger: ctx.logger,
    getKey: () => secrets.get(GEMINI_KEY),
    getConfig: voiceConfig,
    emit,
    activity,
    onInteraction: (i) => {
      voiceInteractions.unshift(i)
      voiceInteractions.splice(30)
    },
    tools: { host: toolHost, systemContext }
  })

  const agent = new TextAgent(() => secrets.get(GEMINI_KEY), toolHost, systemContext, ctx.logger)
  const agentRuns = new Map<string, AbortController>()

  /** Typed commands from the island / Home go straight to the desktop agent. */
  async function submitToAgent(text: string, source: Interaction['source']): Promise<Interaction> {
    const now = new Date().toISOString()
    let i: Interaction = { id: randomUUID(), source, input: text, status: 'pending', createdAt: now, updatedAt: now }
    const push = (patch: Partial<Interaction>) => {
      i = { ...i, ...patch, updatedAt: new Date().toISOString() }
      emit('assistant.interaction', i)
      const idx = voiceInteractions.findIndex((x) => x.id === i.id)
      if (idx >= 0) voiceInteractions[idx] = i
      else voiceInteractions.unshift(i)
      voiceInteractions.splice(30)
    }
    push({})
    const ctrl = new AbortController()
    agentRuns.set(i.id, ctrl)
    const steps: string[] = []
    // Once the agent starts writing files it's a build: show a live build card in the island.
    let card: ToolActivity | null = null
    const updateCard = (patch: Partial<ToolActivity>) => {
      if (!card) return
      card = { ...card, ...patch, updatedAt: new Date().toISOString() }
      toolActivity(card)
    }
    void agent
      .run(
        text,
        (u) => {
          if (u.thinking && !u.action) updateCard({ summary: u.thinking })
          if (u.action) {
            steps.push(u.action)
            push({ status: 'streaming', response: `${u.action}…` })
            if (!card && (u.files?.length || /^Writing /.test(u.action))) {
              const now = new Date().toISOString()
              card = { id: `build-${i.id}`, tool: 'agent', kind: 'build', label: 'Building', subject: text.slice(0, 160), status: 'running', steps: [], startedAt: now, updatedAt: now }
            }
            updateCard({ steps: steps.slice(-8), summary: u.files?.length ? `${u.files.length} file${u.files.length === 1 ? '' : 's'} written` : 'Planning…' })
          }
        },
        ctrl.signal
      )
      .then((r) => {
        push({ status: 'done', response: r.reply })
        updateCard({ status: 'done', label: 'Built', summary: r.reply.slice(0, 900) })
        // Only real work gets a notification; plain answers stay in the island.
        if (r.files.length || r.actions.some((a) => !/— failed$/.test(a) && !/^(Checking status|Reading|Looking in|Reviewing)/.test(a))) {
          const failed = r.actions.filter((a) => /— failed$/.test(a)).length
          notify({
            key: `task:${i.id}`,
            kind: failed && !r.files.length ? 'error' : 'success',
            title: failed && !r.files.length ? 'Task finished with problems' : 'Task completed',
            body: r.reply.slice(0, 220),
            detail: r.files.length ? (r.files.length === 1 ? r.files[0] : `${r.files.length} files in ${r.files[0].replace(/[\\/][^\\/]+$/, '')}`) : undefined,
            timeoutMs: 8000
          })
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        const why = friendlyError(err).replace(/^Gemini Live: /, '')
        push({ status: ctrl.signal.aborted ? 'cancelled' : 'error', error: why, response: steps.length ? `${steps.join(' → ')}` : undefined })
        updateCard({ status: 'error', label: 'Build stopped', summary: why })
        if (!ctrl.signal.aborted) notify({ key: `task:${i.id}`, kind: 'error', title: 'Task failed', body: why, detail: text.slice(0, 120), timeoutMs: 10_000 })
        ctx.logger.warn('agent', 'run failed', { message: msg.slice(0, 300) })
      })
      .finally(() => agentRuns.delete(i.id))
    return i
  }

  /* --------------------------------------------------------------- memory retention */

  const enforceRetention = async () => {
    const days = prefs.get().memory.retentionDays
    if (!days) return
    const cutoff = Date.now() - days * 86_400_000
    const items = await call('memory.list', {}).catch(() => [] as MemoryItem[])
    let removed = 0
    for (const m of items) {
      if (!m.pinned && Date.parse(m.updatedAt) < cutoff) {
        await call('memory.delete', { id: m.id }).then(() => removed++).catch(() => undefined)
      }
    }
    if (removed) activity('memory.expired', `Removed ${removed} expired memor${removed === 1 ? 'y' : 'ies'}`, `Older than ${days} days`)
  }

  /* --------------------------------------------------------------- engine events */

  inner.subscribe((e) => {
    switch (e.type) {
      case 'task.upsert':
        if (hiddenTasks().has(e.payload.id)) return
        scheduler.onTask(e.payload)
        return emit('task.upsert', dbTask(e.payload))
      case 'task.event':
        return emit('task.event', dbEvent(e.payload))
      case 'permission.requested':
        if (e.payload.taskId && allowTask.has(e.payload.taskId)) {
          void call('permissions.respond', { id: e.payload.id, decision: 'allow_once' })
            .then(() => activity('permission.auto', `Approved for task: ${e.payload.title}`, 'You allowed this task to continue without asking'))
            .catch(() => emit('permission.requested', e.payload))
          return
        }
        return emit('permission.requested', { ...e.payload, title: debrand(e.payload.title), description: debrand(e.payload.description) })
      case 'notification.new':
        return emit('notification.new', deliver(e.payload))
      case 'settings.changed':
        return emit('settings.changed', mergeSettings(e.payload))
      case 'activity.new':
        return emit('activity.new', dbActivity(e.payload))
      case 'swarm.connection':
        return emit('swarm.connection', dbConn(e.payload))
      case 'chat.message':
        return emit('chat.message', dbMessage(e.payload))
      case 'chat.conversation':
        return emit('chat.conversation', dbConversation(e.payload))
      case 'voice.status':
      case 'voice.transcript':
      case 'voice.level':
        return // the Gemini voice engine owns voice state
      case 'assistant.interaction':
        if (e.payload.source === 'voice') return
        return emit('assistant.interaction', dbInteraction(e.payload))
      case 'chat.delta':
        return emit('chat.delta', { ...e.payload, delta: e.payload.delta.replace(/\bSWARM\b/g, 'ZVYRA') })
      case 'agents.update':
        return emit('agents.update', dbAgent(e.payload))
      case 'project.upsert':
        if (prefs.get().hiddenProjects.includes(e.payload.id)) return
        return emitRaw(e)
      default:
        return emitRaw(e)
    }
  })

  /* --------------------------------------------------------------- startup */

  async function connectAI() {
    try {
      let conn = await call('swarm.connection', undefined)
      // Background agents had no model unless a separate provider key was added: reuse the Gemini key.
      const gemini = secrets.get(GEMINI_KEY)
      if (!conn.hasApiKey && gemini) {
        conn = await call('swarm.configure', { baseUrl: 'swarm://embedded/google', apiKey: gemini }).catch((e) => {
          ctx.logger.warn('desktop', 'Could not give the Gemini key to background agents', { message: String((e as Error)?.message ?? e) })
          return conn
        })
        if (conn.hasApiKey) activity('model.connected', 'Background agents now use your Gemini key', 'Change it in Settings → AI & models', 'info')
      }
      if (!conn.hasApiKey) return
      if (conn.status === 'connected') {
        const known = await call('models.list', {}).catch(() => [])
        if (!known.length) await call('models.list', { refresh: true }).catch(() => undefined)
        return
      }
      const original = conn.baseUrl
      conn = await call('swarm.test', undefined)
      if (conn.status !== 'connected') {
        for (const p of conn.endpointPresets ?? []) {
          if (!p.configured || p.value === original) continue
          await call('swarm.configure', { baseUrl: p.value })
          conn = await call('swarm.test', undefined).catch(() => conn)
          if (conn.status === 'connected') break
        }
        if (conn.status !== 'connected') await call('swarm.configure', { baseUrl: original }).catch(() => undefined)
      }
      if (conn.status === 'connected') {
        const models = await call('models.list', { refresh: true }).catch((e) => {
          ctx.logger.warn('desktop', 'Model discovery failed', { message: String((e as Error)?.message ?? e) })
          return []
        })
        ctx.logger.info('desktop', `Discovered ${models.length} models (${models.filter((m) => m.available).length} available)`)
        activity('model.connected', 'AI provider connected', debrand(conn.account?.find((a) => /healthy/.test(a.value))?.label), 'success')
      } else {
        activity('model.failed', 'Couldn’t connect to an AI provider', debrand(conn.error), 'warning')
      }
      emit('swarm.connection', dbConn(await call('swarm.connection', undefined)))
    } catch (err) {
      ctx.logger.warn('desktop', 'Auto-connect failed', { message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function startup() {
    importGeminiKey()
    voice.refresh()
    const qaPrompt = process.env['ZVYRA_QA_AGENT_PROMPT']
    if (qaPrompt && !ctx.isPackaged) {
      // Dev-only: run one typed command through the desktop agent and log the outcome.
      setTimeout(() => {
        void submitToAgent(qaPrompt, 'island').then((i) => {
          const off = setInterval(() => {
            const cur = voiceInteractions.find((x) => x.id === i.id)
            if (cur && ['done', 'error', 'cancelled'].includes(cur.status)) {
              clearInterval(off)
              ctx.logger.info('agent', 'QA result', { status: cur.status, response: cur.response?.slice(0, 400), error: cur.error })
            }
          }, 500)
        })
      }, 5000)
    }
    const qaWav = process.env['ZVYRA_QA_VOICE_WAV']
    if (qaWav && !ctx.isPackaged) {
      // Dev-only end-to-end voice check: wake word → Gemini Live → spoken reply.
      setTimeout(() => {
        const b = readFileSync(qaWav)
        ctx.logger.info('voice', 'QA: starting injected clip')
        const data = b.indexOf('data', 12)
        void voice.injectWav(new Uint8Array(b.subarray(data + 8)))
      }, Number(process.env['ZVYRA_QA_VOICE_DELAY_MS'] ?? 6000))
    }
    if (!prefs.get().notifyImported) {
      const p = await call('notifications.policy', undefined).catch(() => null)
      prefs.set((s) => ({ notifyImported: true, notify: p ? { ...s.notify, doNotDisturb: p.doNotDisturb, quietHours: { ...p.quietHours, allowCritical: s.notify.quietHours.allowCritical } } : s.notify }))
    }
    await syncEngineQuiet()
    armSnooze()
    scheduler.start()
    void enforceRetention()
    const retention = setInterval(() => void enforceRetention(), 6 * 3600_000)
    retention.unref?.()
    void connectAI()
  }
  setTimeout(() => void startup(), 800)

  async function setupState(): Promise<SetupState> {
    const conn = await call('swarm.connection', undefined).catch(() => null)
    const configured = new Set((conn?.endpointPresets ?? []).filter((p) => p.configured).map((p) => p.value.split('/').pop()))
    return {
      onboarded: prefs.get().onboarded,
      providers: SETUP_PROVIDERS.map((p) => ({ ...p, configured: p.id === 'gemini' ? secrets.has(GEMINI_KEY) : configured.has(SWARM_ID[p.id]) })),
      wakeSamples: voice.wakeSamples()
    }
  }

  /* --------------------------------------------------------------- handlers */

  type H = { [K in MethodName]?: (a: MethodArgs<K>) => Promise<MethodResult<K>> | MethodResult<K> }

  const h: H = {
    'system.info': async () => {
      const i = await call('system.info', undefined)
      return {
        ...i,
        backend: 'ZVYRA engine',
        backendVersion: debrand(i.backendVersion),
        capabilities: { ...i.capabilities, files: true, terminal: true, browser: true, apps: true, codeEditor: true, calls: true, chatAttachments: true, automations: true, notifications: true, voice: true, wakeWord: true, voiceTuning: true }
      }
    },
    'system.diagnostics': async () => {
      const checks = (await call('system.diagnostics', undefined).catch(() => [] as DiagnosticCheck[])).map((c) => ({ ...c, label: debrand(c.label), detail: debrand(c.detail), fixRoute: c.fixRoute === 'settings/swarm' ? 'settings/ai' : c.fixRoute }))
      const code = findVSCode()
      const cs = calls.status()
      return [
        ...checks,
        { id: 'credentials', label: 'Secure credential storage', status: safeStorage.isEncryptionAvailable() ? 'ok' : 'error', detail: safeStorage.isEncryptionAvailable() ? 'Windows data protection (DPAPI) available' : 'Encryption unavailable — secrets cannot be saved' },
        { id: 'scheduler', label: 'Automation scheduler', status: 'ok', detail: `${scheduler.list().filter((a) => a.enabled).length} active schedule(s); runs while ZVYRA is open` },
        { id: 'vscode', label: 'Code editor', status: code ? 'ok' : 'warning', detail: code ?? 'VS Code not found — folders open in File Explorer' },
        { id: 'calls', label: 'Work calls', status: cs.configured ? 'ok' : 'unknown', detail: cs.configured ? `Twilio → ${cs.destinationMasked}` : 'Not configured (optional)', fixRoute: 'settings/notifications' }
      ]
    },
    'system.logs': async (a) => (await call('system.logs', a)).map((l) => ({ ...l, scope: debrand(l.scope), message: debrand(l.message) })),
    'system.openLogsFolder': async () => {
      const err = await shell.openPath(join(ctx.userDataPath, 'logs'))
      if (err) throw new ZvyraError('BACKEND_ERROR', err)
    },
    'system.openDataFolder': async () => {
      const err = await shell.openPath(ctx.userDataPath)
      if (err) throw new ZvyraError('BACKEND_ERROR', err)
    },
    'system.stopAll': async () => {
      terminal.killAll()
      for (const c of [...builds.values(), ...agentRuns.values()]) c.abort()
      return call('system.stopAll', undefined)
    },

    'settings.get': async () => mergeSettings(await call('settings.get', undefined)),
    'settings.update': async (patch) => {
      const { voice: patchVoice, ...rest } = patch
      const base = Object.keys(rest).length ? await call('settings.update', rest) : await call('settings.get', undefined)
      if (patchVoice) {
        prefs.set((s) => ({ voice: { ...s.voice, ...patchVoice } }))
        voice.refresh()
      }
      const merged = mergeSettings(base)
      if (patchVoice) emit('settings.changed', merged)
      return merged
    },

    'voice.status': () => voice.status(),
    'voice.setWakeWord': ({ enabled }) => {
      prefs.set((s) => ({ voice: { ...s.voice, wakeWordEnabled: enabled } }))
      voice.refresh()
      emitSettings()
      activity('voice.wake', enabled ? 'Listening for “Hey Zvyra”' : 'Wake word off', enabled ? 'On-device — no audio leaves your PC until you say the wake word' : undefined)
      return voice.status()
    },
    'voice.startListening': async () => {
      await voice.converse('push')
      return voice.status()
    },
    'voice.stopListening': () => {
      voice.sleep('stopped by user')
      return voice.status()
    },
    'voice.cancel': () => {
      voice.cancel()
      return voice.status()
    },
    'voice.speak': async ({ text }) => {
      if (!text.trim()) throw new ZvyraError('INVALID_ARGS', 'Nothing to say')
      await voice.speak(text.slice(0, 4000)).catch((e) => {
        throw new ZvyraError('UNAVAILABLE', e instanceof Error ? e.message : String(e), 'settings/voice')
      })
    },
    'voice.stopSpeaking': () => voice.stopSpeaking(),
    'voice.devices': () => voice.devicesList(),
    'voice.selectDevice': ({ deviceId }) => {
      prefs.set((s) => ({ voice: { ...s.voice, micDeviceId: deviceId || null } }))
      voice.refresh()
      return voice.status()
    },
    'voice.engines': () => voice.engines(),
    'voice.configureEngine': async ({ engineId, values }) => {
      if (engineId === 'gemini-live') {
        const key = typeof values['apiKey'] === 'string' ? values['apiKey'].trim() : ''
        if (key) {
          if (!/^[A-Za-z0-9_-]{20,}$/.test(key)) throw new ZvyraError('INVALID_ARGS', 'That doesn’t look like a Gemini API key')
          secrets.set(GEMINI_KEY, key)
          await voice.listModels(true).catch(() => undefined)
          activity('voice.setup', 'Gemini API key saved', 'Stored encrypted on this PC', 'success')
          void connectAI()
        }
        const patchV: Partial<AppSettings['voice']> = {}
        if (typeof values['model'] === 'string' && values['model']) patchV.sttProvider = values['model']
        if (typeof values['voice'] === 'string' && GEMINI_VOICES.some((v) => v.name === values['voice'])) patchV.ttsVoice = values['voice'] as string
        if (Object.keys(patchV).length) {
          prefs.set((s) => ({ voice: { ...s.voice, ...patchV } }))
          emitSettings()
        }
        voice.refresh()
      } else if (engineId === 'zvyra-kws') {
        const n = Number(values['sensitivity'])
        if (Number.isFinite(n)) prefs.set((s) => ({ voice: { ...s.voice, sensitivity: Math.min(0.95, Math.max(0.05, n)) } }))
        voice.refresh()
      } else throw new ZvyraError('NOT_FOUND', 'Unknown voice engine')
      return voice.engines()
    },
    'voice.testEngine': async ({ engineId }) => (engineId === 'zvyra-kws' ? voice.testWake() : voice.test()),
    'voice.trainWake': ({ action }) => {
      try {
        return voice.trainWake(action === 'clear' ? 'clear' : 'start')
      } catch (err) {
        throw new ZvyraError('UNAVAILABLE', err instanceof Error ? err.message : String(err))
      }
    },
    'assistant.submit': async (a) => {
      if (secrets.has(GEMINI_KEY)) return submitToAgent(a.text, a.source)
      return dbInteraction(await call('assistant.submit', a))
    },
    'assistant.cancel': async (a) => {
      const ctrl = agentRuns.get(a.id)
      if (ctrl) return ctrl.abort()
      return call('assistant.cancel', a)
    },
    'assistant.recent': async (a) => {
      const engine = (await call('assistant.recent', a).catch(() => [] as Interaction[])).map(dbInteraction)
      return [...voiceInteractions, ...engine].sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, a.limit ?? 20)
    },

    'tasks.list': async (a) => {
      const hidden = hiddenTasks()
      return (await call('tasks.list', a)).filter((t) => !hidden.has(t.id)).map(dbTask)
    },
    'tasks.get': async (a) => dbTask(await call('tasks.get', a)),
    'tasks.events': async (a) => (await call('tasks.events', a)).map(dbEvent),
    'tasks.create': (a) => createTask(a),
    'tasks.retry': async (a) => dbTask(await call('tasks.retry', a)),
    'tasks.message': (a) =>
      prefer('tasks.message', a, async () => {
        const t = await call('tasks.get', { id: a.id })
        const original = t.instruction.split('\n\nContext from saved memory:')[0]
        const next = await createTask({ instruction: `Follow-up to “${original.slice(0, 300)}”: ${a.text}`, source: t.source, projectId: t.projectId, model: t.model })
        activity('task.followup', 'Follow-up task started', a.text.slice(0, 120))
        return next
      }),
    'tasks.delete': (a) =>
      prefer('tasks.delete', a, async () => {
        const t = await call('tasks.get', a).catch(() => null)
        if (t && ACTIVE.includes(t.status)) await call('tasks.cancel', a).catch(() => undefined)
        prefs.set((s) => ({ hiddenTasks: [...new Set([...s.hiddenTasks, a.id])] }))
        emit('task.removed', { id: a.id })
      }),
    'tasks.clearHistory': () =>
      prefer('tasks.clearHistory', undefined, async () => {
        const hidden = hiddenTasks()
        const done = (await call('tasks.list', { limit: 1000 })).filter((t) => !ACTIVE.includes(t.status) && !hidden.has(t.id))
        prefs.set((s) => ({ hiddenTasks: [...new Set([...s.hiddenTasks, ...done.map((t) => t.id)])] }))
        for (const t of done) emit('task.removed', { id: t.id })
        return { removed: done.length }
      }),

    'permissions.respond': async (a) => {
      if (!a || typeof a.id !== 'string' || typeof a.decision !== 'string') throw new ZvyraError('INVALID_ARGS', 'id and decision are required')
      // Desktop command approvals: answered only here, through the trusted renderer IPC.
      if (approvals.owns(a.id)) {
        try {
          return approvals.respond(a.id, a.decision)
        } catch (err) {
          throw new ZvyraError('INVALID_ARGS', err instanceof Error ? err.message : String(err))
        }
      }
      if (a.decision === 'allow_always') throw new ZvyraError('INVALID_ARGS', 'Always allow is only available for commands')
      if (a.decision !== 'allow_task') return call('permissions.respond', a)
      const pending = await call('permissions.pending', undefined)
      const req = pending.find((p) => p.id === a.id)
      await call('permissions.respond', { id: a.id, decision: 'allow_once' })
      if (req?.taskId) allowTask.add(req.taskId)
    },
    'permissions.pending': async () => [
      ...approvals.list(),
      ...(await call('permissions.pending', undefined).catch(() => [])).map((p) => ({ ...p, title: debrand(p.title), description: debrand(p.description) }))
    ],
    'permissions.rules': () => approvals.rules(),
    'permissions.revokeRule': (a) => {
      if (!a || typeof a.id !== 'string') throw new ZvyraError('INVALID_ARGS', 'id is required')
      const before = approvals.rules().find((r) => r.id === a.id)
      const next = approvals.revoke(a.id)
      if (before) activity('permission.revoked', 'Saved command rule removed', before.command.slice(0, 120), 'info')
      return next
    },

    'chat.pickAttachments': async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { title: 'Attach files', properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[], filters: [{ name: 'Text and code', extensions: ['txt', 'md', 'csv', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'cs', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'sql', 'log', 'ps1', 'sh', 'toml', 'ini'] }, { name: 'All files', extensions: ['*'] }] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled) return []
      const out: Attachment[] = []
      for (const p of r.filePaths.slice(0, 10)) {
        const real = await realpath(p)
        const st = await stat(real)
        if (st.size > MAX_ATTACHMENT) throw new ZvyraError('INVALID_ARGS', `${basename(p)} is larger than 200 KB`)
        const buf = await readFile(real)
        if (buf.subarray(0, 8000).includes(0) && !TEXT_EXT.test(p)) throw new ZvyraError('INVALID_ARGS', `${basename(p)} isn’t a text file. Only text and code files can be attached.`)
        const id = randomUUID()
        attachments.set(id, { name: basename(real), content: buf.toString('utf8'), size: st.size })
        out.push({ id, name: basename(real), kind: 'text', size: st.size })
      }
      return out
    },
    'chat.messages': async (a) => (await call('chat.messages', a)).map(dbMessage),
    'chat.list': async (a) => (await call('chat.list', a)).map(dbConversation),
    'chat.send': async (a) => {
      if (!a.attachmentIds?.length) return call('chat.send', a)
      const parts = a.attachmentIds.map((id) => {
        const f = attachments.get(id)
        if (!f) throw new ZvyraError('NOT_FOUND', 'Attachment expired — attach the file again')
        const lang = extname(f.name).slice(1)
        return `\n\n---\nAttached file: ${f.name}\n\`\`\`${lang}\n${f.content}\n\`\`\``
      })
      const msg = await call('chat.send', { conversationId: a.conversationId, text: a.text + parts.join(''), model: a.model })
      for (const id of a.attachmentIds) attachments.delete(id)
      return msg
    },
    'chat.runAsTask': (a) =>
      prefer('chat.runAsTask', a, async () => {
        const m = (await call('chat.messages', { id: a.conversationId })).find((x) => x.id === a.messageId)
        if (!m) throw new ZvyraError('NOT_FOUND', 'Message not found')
        return createTask({ instruction: m.content, source: 'chat' })
      }),

    'swarm.connection': async () => dbConn(await call('swarm.connection', undefined)),
    'swarm.configure': async (a) => dbConn(await call('swarm.configure', a)),
    'swarm.test': async () => {
      const c = dbConn(await call('swarm.test', undefined))
      if (c.status === 'connected') void call('models.list', { refresh: true }).catch(() => undefined)
      return c
    },
    'agents.list': async () => (await call('agents.list', undefined)).map(dbAgent),

    'computer.status': async () => {
      const s = await call('computer.status', undefined)
      return { ...s, adapter: debrand(s.adapter), error: debrand(s.error) }
    },
    'computer.activeWindow': (a) => prefer('computer.activeWindow', a, () => windows.active()),
    'computer.windows': (a) => prefer('computer.windows', a, () => windows.list()),
    'computer.history': (a) => prefer('computer.history', a, () => []),

    'apps.integrations': () =>
      prefer('apps.integrations', undefined, async () => {
        const [conn, voice] = await Promise.all([call('swarm.connection', undefined).catch(() => null), call('voice.status', undefined).catch(() => null)])
        const cs = calls.status()
        const extra: Integration[] = [
          { id: 'ai', name: 'AI provider', category: 'service', status: conn?.status === 'connected' ? 'connected' : conn?.hasApiKey ? 'error' : 'needs_setup', detail: conn?.status === 'connected' ? 'Connected' : (debrand(conn?.error) ?? 'Add an API key'), setupHint: 'Settings → AI & models' },
          { id: 'speech', name: 'Windows speech', category: 'service', status: voice?.stt.ready ? 'connected' : 'needs_setup', detail: voice?.stt.ready ? 'Local recognition and voice ready' : voice?.stt.setupRequired, setupHint: 'Settings → Voice & microphone' },
          { id: 'twilio', name: 'Twilio (work calls)', category: 'communication', status: cs.configured ? 'connected' : 'needs_setup', detail: cs.configured ? `Calls ${cs.destinationMasked}` : 'Optional', setupHint: 'Settings → Notifications & calls' }
        ]
        return apps.integrations(extra)
      }),
    'apps.launchable': () => prefer('apps.launchable', undefined, () => apps.list()),
    'apps.launch': (a) => prefer('apps.launch', a, () => apps.launch(a.id)),
    'apps.add': () => prefer('apps.add', undefined, () => apps.add()),
    'apps.remove': (a) => prefer('apps.remove', a, () => apps.remove(a.id)),
    'apps.setPinned': (a) => prefer('apps.setPinned', a, () => apps.setPinned(a.id, a.pinned)),
    'browser.open': (a) => prefer('browser.open', a, () => apps.openUrl(a.url)),
    'code.openInEditor': (a) =>
      prefer('code.openInEditor', a, async () => {
        let target = a.path ? await files.resolve(a.path) : undefined
        if (!target && a.projectId) target = (await visibleProjects()).find((p) => p.id === a.projectId)?.path
        if (!target) throw new ZvyraError('INVALID_ARGS', 'Choose a project or file to open')
        await apps.openInEditor(target)
      }),

    'terminal.run': (a) =>
      prefer('terminal.run', a, async () => {
        if (!a || typeof a.command !== 'string') throw new ZvyraError('INVALID_ARGS', 'Enter a command')
        const cwd = a.cwd ?? (a.projectId ? (await visibleProjects()).find((p) => p.id === a.projectId)?.path : undefined)
        return terminal.run(a.command, cwd, a.shell === 'cmd' ? 'cmd' : 'powershell')
      }),
    'terminal.kill': (a) => prefer('terminal.kill', a, () => terminal.kill(a.id)),
    'terminal.runs': (a) => prefer('terminal.runs', a, () => terminal.runs(a.limit)),
    'terminal.openExternal': (a) => prefer('terminal.openExternal', a, () => terminal.openExternal(a.cwd)),

    'files.roots': () => prefer('files.roots', undefined, () => files.roots()),
    'files.addRoot': () => prefer('files.addRoot', undefined, () => files.addRoot()),
    'files.removeRoot': (a) => prefer('files.removeRoot', a, () => files.removeRoot(a.path)),
    'files.list': (a) => prefer('files.list', a, () => files.list(a.path)),
    'files.read': (a) => prefer('files.read', a, () => files.read(a.path)),
    'files.write': (a) => prefer('files.write', a, () => files.write(a.path, a.content)),
    'files.reveal': (a) => prefer('files.reveal', a, () => files.reveal(a.path)),
    'files.openExternal': (a) => prefer('files.openExternal', a, () => files.openExternal(a.path)),

    'projects.list': () => visibleProjects(),
    'projects.active': async () => {
      const p = await call('projects.active', undefined)
      return p && prefs.get().hiddenProjects.includes(p.id) ? null : p
    },
    'projects.delete': (a) =>
      prefer('projects.delete', a, async () => {
        const p = (await call('projects.list', undefined)).find((x) => x.id === a.id)
        if (!p) throw new ZvyraError('NOT_FOUND', 'Project not found')
        if (a.trashFolder && p.path) {
          const real = await realpath(p.path).catch(() => null)
          if (!real) throw new ZvyraError('NOT_FOUND', 'The project folder no longer exists')
          await shell.trashItem(real)
          activity('file.deleted', `Moved ${p.name} to the Recycle Bin`, real, 'warning')
        }
        const active = await call('projects.active', undefined).catch(() => null)
        if (active?.id === a.id) await call('projects.setActive', { id: null }).catch(() => undefined)
        prefs.set((s) => ({ hiddenProjects: [...new Set([...s.hiddenProjects, a.id])] }))
        emit('project.removed', { id: a.id })
        activity('project.removed', `Project removed: ${p.name}`, a.trashFolder ? 'Folder moved to Recycle Bin' : 'Files were not touched')
      }),

    'activity.list': async (a) => {
      const engine = (await call('activity.list', a).catch(() => [] as ActivityEntry[])).map(dbActivity)
      const q = a.query?.toLowerCase()
      const local = prefs.get().activity.filter(
        (x) => (!q || `${x.title} ${x.detail ?? ''} ${x.type}`.toLowerCase().includes(q)) && (!a.types?.length || a.types.some((t) => x.type.startsWith(t))) && (!a.before || x.ts < a.before)
      )
      return [...engine, ...local].sort((x, y) => y.ts.localeCompare(x.ts)).slice(0, a.limit ?? 200)
    },
    'activity.clear': async () => {
      await call('activity.clear', undefined)
      prefs.set({ activity: [] })
    },

    'memory.settings': async () => {
      const s = await call('memory.settings', undefined)
      return { enabled: s.enabled, agentMaySave: 'never', ...prefs.get().memory }
    },
    'memory.setSettings': async (a) => {
      if (a.agentMaySave && a.agentMaySave !== 'never') throw new ZvyraError('NOT_IMPLEMENTED', 'ZVYRA can’t save memories on its own yet. Save them yourself in Memory or Knowledge.')
      if (a.enabled !== undefined) await call('memory.setSettings', { enabled: a.enabled })
      const local: Partial<Prefs['memory']> = {}
      if (a.includeInContext !== undefined) local.includeInContext = a.includeInContext
      if (a.retentionDays !== undefined) local.retentionDays = a.retentionDays
      if (Object.keys(local).length) prefs.set((s) => ({ memory: { ...s.memory, ...local } }))
      if (local.retentionDays) void enforceRetention()
      return (await h['memory.settings']!(undefined)) as MemorySettings
    },

    'automations.list': async () => [...scheduler.list(), ...(await innerAutomations())],
    'automations.scheduler': () => ({ running: true, note: 'Schedules run while ZVYRA is open, even when its windows are hidden. Runs missed while ZVYRA was closed are skipped and noted.' }),
    'automations.create': (a) => scheduler.create(a),
    'automations.update': async (a) => {
      const { id, ...patch } = a
      if (scheduler.has(id)) return scheduler.update(id, patch)
      const old = (await innerAutomations()).find((x) => x.id === id)
      if (!old) throw new ZvyraError('NOT_FOUND', 'Automation not found')
      // Engine automations are one-time only; move them to the desktop scheduler to edit.
      const merged = { ...old, ...patch }
      const created = scheduler.create({ name: merged.name, instruction: merged.instruction, schedule: merged.schedule, enabled: merged.enabled, projectId: merged.projectId })
      await call('automations.delete', { id }).catch(() => undefined)
      emit('automation.removed', { id })
      return created
    },
    'automations.delete': async (a) => {
      if (scheduler.has(a.id)) {
        scheduler.delete(a.id)
        emit('automation.removed', { id: a.id })
        return
      }
      return call('automations.delete', a)
    },
    'automations.runNow': async (a) => {
      if (scheduler.has(a.id)) return scheduler.runNow(a.id)
      return prefer('automations.runNow', a, async () => {
        const old = (await innerAutomations()).find((x) => x.id === a.id)
        if (!old) throw new ZvyraError('NOT_FOUND', 'Automation not found')
        return createTask({ instruction: old.instruction, source: 'automation', projectId: old.projectId })
      })
    },
    'automations.runs': async (a) => (scheduler.has(a.id) ? scheduler.runs(a.id, a.limit) : call('automations.runs', a)),

    'notifications.list': async (a) => (await call('notifications.list', a)).map(dbNote),
    'notifications.policy': () => policy(),
    'notifications.setPolicy': async (patch) => {
      prefs.set((s) => ({ notify: deepMerge(s.notify, patch) }))
      if (patch.doNotDisturb !== undefined || patch.quietHours !== undefined) await syncEngineQuiet()
      return policy()
    },
    'notifications.snooze': async (a) => {
      const until = a.minutes ? new Date(Date.now() + a.minutes * 60_000).toISOString() : null
      prefs.set((s) => ({ notify: { ...s.notify, snoozedUntil: until } }))
      armSnooze()
      await syncEngineQuiet()
      return policy()
    },

    'calls.status': () => calls.status(),
    'calls.configure': (a) => calls.configure(a.provider, a.values),
    'calls.setEnabled': (a) => calls.setEnabled(a.enabled, a.minPriority),
    'calls.test': () => calls.place('This is a test call from ZVYRA. Work calls are set up correctly.'),

    'setup.state': () => setupState(),
    'setup.testKey': async ({ provider, key }) => {
      const meta = SETUP_PROVIDERS.find((p) => p.id === provider)
      if (!meta || typeof key !== 'string') throw new ZvyraError('INVALID_ARGS', 'Unknown provider')
      const r = await testProviderKey(provider, key)
      if (!r.ok) return r
      const k = key.trim()
      if (provider === 'gemini') {
        secrets.set(GEMINI_KEY, k)
        voice.refresh()
        void voice.listModels(true).catch(() => undefined)
      }
      // Background agents get every working key too (Gemini doubles as SWARM's Google provider).
      await call('swarm.configure', { baseUrl: `swarm://embedded/${SWARM_ID[provider]}`, apiKey: k }).catch((e) =>
        ctx.logger.warn('setup', `Could not store ${provider} key for agents`, { message: String((e as Error)?.message ?? e) })
      )
      activity('model.connected', `${meta.name} connected`, r.message, 'success')
      return r
    },
    'setup.demo': () => {
      const at = () => new Date().toISOString()
      const r = { id: `demo-r-${Date.now()}`, tool: 'web_search', kind: 'research' as const, label: 'Researching', subject: 'best places to visit in Japan', status: 'running' as const, startedAt: at(), updatedAt: at() }
      toolActivity(r)
      setTimeout(
        () =>
          toolActivity({
            ...r,
            status: 'done',
            label: 'Research ready',
            updatedAt: at(),
            summary: 'Kyoto for temples and gardens, Tokyo for food and nightlife, Hakone for hot springs with Mt Fuji views, and Hiroshima + Miyajima for history.',
            sources: [
              { title: 'japan-guide.com', url: 'https://www.japan-guide.com/' },
              { title: 'lonelyplanet.com', url: 'https://www.lonelyplanet.com/japan' },
              { title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Tourism_in_Japan' }
            ]
          }),
        2600
      )
      setTimeout(() => {
        const b = { id: `demo-b-${Date.now()}`, tool: 'run_task', kind: 'build' as const, label: 'Building', subject: 'A sneaker store website', status: 'running' as const, steps: ['Writing index.html', 'Writing styles.css'], summary: '2 files written', startedAt: at(), updatedAt: at() }
        toolActivity(b)
        setTimeout(() => toolActivity({ ...b, steps: [...b.steps, 'Writing cart.js', 'Testing index.html'], summary: '4 files written', updatedAt: at() }), 1800)
      }, 4200)
    },
    'setup.complete': async ({ name } = {}) => {
      if (name?.trim()) await call('settings.update', { profile: { name: name.trim().slice(0, 60) } } as never).catch(() => undefined)
      // Prefer Gemini for chat/agents when it was set up.
      if (secrets.has(GEMINI_KEY)) await call('swarm.configure', { baseUrl: 'swarm://embedded/google' }).catch(() => undefined)
      prefs.set({ onboarded: true })
      await prefs.flush()
      activity('setup.done', 'ZVYRA is set up', undefined, 'success')
      void connectAI()
      return setupState()
    },
    'camera.state': () => camera.state(),
    'camera.frame': (a) => {
      if (!a || typeof a.captureId !== 'string') throw new ZvyraError('INVALID_ARGS', 'captureId is required')
      camera.frame(a)
    },
    'camera.close': () => {
      camera.close()
      return camera.state()
    }
  }

  return {
    async invoke<K extends MethodName>(method: K, args: MethodArgs<K>): Promise<MethodResult<K>> {
      const fn = h[method] as ((a: MethodArgs<K>) => Promise<MethodResult<K>> | MethodResult<K>) | undefined
      return fn ? fn(args) : inner.invoke(method, args)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async dispose() {
      voice.dispose()
      scheduler.stop()
      terminal.killAll()
      windows.dispose()
      if (snoozeTimer) clearTimeout(snoozeTimer)
      await Promise.all([...docs.map((d) => d.flush()), secrets.flush()])
      await inner.dispose?.()
    }
  }
}
