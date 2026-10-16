/**
 * ZVYRA Dynamic Island — one translucent surface that morphs between states:
 *   mini · compact · voice (listening / speaking) · tool (live research, media,
 *   builds…) · camera (webcam preview) · peek (live activity) · expanded
 * The window has a fixed transparent footprint and is click-through outside the
 * surface, so every change is a smooth CSS morph (no window resizing).
 */
import { ChevronDown, ExternalLink, Maximize2, Mic, MicOff, Minus, Send, Square, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as RMouseEvent } from 'react'
import type { IslandMode } from '@shared/shell'
import type { ToolActivity } from '@shared/contract'
import { call, onShellEvent, shellCall } from '../lib/client'
import { setWakeWord, submitInstruction, toggleListening, useActiveTasks, useCompanion } from '../lib/hooks'
import { useStore } from '../lib/store'
import { useToasts } from '../lib/toast'
import { attempt, goTo } from '../lib/useAction'
import { Pet } from '../components/Pet'
import { PermissionCard } from '../components/PermissionCard'
import { PlanSteps, TaskProgress, TaskStatusBadge } from '../components/TaskBits'
import { HelixWave } from '../components/HelixWave'
import { Toasts } from '../components/ui'
import { CameraContent, ToolStack, useFreshTools } from './IslandCards'

type Visual = 'mini' | 'compact' | 'voice' | 'peek' | 'expanded' | 'tool' | 'camera'

const setMode = (mode: IslandMode) => void attempt(() => shellCall('island.setMode', { mode }))

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

/** Click vs drag on the same surface: moves the window after 4px of travel. */
function useDrag(onClick: () => void) {
  const state = useRef<{ sx: number; sy: number; wx: number; wy: number; moved: boolean } | null>(null)
  const onMouseDown = (e: RMouseEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('button, textarea, input, a, .no-drag')) return
    state.current = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY, moved: false }
    const move = (ev: MouseEvent) => {
      const s = state.current
      if (!s) return
      const dx = ev.screenX - s.sx
      const dy = ev.screenY - s.sy
      if (!s.moved && Math.hypot(dx, dy) < 4) return
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
  return onMouseDown
}

/* ------------------------------------------------------------------ app */

export function IslandApp() {
  const island = useStore((s) => s.island)
  const reduceMotion = useStore((s) => !!s.settings?.appearance.reduceMotion)
  const voice = useStore((s) => s.voice)
  const level = useStore((s) => s.voiceLevel)
  const interactions = useStore((s) => s.interactions)
  const permissions = useStore((s) => s.permissions)
  const companion = useCompanion()
  const active = useActiveTasks()
  const toasts = useToasts()
  const mode = island?.mode ?? 'compact'
  const dirUp = island?.expandDirection === 'up'
  useClickThrough()

  useEffect(() => {
    document.body.classList.toggle('reduce-motion', reduceMotion)
  }, [reduceMotion])

  useEffect(
    () =>
      onShellEvent((e) => {
        if (e.type === 'shell.shortcut' && e.payload.action === 'toggleIsland') return
      }),
    []
  )

  const vs = voice?.state
  const inVoice = vs === 'wake_detected' || vs === 'listening' || vs === 'transcribing' || vs === 'speaking'
  const latest = interactions[0]
  const now = useTicker(1000)
  const working = !!latest && (latest.status === 'pending' || latest.status === 'streaming') && latest.source !== 'voice'
  const freshReply = !!latest && latest.status !== 'pending' && latest.source !== 'voice' && now - Date.parse(latest.updatedAt) < 9000 && (!!latest.response || !!latest.error)
  const [peekDismissed, setPeekDismissed] = useState<string | null>(null)
  const hasPeek = (working || freshReply || permissions.length > 0 || toasts.some((t) => t.tone !== 'success')) && peekDismissed !== `${latest?.id}:${latest?.status}`
  const camOpen = useStore((s) => s.camera.open)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const dismissTool = useCallback((id: string) => setDismissed((d) => new Set(d).add(id)), [])
  const fresh = useFreshTools(now, dismissed, { skipCamera: camOpen })
  const toolRunning = fresh.some((t) => t.status === 'running')

  // Camera wins (its stream must stay mounted to answer capture requests), then the
  // panel the user opened, voice, approvals, live tool cards, plain replies.
  const visual: Visual = camOpen
    ? 'camera'
    : mode === 'expanded'
      ? 'expanded'
      : inVoice
        ? 'voice'
        : permissions.length
          ? 'peek'
          : fresh.length
            ? 'tool'
            : hasPeek
              ? 'peek'
              : mode === 'mini'
                ? 'mini'
                : 'compact'
  const glow = camOpen
    ? 'cam'
    : inVoice
      ? vs === 'speaking'
        ? 'speak'
        : vs === 'transcribing'
          ? 'think'
          : 'listen'
      : toolRunning
        ? 'tool'
        : working || active.some((t) => t.status === 'running' || t.status === 'planning')
          ? 'work'
          : permissions.length
            ? 'warn'
            : companion.state === 'error'
              ? 'error'
              : 'none'

  const expand = useCallback(() => setMode('expanded'), [])
  const collapse = useCallback(() => setMode('compact'), [])

  return (
    <div className={`island-root ${dirUp ? 'dir-up' : ''}`}>
      <Surface
        visual={visual}
        glow={glow}
        level={level}
        onExpand={expand}
        onCollapse={collapse}
        dismissPeek={() => setPeekDismissed(`${latest?.id}:${latest?.status}`)}
        tools={fresh}
        onDismissTool={dismissTool}
        inVoice={inVoice}
      />
      {visual === 'expanded' && <Toasts />}
    </div>
  )
}

