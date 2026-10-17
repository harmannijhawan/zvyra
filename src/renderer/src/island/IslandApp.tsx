/**
 * ZVYRA Dynamic Island: one dark surface docked to the top centre of the
 * screen that morphs between real states (see lib/islandVisual.ts):
 *   idle (tiny) · listening · speech detected · processing · speaking ·
 *   working · approval · tool results · reply peek · camera · expanded panel
 *
 * Motion rules: one width/height/radius transition (no overshoot), content
 * fades in once per state group, indicators move only with real audio levels
 * or real processing. No sparkles, glows, rainbow colours or decorative loops.
 * The window has a fixed transparent footprint and is click-through outside the
 * surface, so state changes never resize or move the window.
 */
import { Check, ChevronDown, ExternalLink, FileText, Info, Maximize2, Mic, MicOff, Minus, Rocket, Send, ShieldCheck, ShieldX, Square, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as RMouseEvent } from 'react'
import type { IslandMode } from '@shared/shell'
import type { ToolActivity } from '@shared/contract'
import { call, shellCall } from '../lib/client'
import { setWakeWord, submitInstruction, toggleListening, useActiveTasks, useCompanion } from '../lib/hooks'
import { deriveIslandVisual, ISLAND_SIZES, surfaceHeight, visualGroup, type IslandVisual } from '../lib/islandVisual'
import { setState, useStore } from '../lib/store'
import { attempt, goTo } from '../lib/useAction'
import { ZMark } from '../components/brand'
import { Pet } from '../components/Pet'
import { PermissionCard } from '../components/PermissionCard'
import { PlanSteps, TaskProgress, TaskStatusBadge } from '../components/TaskBits'
import { HelixWave } from '../components/HelixWave'
import { Toasts } from '../components/ui'
import { CameraContent, ToolStack, useFreshTools } from './IslandCards'

const setMode = (mode: IslandMode) => void attempt(() => shellCall('island.setMode', { mode }))
const PEEK_MS = 9000
/** How long a notification without its own timeout stays in the island. */
const NOTICE_MS = 7000

/* ------------------------------------------------------------------ click-through + drag */

function useClickThrough() {
  const interactive = useRef(false)
  useEffect(() => {
    const set = (v: boolean) => {
      if (interactive.current === v) return
      interactive.current = v
      void shellCall('island.setInteractive', { interactive: v }).catch(() => undefined)
    }
    const onMove = (e: MouseEvent) => set(!!(e.target as Element | null)?.closest?.('.di, .toast'))
    const onLeave = () => set(false)
    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
    }
  }, [])
}

/** Click vs drag on the same surface. Dragging moves the island to another display; it re-docks on release. */
function useDrag(onClick: () => void) {
  const state = useRef<{ sx: number; sy: number; wx: number; wy: number; moved: boolean } | null>(null)
  return (e: RMouseEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('button, textarea, input, a, pre, .no-drag')) return
    state.current = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY, moved: false }
    const move = (ev: MouseEvent) => {
      const s = state.current
      if (!s) return
      const dx = ev.screenX - s.sx
      const dy = ev.screenY - s.sy
      if (!s.moved && Math.hypot(dx, dy) < 6) return
      s.moved = true
      void shellCall('island.moveTo', { x: s.wx + dx, y: s.wy + dy }).catch(() => undefined)
    }
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const s = state.current
      state.current = null
      if (!s) return
      if (s.moved) void shellCall('island.moveTo', { x: s.wx + ev.screenX - s.sx, y: s.wy + ev.screenY - s.sy, done: true }).catch(() => undefined)
      else onClick()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
}

/** Re-render once when the soonest of `deadlines` passes (instead of a 1 s ticker running forever). */
function useDeadline(deadlines: number[]) {
  const [, setTick] = useState(0)
  const next = deadlines.filter((d) => d > Date.now()).sort((a, b) => a - b)[0]
  useEffect(() => {
    if (!next) return
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(30, next - Date.now() + 20))
    return () => clearTimeout(t)
  }, [next])
  return Date.now()
}

/* ------------------------------------------------------------------ app */

