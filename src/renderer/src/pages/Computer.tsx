/** Computer Control — observe the screen, see actions, approve and stop. */
import { AppWindow, Camera, Check, History, Keyboard, Monitor, MousePointer2, Play, RefreshCw, ShieldCheck, Square, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActiveWindowInfo, ComputerAction, ComputerPhase, ScreenCapture } from '@shared/contract'
import { CapabilityNotice } from '../components/CapabilityNotice'
import { PermissionCard } from '../components/PermissionCard'
import { Badge, Button, Card, EmptyState, IconButton, KeyValue, Toggle } from '../components/ui'
import { call } from '../lib/client'
import { humanize, timeAgo } from '../lib/format'
import { useNow } from '../lib/hooks'
import { navigate, setState, useStore } from '../lib/store'
import { attempt, useAction } from '../lib/useAction'

const PHASES: { id: ComputerPhase; label: string; tone?: string }[] = [
  { id: 'observing', label: 'Observing' },
  { id: 'planning', label: 'Planning' },
  { id: 'executing', label: 'Executing' },
  { id: 'waiting_approval', label: 'Waiting for approval', tone: 'warn' },
  { id: 'verifying', label: 'Verifying' },
  { id: 'completed', label: 'Completed', tone: 'good' },
  { id: 'failed', label: 'Failed', tone: 'bad' }
]

const ACTION_ICON: Record<ComputerAction['kind'], typeof Monitor> = {
  screenshot: Camera,
  observe: Monitor,
  mouse_move: MousePointer2,
  click: MousePointer2,
  scroll: MousePointer2,
  type: Keyboard,
  hotkey: Keyboard,
  open_app: AppWindow,
  focus_window: AppWindow
}