function useTicker(ms: number) {
  const [n, setN] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setN(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return n
}

/* ------------------------------------------------------------------ surface */

const SIZE: Record<'mini' | 'compact', { w: number; h: number; r: number }> = {
  mini: { w: 64, h: 44, r: 22 },
  compact: { w: 340, h: 54, r: 27 }
}

const WIDE: Partial<Record<Visual, { w: number; r: number; max: number }>> = {
  expanded: { w: 470, r: 30, max: 600 },
  camera: { w: 470, r: 32, max: 560 },
  voice: { w: 420, r: 28, max: 420 },
  peek: { w: 420, r: 28, max: 240 },
  tool: { w: 436, r: 28, max: 380 }
}

function Surface({
  visual,
  glow,
  level,
  onExpand,
  onCollapse,
  dismissPeek,
  tools,
  onDismissTool,
  inVoice
}: {
  visual: Visual
  glow: string
  level: number
  onExpand: () => void
  onCollapse: () => void
  dismissPeek: () => void
  tools: ToolActivity[]
  onDismissTool: (id: string) => void
  inVoice: boolean
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState(0)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setMeasured(el.offsetHeight))
    ro.observe(el)
    setMeasured(el.offsetHeight)
    return () => ro.disconnect()
  }, [visual])

  const wide = visual === 'mini' || visual === 'compact' ? null : WIDE[visual]!
  const width = wide ? wide.w : SIZE[visual as 'mini' | 'compact'].w
  const radius = wide ? wide.r : SIZE[visual as 'mini' | 'compact'].r
  const height = wide ? Math.min(wide.max, Math.max(54, measured || 54)) : SIZE[visual as 'mini' | 'compact'].h
  const onMouseDown = useDrag(visual === 'expanded' || visual === 'camera' ? () => undefined : visual === 'mini' ? () => setMode('compact') : onExpand)

  return (
    <div
      className={`di v-${visual} glow-${glow}`}
      style={{ width, height, borderRadius: radius, ['--lvl' as string]: Math.min(1, level).toFixed(3) }}
      onMouseDown={onMouseDown}
      role="region"
      aria-label="ZVYRA Dynamic Island"
    >
      <span className="di-glow" aria-hidden="true" />
      <div className="di-body" key={visual}>
        {/* Measured wrapper (auto height) drives the surface height so it morphs to fit. */}
        <div ref={bodyRef}>
          {visual === 'mini' && <MiniContent />}
          {visual === 'compact' && <CompactContent onExpand={onExpand} />}
          {visual === 'voice' && <VoiceContent tools={tools} />}
          {visual === 'camera' && <CameraContent inVoice={inVoice} />}
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

/* ------------------------------------------------------------------ contents */

function useStatusLine() {
  const companion = useCompanion()
  const booting = useStore((s) => s.boot !== 'ready')
  if (booting) return 'Starting…'
  if (companion.state === 'idle') return companion.detail ?? 'Ready'
  if ((companion.state === 'executing' || companion.state === 'waiting_permission') && companion.detail) return `${companion.headline} · ${companion.detail}`
  return companion.detail && companion.state !== 'offline' ? companion.headline : (companion.detail ?? companion.headline)
}

function MiniContent() {
  const companion = useCompanion()
  const level = useStore((s) => s.voiceLevel)
  return (
    <div className="di-row mini">
      <Pet state={companion.state} size={34} level={level} />
    </div>
  )
}

function CompactContent({ onExpand }: { onExpand: () => void }) {
  const companion = useCompanion()
  const level = useStore((s) => s.voiceLevel)
  const voice = useStore((s) => s.voice)
  const status = useStatusLine()
  const standby = voice?.state === 'standby'
  return (
    <div className="di-row">
      <Pet state={companion.state} size={36} level={level} />
      <div className="di-text">
        <div className="di-title">ZVYRA</div>
        <div className="di-sub truncate" aria-live="polite">
          {status}
        </div>
      </div>
      <button type="button" className="di-wave no-drag" onClick={() => void toggleListening('island')} title={standby ? 'Listening for “Hey Zvyra” — click to talk' : 'Talk to ZVYRA'} aria-label="Talk to ZVYRA">
        <HelixWave level={level} active={false} width={58} height={24} />
        {standby && <span className="di-live-dot" />}
      </button>
      <div className="di-hover-actions no-drag">
        <button type="button" className="di-icon" onClick={onExpand} aria-label="Expand" title="Expand">
          <Maximize2 />
        </button>
        <button type="button" className="di-icon" onClick={() => setMode('mini')} aria-label="Minimize" title="Minimize">
          <Minus />
        </button>
        <button type="button" className="di-icon" onClick={() => void attempt(() => shellCall('island.close'))} aria-label="Hide (ZVYRA keeps listening)" title="Hide — ZVYRA keeps listening for “Hey Zvyra”">
          <X />
        </button>
      </div>
    </div>
  )
}

function VoiceContent({ tools }: { tools: ToolActivity[] }) {
  const voice = useStore((s) => s.voice)
  const level = useStore((s) => s.voiceLevel)
  const transcript = useStore((s) => s.liveTranscript)
  const interactions = useStore((s) => s.interactions)
  const companion = useCompanion()
  const vs = voice?.state
  const reply = interactions[0]?.source === 'voice' ? interactions[0]?.response : undefined
  const label = vs === 'wake_detected' ? 'Connecting…' : vs === 'speaking' ? 'Speaking' : vs === 'transcribing' ? 'Thinking…' : 'Listening'
  const line = vs === 'speaking' && reply ? reply : transcript
  return (
    <div className="di-voice">
      <div className="di-row">
        <Pet state={companion.state} size={40} level={level} />
        <div className="di-text">
          <div className="di-title">{label}</div>
          <div className="di-sub">{vs === 'speaking' ? 'Talk any time to interrupt' : '“Go to sleep” to finish'}</div>
        </div>
        <button type="button" className="di-icon stop no-drag" onClick={() => void attempt(() => call('voice.stopListening'))} aria-label="End conversation" title="End conversation">
          <Square />
        </button>
      </div>
      <div className="di-wave-big">
        <HelixWave level={vs === 'speaking' ? Math.max(level, 0.25) : level} active width={380} height={50} tone={vs === 'speaking' ? 'speak' : vs === 'transcribing' ? 'think' : 'listen'} />
      </div>
      {line && <div className="di-transcript selectable">{line.length > (tools.length ? 140 : 220) ? '…' + line.slice(-(tools.length ? 140 : 220)) : line}</div>}
      {!!tools.length && (
        <div className="di-voice-tools">
          <ToolStack items={tools.slice(0, 2)} />
        </div>
      )}
    </div>
  )
}

function PeekContent({ onDismiss }: { onDismiss: () => void }) {
  const interactions = useStore((s) => s.interactions)
  const permissions = useStore((s) => s.permissions)
  const companion = useCompanion()
  const level = useStore((s) => s.voiceLevel)
  const toasts = useToasts()
  const latest = interactions[0]
  const working = latest && (latest.status === 'pending' || latest.status === 'streaming')
  const err = toasts.find((t) => t.tone !== 'success')
  return (
    <div className="di-peek">
      <div className="di-row">
        <Pet state={companion.state} size={36} level={level} />
        <div className="di-text">
          <div className="di-title">{permissions.length ? 'Needs your OK' : working ? 'Working' : latest?.status === 'error' ? 'Couldn’t finish' : 'Done'}</div>
          <div className="di-sub truncate">{latest?.input}</div>
        </div>
        {working ? <span className="di-spinner" /> : (
          <button type="button" className="di-icon no-drag" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
            <ChevronDown />
          </button>
        )}
      </div>
      {permissions[0] ? (
        <div className="no-drag" style={{ padding: '2px 4px 6px' }}>
          <PermissionCard request={permissions[0]} compact />
        </div>
      ) : (
        <div className={`di-reply ${latest?.status === 'error' ? 'error' : ''}`}>
          {err && !latest ? err.message ?? err.title : latest?.status === 'error' ? (latest.error ?? 'Something went wrong') : (latest?.response ?? 'Thinking…')}
        </div>
      )}
    </div>
  )
}

function ExpandedContent({ onCollapse }: { onCollapse: () => void }) {
  const companion = useCompanion()
  const voice = useStore((s) => s.voice)
  const level = useStore((s) => s.voiceLevel)
  const interactions = useStore((s) => s.interactions)
  const permissions = useStore((s) => s.permissions)
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
    const t = setTimeout(() => inputRef.current?.focus(), 260)
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
        <Pet state={companion.state} size={46} level={level} />
        <div className="di-text">
          <div className="di-title lg">{companion.state === 'idle' ? 'How can I help?' : companion.headline}</div>
          <div className="di-sub">{companion.detail ?? 'Type, tap the mic, or say “Hey Zvyra”.'}</div>
        </div>
        <button type="button" className="di-icon no-drag" onClick={onCollapse} aria-label="Collapse" title="Collapse (Esc)">
          <ChevronDown />
        </button>
      </div>

      <div className="di-chips no-drag">
        <button type="button" className={`di-chip ${wakeOn ? 'on' : ''}`} onClick={() => void setWakeWord(!wakeOn)} aria-pressed={wakeOn}>
          {wakeOn ? <Mic /> : <MicOff />} “Hey Zvyra” {wakeOn ? 'on' : 'off'}
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
        {permissions.slice(0, 2).map((p) => (
          <PermissionCard key={p.id} request={p} compact />
        ))}
        {recent.map((i) => (
          <div key={i.id} className="di-exchange">
            <div className="di-you selectable">{i.input}</div>
            {(i.response || i.error || i.status === 'pending') && (
              <div className={`di-ans selectable ${i.status === 'error' ? 'error' : ''}`}>
                {i.status === 'error' ? i.error : i.response ?? 'Thinking…'}
                {(i.status === 'pending' || i.status === 'streaming') && <span className="di-caret" />}
              </div>
            )}
          </div>
        ))}
        {current && <CurrentTask taskId={current.id} />}
        <ToolStack items={liveTools} />
        {!recent.length && !current && <div className="di-empty">Try “Build me an e-commerce site for sneakers”, “What’s the latest AI news?” or “Open my camera”.</div>}
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