export function IslandApp() {
  const island = useStore((s) => s.island)
  const reduceMotion = useStore((s) => !!s.settings?.appearance.reduceMotion)
  const voice = useStore((s) => s.voice)
  const interactions = useStore((s) => s.interactions)
  const permissions = useStore((s) => s.permissions)
  const camera = useStore((s) => s.camera)
  const tools = useStore((s) => s.tools)
  const mode = island?.mode ?? 'compact'
  useClickThrough()

  useEffect(() => {
    document.body.classList.toggle('reduce-motion', reduceMotion)
  }, [reduceMotion])

  const latest = interactions[0]
  const replyAt = latest && latest.status !== 'pending' && latest.source !== 'voice' && (latest.response || latest.error) ? Date.parse(latest.updatedAt) : 0
  const notices = useStore((s) => s.notices)
  const noticeEnd = (n: (typeof notices)[number]) => Date.parse(n.ts) + (n.timeoutMs > 0 ? n.timeoutMs : NOTICE_MS)
  const now = useDeadline([replyAt + PEEK_MS, ...notices.map(noticeEnd), ...tools.map((t) => Date.parse(t.updatedAt) + (t.kind === 'build' ? 42_000 : 14_000))])
  // Approval notices are shown as the approval card itself.
  const notice = notices.find((n) => n.kind !== 'approval' && noticeEnd(n) > now)
  const working = !!latest && (latest.status === 'pending' || latest.status === 'streaming') && latest.source !== 'voice'
  const [peekDismissed, setPeekDismissed] = useState<string | null>(null)
  const peekKey = `${latest?.id}:${latest?.status}`
  // A notification about the same result replaces the reply peek (no double message).
  const coveredByNotice = notices.some((n) => n.kind !== 'approval' && Math.abs(Date.parse(n.ts) - replyAt) < 3000)
  const hasPeek = !!replyAt && now - replyAt < PEEK_MS && peekDismissed !== peekKey && !coveredByNotice
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const dismissTool = useCallback((id: string) => setDismissed((d) => new Set(d).add(id)), [])
  const fresh = useFreshTools(now, dismissed, { skipCamera: camera.open })

  const visual = deriveIslandVisual({
    mode,
    voice,
    permissions: permissions.length,
    camera,
    freshTools: fresh.length,
    agentWorking: working,
    hasPeek,
    hasNotice: !!notice
  })

  const expand = useCallback(() => setMode('expanded'), [])
  const collapse = useCallback(() => setMode('compact'), [])

  return (
    <div className="island-root">
      <Surface visual={visual} onExpand={expand} onCollapse={collapse} dismissPeek={() => setPeekDismissed(peekKey)} tools={fresh} onDismissTool={dismissTool} />
      {visual === 'expanded' && <Toasts />}
    </div>
  )
}

/* ------------------------------------------------------------------ surface */