export function Computer() {
  const status = useStore((s) => s.computer)
  const actions = useStore((s) => s.computerActions)
  const allPermissions = useStore((s) => s.permissions)
  const permissions = useMemo(() => allPermissions.filter((p) => p.category === 'computer_input' || p.category === 'screen_capture'), [allPermissions])
  const [capture, setCapture] = useState<ScreenCapture | null>(null)
  const [activeWin, setActiveWin] = useState<ActiveWindowInfo | null>(null)
  const [windows, setWindows] = useState<ActiveWindowInfo[] | null>(null)
  const [instruction, setInstruction] = useState('')
  const [run, pending] = useAction()
  const [capturing, setCapturing] = useState(false)
  const now = useNow(30_000)

  const refreshStatus = useCallback(async () => {
    const s = await attempt(() => call('computer.status'))
    if (s) setState({ computer: s })
  }, [])

  useEffect(() => {
    void refreshStatus()
    call('computer.history', { limit: 100 })
      .then((h) => setState((s) => ({ computerActions: mergeActions(s.computerActions, h) })))
      .catch(() => undefined)
  }, [refreshStatus])

  // Live active-window info while this page is open (only if the adapter supports it).
  useEffect(() => {
    if (!status?.capabilities.windowInfo) return
    let alive = true
    const tick = () =>
      call('computer.activeWindow')
        .then((w) => alive && setActiveWin(w))
        .catch(() => undefined)
    void tick()
    const t = setInterval(tick, 2500)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [status?.capabilities.windowInfo])

  const doCapture = async () => {
    setCapturing(true)
    const c = await attempt(() => call('computer.capture'), { errorTitle: 'Screen capture failed' })
    setCapturing(false)
    if (c) setCapture(c)
  }

  const startTask = async () => {
    const t = await run(() => call('tasks.create', { instruction: `Computer task: ${instruction.trim()}`, source: 'home' }), { success: 'Computer task started' })
    if (t) {
      setInstruction('')
      navigate(`tasks/${t.id}`)
    }
  }

  const active = status && !['idle', 'completed', 'failed'].includes(status.phase)
  const caps = status?.capabilities

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Computer Control</h1>
          <p>ZVYRA can observe your screen and use mouse and keyboard — only when enabled, and with your approval for input.</p>
        </div>
        <div className="page-actions">
          <div className="row" style={{ gap: 8 }}>
            <span className="muted" style={{ fontSize: 13 }}>
              {status?.enabled ? 'Enabled' : 'Disabled'}
            </span>
            <Toggle
              checked={!!status?.enabled}
              disabled={!status?.available}
              label="Enable computer control"
              onChange={(v) =>
                void run(() => call('computer.setEnabled', { enabled: v }), { success: v ? 'Computer control enabled' : 'Computer control disabled' }).then(
                  (s) => s && setState({ computer: s })
                )
              }
            />
          </div>
          <Button
            variant="danger"
            icon={Square}
            onClick={() => void run(() => call('computer.stop'), { success: 'Computer control stopped' }).then((s) => s && setState({ computer: s }))}
          >
            Stop now
          </Button>
        </div>
      </header>

      <CapabilityNotice cap="computerControl" what="Computer control" />

      {permissions.map((p) => (
        <div key={p.id} style={{ marginBottom: 12 }}>
          <PermissionCard request={p} />
        </div>
      ))}

      <div className="detail-grid">
        <div className="stack">
          <Card
            title="Screen"
            icon={Monitor}
            actions={
              <Button size="sm" icon={Camera} loading={capturing} disabled={!caps?.screenCapture} onClick={() => void doCapture()}>
                Capture screen
              </Button>
            }
          >
            <div className="screen-frame">
              {capture ? (
                <img src={capture.dataUrl} alt={`Screen capture from ${new Date(capture.ts).toLocaleTimeString()}`} />
              ) : (
                <EmptyState icon={Monitor} title="No capture yet">
                  {caps?.screenCapture ? 'Capture the screen to see exactly what ZVYRA sees.' : 'Screen capture isn’t available from the current adapter.'}
                </EmptyState>
              )}
            </div>
            {capture && (
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                {capture.width}×{capture.height} · captured {timeAgo(capture.ts, now)}
              </div>
            )}
          </Card>

          <Card title="Give ZVYRA a computer task" icon={Play}>
            <div className="row">
              <input
                className="input"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && instruction.trim() && void startTask()}
                placeholder="e.g. Open Notepad and type today’s date"
                aria-label="Computer task"
              />
              <Button variant="primary" icon={Play} disabled={!instruction.trim() || pending} onClick={() => void startTask()}>
                Start
              </Button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Mouse and keyboard actions ask for approval according to your permission settings.{' '}
              <button type="button" className="link-btn" onClick={() => navigate('settings/permissions')}>
                Review permissions
              </button>
            </div>
          </Card>

          <Card title="Action history" icon={History} actions={<span className="muted" style={{ fontSize: 12 }}>{actions.length} actions</span>}>
            {actions.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>No computer actions have been performed.</div>
            ) : (
              <div className="list">
                {actions.slice(0, 60).map((a) => {
                  const Icon = ACTION_ICON[a.kind] ?? Monitor
                  return (
                    <div key={a.id} className="list-item">
                      <span className={`li-icon ${a.status === 'failed' || a.status === 'denied' ? 'danger' : a.status === 'executed' ? 'success' : 'warning'}`}>
                        <Icon />
                      </span>
                      <span className="li-body">
                        <div className="li-title">{a.description}</div>
                        <div className="li-sub">
                          {humanize(a.kind)} · {humanize(a.status)}
                          {a.error ? ` · ${a.error}` : ''}
                        </div>
                      </span>
                      <span className="li-meta">{timeAgo(a.ts, now)}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Status" actions={<IconButton icon={RefreshCw} label="Refresh status" size="sm" onClick={() => void refreshStatus()} />}>
            {status ? (
              <div className="stack" style={{ gap: 12 }}>
                <div className="row">
                  <Badge tone={active ? 'info' : status.enabled ? 'success' : 'neutral'}>{active ? 'Active' : status.enabled ? 'Ready' : 'Off'}</Badge>
                  {!status.available && <Badge tone="warning">Unavailable</Badge>}
                </div>
                <div className="phase-strip" aria-label="Current phase">
                  {PHASES.map((p) => (
                    <span key={p.id} className={`phase ${status.phase === p.id ? `on ${p.tone ?? ''}` : ''}`}>
                      {p.label}
                    </span>
                  ))}
                </div>
                <KeyValue
                  items={[
                    { label: 'Adapter', value: status.adapter },
                    { label: 'Stop shortcut', value: status.stopShortcut ? <span className="kbd">{status.stopShortcut}</span> : '—' },
                    {
                      label: 'Active task',
                      value: status.activeTaskId ? (
                        <button type="button" className="link-btn" onClick={() => navigate(`tasks/${status.activeTaskId}`)}>
                          Open
                        </button>
                      ) : (
                        'None'
                      )
                    }
                  ]}
                />
                {status.error && <div className="notice warning">{status.error}</div>}
              </div>
            ) : (
              <div className="muted">Status unavailable.</div>
            )}
          </Card>

          <Card title="Capabilities" icon={ShieldCheck}>
            <div className="list">
              {(
                [
                  ['screenCapture', 'Screen observation'],
                  ['mouse', 'Mouse'],
                  ['keyboard', 'Keyboard'],
                  ['windowInfo', 'Window information'],
                  ['appLaunch', 'Launch apps']
                ] as const
              ).map(([k, label]) => (
                <div key={k} className="list-item" style={{ padding: '6px 4px' }}>
                  <span className={`li-icon ${caps?.[k] ? 'success' : ''}`} style={{ width: 26, height: 26 }}>
                    {caps?.[k] ? <Check /> : <X />}
                  </span>
                  <span className="li-body">
                    <div className="li-title">{label}</div>
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card
            title="Active window"
            icon={AppWindow}
            actions={
              <Button
                size="sm"
                variant="ghost"
                disabled={!caps?.windowInfo}
                onClick={() => void attempt(() => call('computer.windows')).then((w) => w && setWindows(w))}
              >
                List windows
              </Button>
            }
          >
            {activeWin ? (
              <KeyValue
                items={[
                  { label: 'Title', value: activeWin.title || '—' },
                  { label: 'Process', value: activeWin.processName }
                ]}
              />
            ) : (
              <div className="muted" style={{ fontSize: 13 }}>{caps?.windowInfo ? 'Waiting for window info…' : 'Not available from this adapter.'}</div>
            )}
            {windows && (
              <div className="list" style={{ marginTop: 10, maxHeight: 220, overflow: 'auto' }}>
                {windows.map((w, i) => (
                  <div key={`${w.pid}-${i}`} className="list-item" style={{ padding: '6px 4px' }}>
                    <span className="li-body">
                      <div className="li-title">{w.title || '(untitled)'}</div>
                      <div className="li-sub">{w.processName}</div>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

function mergeActions(live: ComputerAction[], history: ComputerAction[]) {
  const ids = new Set(live.map((a) => a.id))
  return [...live, ...history.filter((a) => !ids.has(a.id))].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 300)
}