function Surface({
  visual,
  onExpand,
  onCollapse,
  dismissPeek,
  tools,
  onDismissTool
}: {
  visual: IslandVisual
  onExpand: () => void
  onCollapse: () => void
  dismissPeek: () => void
  tools: ToolActivity[]
  onDismissTool: (id: string) => void
}) {
  const group = visualGroup(visual)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState(0)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const update = () => setMeasured(Math.ceil(el.getBoundingClientRect().height))
    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()
    return () => ro.disconnect()
  }, [group])

  const voiceState = useStore((s) => s.voice?.state)
  const voiceActive = voiceState === 'wake_detected' || voiceState === 'listening' || voiceState === 'transcribing' || voiceState === 'speaking'
  // While talking, live tool cards (a build in progress) widen the voice pill instead of being hidden.
  const voiceWithTools = group === 'voice' && tools.length > 0
  const size = voiceWithTools ? { ...ISLAND_SIZES[visual], w: 424, max: 420 } : ISLAND_SIZES[visual]
  const height = voiceWithTools ? Math.round(Math.min(size.max, Math.max(size.h, measured || size.h))) : surfaceHeight(visual, measured)
  const rawLevel = useStore((s) => s.voiceLevel)
  // Edge glow follows the real audio level (mic while listening, ZVYRA's voice while speaking).
  const lvl = visual === 'listening' || visual === 'speech' || visual === 'speaking' ? Math.min(1, rawLevel) : 0
  const noticeBad = useStore((s) => s.notices[0]?.kind === 'error' || s.notices[0]?.kind === 'denied')
  const glow =
    visual === 'camera'
      ? 'cam'
      : visual === 'listening' || visual === 'speech'
        ? 'listen'
        : visual === 'processing'
          ? 'think'
          : visual === 'speaking'
            ? 'speak'
            : visual === 'tool' && tools.some((t) => t.status === 'running')
              ? 'tool'
              : visual === 'working'
                ? 'work'
                : visual === 'approval'
                  ? 'warn'
                  : visual === 'notice' && noticeBad
                    ? 'error'
                    : 'none'
  const onMouseDown = useDrag(visual === 'idle' ? onExpand : visual === 'mini' ? () => setMode('compact') : () => undefined)
  const inVoice = group === 'voice'

  return (
    <div
      className={`di v-${visual} g-${group} glow-${glow}`}
      style={{ width: size.w, height, borderRadius: size.r, ['--lvl' as string]: lvl.toFixed(2) }}
      onMouseDown={onMouseDown}
      role="region"
      aria-label="ZVYRA Dynamic Island"
    >
      <span className="di-glow" aria-hidden="true" />
      {/* One fade per state group; states inside a group (listening → speaking) update in place. */}
      <div className="di-body" key={group}>
        <div ref={bodyRef} className="di-measure">
          {visual === 'mini' && <MiniContent />}
          {visual === 'idle' && <IdleContent onExpand={onExpand} />}
          {inVoice && <VoiceContent visual={visual} tools={tools} />}
          {visual === 'working' && <WorkingContent />}
          {visual === 'notice' && <NoticeContent />}
          {visual === 'approval' && <ApprovalContent />}
          {visual === 'camera' && <CameraContent inVoice={voiceActive} />}
          {visual === 'tool' && (
            <div className="di-toolview">
              <ToolStack items={tools.slice(0, 2)} onDismiss={onDismissTool} />
            </div>
          )}
          {visual === 'peek' && <PeekContent onDismiss={dismissPeek} />}
          {visual === 'expanded' && <ExpandedContent onCollapse={onCollapse} />}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ small pieces */

function ProcessingDots({ label = 'Working' }: { label?: string }) {
  return (
    <span className="di-dots" role="progressbar" aria-label={label}>
      <i />
      <i />
      <i />
    </span>
  )
}

function MiniContent() {
  const voice = useStore((s) => s.voice)
  return (
    <div className="di-row mini">
      <ZMark size={16} />
      <span className={`di-state-dot ${voice?.state === 'standby' ? 'on' : ''}`} aria-hidden="true" />
    </div>
  )
}

function IdleContent({ onExpand }: { onExpand: () => void }) {
  const voice = useStore((s) => s.voice)
  const booting = useStore((s) => s.boot !== 'ready')
  const standby = voice?.state === 'standby'
  const label = booting ? 'Starting…' : standby ? `Say “${voice?.wakePhrase ?? 'Hey Zvyra'}”` : voice?.state === 'error' ? 'Voice needs attention' : 'ZVYRA'
  return (
    <div className="di-row idle">
      <ZMark size={19} />
      <span className="di-idle-label truncate" aria-live="polite">
        {label}
      </span>
      <span className={`di-state-dot ${standby ? 'on' : ''} ${voice?.state === 'error' ? 'err' : ''}`} title={standby ? 'Listening for the wake word on this PC' : 'Wake word off'} aria-hidden="true" />
      <div className="di-hover-actions no-drag">
        <button type="button" className="di-icon xs" onClick={() => void toggleListening('island')} aria-label="Talk to ZVYRA" title="Talk">
          <Mic />
        </button>
        <button type="button" className="di-icon xs" onClick={onExpand} aria-label="Expand" title="Expand">
          <Maximize2 />
        </button>
        <button type="button" className="di-icon xs" onClick={() => setMode('mini')} aria-label="Minimize" title="Minimize">
          <Minus />
        </button>
        <button type="button" className="di-icon xs" onClick={() => void attempt(() => shellCall('island.close'))} aria-label="Hide (ZVYRA keeps listening)" title="Hide — ZVYRA keeps listening for the wake word">
          <X />
        </button>
      </div>
    </div>
  )
}

const VOICE_LABEL: Record<string, string> = { listening: 'Listening', speech: 'Listening', processing: 'Thinking', speaking: 'Speaking' }

function VoiceContent({ visual, tools }: { visual: IslandVisual; tools: ToolActivity[] }) {
  const voice = useStore((s) => s.voice)
  const level = useStore((s) => s.voiceLevel)
  const transcript = useStore((s) => s.liveTranscript)
  const interactions = useStore((s) => s.interactions)
  const reply = interactions[0]?.source === 'voice' ? interactions[0]?.response : undefined
  const connecting = voice?.state === 'wake_detected'
  const line = visual === 'speaking' && reply ? reply : visual === 'listening' && connecting ? '' : transcript
  const label = connecting ? 'Listening' : VOICE_LABEL[visual]
  return (
    <div className={`di-voice s-${visual}`}>
      <div className="di-row">
        <Pet state={visual === 'processing' ? 'thinking' : visual === 'speaking' ? 'speaking' : 'listening'} size={34} level={level} />
        <span className="di-voice-label" aria-live="polite">
          {label}
        </span>
        <span className="di-voice-indicator">
          <HelixWave level={visual === 'processing' ? 0.2 : level} active width={110} height={30} tone={visual === 'speaking' ? 'speak' : visual === 'processing' ? 'think' : 'listen'} />
        </span>
        <button type="button" className="di-icon xs stop no-drag" onClick={() => void attempt(() => call('voice.stopListening'))} aria-label="End conversation" title="End conversation">
          <Square />
        </button>
      </div>
      {line && <div className="di-transcript selectable">{line.length > 120 ? '…' + line.slice(-120) : line}</div>}
      {/* Live work (builds, research…) stays visible while you keep talking. */}
      {!!tools.length && (
        <div className="di-voice-tools no-drag">
          <ToolStack items={tools.slice(0, 2)} />
        </div>
      )}
    </div>
  )
}

function WorkingContent() {
  const interactions = useStore((s) => s.interactions)
  const latest = interactions[0]
  const action = latest?.status === 'streaming' && latest.response ? latest.response.replace(/…$/, '') : latest?.input
  return (
    <div className="di-row working">
      <ProcessingDots />
      <span className="di-voice-label">Working</span>
      <span className="di-sub truncate" title={action}>
        {action}
      </span>
      {latest && (
        <button type="button" className="di-icon xs stop no-drag" onClick={() => void attempt(() => call('assistant.cancel', { id: latest.id }))} aria-label="Stop" title="Stop">
          <Square />
        </button>
      )}
    </div>
  )
}

const NOTICE_ICON = { approved: ShieldCheck, denied: ShieldX, success: Check, error: TriangleAlert, file: FileText, launch: Rocket, info: Info, approval: ShieldCheck }

/** The newest live ZVYRA notification, shown in the island instead of a separate window. */
function NoticeContent() {
  const notices = useStore((s) => s.notices)
  const n = notices.find((x) => x.kind !== 'approval' && Date.parse(x.ts) + (x.timeoutMs > 0 ? x.timeoutMs : NOTICE_MS) > Date.now())
  if (!n) return null
  const Icon = NOTICE_ICON[n.kind]
  const bad = n.kind === 'error' || n.kind === 'denied'
  return (
    <div className="di-notice-row" role={bad ? 'alert' : 'status'} aria-live={bad ? 'assertive' : 'polite'}>
      <div className="di-row">
        <span className={`di-result ${bad ? 'err' : ''}`} aria-hidden="true">
          <Icon />
        </span>
        <div className="di-text">
          <div className="di-title truncate">{n.title}</div>
          {(n.body || n.detail) && (
            <div className="di-sub truncate" title={n.detail ?? n.body}>
              {n.body}
              {n.body && n.detail ? ' · ' : ''}
              {n.detail && <span className="di-mono">{n.detail}</span>}
            </div>
          )}
        </div>
        <button type="button" className="di-icon xs no-drag" onClick={() => setState((s) => ({ notices: s.notices.filter((x) => x.id !== n.id) }))} aria-label="Dismiss notification" title="Dismiss">
          <X />
        </button>
      </div>
    </div>
  )
}

function ApprovalContent() {
  const permissions = useStore((s) => s.permissions)
  const p = permissions[0]
  if (!p) return null
  return (
    <div className="di-approval no-drag">
      {permissions.length > 1 && <div className="di-approval-count">1 of {permissions.length} waiting</div>}
      <PermissionCard key={p.id} request={p} compact />
    </div>
  )
}

function PeekContent({ onDismiss }: { onDismiss: () => void }) {
  const interactions = useStore((s) => s.interactions)
  const latest = interactions[0]
  const failed = latest?.status === 'error'
  return (
    <div className="di-peek">
      <div className="di-row">
        <span className={`di-result ${failed ? 'err' : ''}`} aria-hidden="true">
          {failed ? <TriangleAlert /> : <Check />}
        </span>
        <div className="di-text">
          <div className="di-title">{failed ? 'Couldn’t finish' : latest?.status === 'cancelled' ? 'Stopped' : 'Done'}</div>
          <div className="di-sub truncate">{latest?.input}</div>
        </div>
        <button type="button" className="di-icon xs no-drag" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
          <ChevronDown />
        </button>
      </div>
      <div className={`di-reply selectable ${failed ? 'error' : ''}`}>{failed ? (latest?.error ?? 'Something went wrong') : latest?.response}</div>
    </div>
  )
}

function ExpandedContent({ onCollapse }: { onCollapse: () => void }) {
  const companion = useCompanion()
  const voice = useStore((s) => s.voice)
  const interactions = useStore((s) => s.interactions)
  const tasks = useStore((s) => s.tasks)
  const active = useActiveTasks()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const latest = interactions[0]
  const current = active[0] ?? (latest?.taskId ? tasks[latest.taskId] : undefined)
  const wakeOn = !!voice?.wakeWordEnabled
  const needsKey = !!voice && !voice.stt.ready

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 200)
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && document.activeElement?.tagName !== 'TEXTAREA' && onCollapse()
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [onCollapse])

  const send = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    const r = await submitInstruction(text, 'island')
    setSending(false)
    if (r) setText('')
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (text) setText('')
      else onCollapse()
    }
  }

  const recent = useMemo(() => interactions.slice(0, 4), [interactions])
  const allTools = useStore((s) => s.tools)
  const liveTools = useMemo(() => allTools.filter((t) => t.status === 'running').slice(0, 2), [allTools])

  return (
    <div className="di-expanded">
      <div className="di-row head">
        <ZMark size={26} />
        <div className="di-text">
          <div className="di-title lg">{companion.state === 'idle' ? 'How can I help?' : companion.headline}</div>
          <div className="di-sub">{companion.detail ?? `Type, tap the mic, or say “${voice?.wakePhrase ?? 'Hey Zvyra'}”.`}</div>
        </div>
        <button type="button" className="di-icon no-drag" onClick={onCollapse} aria-label="Collapse" title="Collapse (Esc)">
          <ChevronDown />
        </button>
      </div>

      <div className="di-chips no-drag">
        <button type="button" className={`di-chip ${wakeOn ? 'on' : ''}`} onClick={() => void setWakeWord(!wakeOn)} aria-pressed={wakeOn}>
          {wakeOn ? <Mic /> : <MicOff />} “{voice?.wakePhrase ?? 'Hey Zvyra'}” {wakeOn ? 'on' : 'off'}
        </button>
        <button type="button" className="di-chip" onClick={() => goTo('home')}>
          <ExternalLink /> Open ZVYRA
        </button>
      </div>

      {needsKey && (
        <button type="button" className="di-notice no-drag" onClick={() => goTo('settings/voice')}>
          {voice?.stt.setupRequired ?? 'Voice needs setup'} <b>Set up</b>
        </button>
      )}

      <div className="di-scroll no-drag">
        {recent.map((i) => (
          <div key={i.id} className="di-exchange">
            <div className="di-you selectable">{i.input}</div>
            {(i.response || i.error || i.status === 'pending') && (
              <div className={`di-ans selectable ${i.status === 'error' ? 'error' : ''}`}>
                {i.status === 'error' ? i.error : (i.response ?? 'Thinking…')}
                {(i.status === 'pending' || i.status === 'streaming') && <span className="di-caret" />}
              </div>
            )}
          </div>
        ))}
        {current && <CurrentTask taskId={current.id} />}
        <ToolStack items={liveTools} />
        {!recent.length && !current && <div className="di-empty">Try “Make me a calculator”, “Create a simple game” or “Run this project”.</div>}
      </div>

      <div className="di-composer no-drag">
        <textarea ref={inputRef} rows={1} value={text} placeholder="Ask ZVYRA to do anything…" onChange={(e) => setText(e.target.value)} onKeyDown={onKey} aria-label="Instruction" />
        <button type="button" className="di-icon" onClick={() => void toggleListening('island')} aria-label="Talk" title="Talk">
          <Mic />
        </button>
        <button type="button" className="di-send" disabled={!text.trim() || sending} onClick={() => void send()} aria-label="Send">
          <Send />
        </button>
      </div>
    </div>
  )
}

function CurrentTask({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks[taskId])
  if (!task) return null
  const live = ['queued', 'planning', 'running', 'paused', 'waiting_permission', 'verifying'].includes(task.status)
  return (
    <div className="di-task">
      <div className="di-task-head">
        <button type="button" className="di-task-title" onClick={() => goTo(`tasks/${task.id}`)}>
          {task.title}
        </button>
        <TaskStatusBadge status={task.status} />
      </div>
      {task.currentAction && <div className="di-sub">{task.currentAction}</div>}
      <TaskProgress task={task} showLabel={false} />
      <PlanSteps steps={task.plan} max={3} />
      {live && (
        <button type="button" className="di-chip danger" onClick={() => void attempt(() => call('tasks.cancel', { id: task.id }), { success: 'Stopping' })}>
          <Square /> Stop
        </button>
      )}
    </div>
  )
}
