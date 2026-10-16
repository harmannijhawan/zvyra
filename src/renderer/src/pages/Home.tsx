/** Home — companion, voice + text command, current work and recent activity. */
import {
  AppWindow,
  BellRing,
  CalendarDays,
  ChevronRight,
  FileText,
  LayoutGrid,
  MoreHorizontal,
  Search,
  Sparkles,
  Sun,
  Target
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LaunchableApp } from '@shared/contract'
import { Composer } from '../components/Composer'
import { PermissionCard } from '../components/PermissionCard'
import { Pet } from '../components/Pet'
import { Card, Dot } from '../components/ui'
import { HelixWave } from '../components/HelixWave'
import { ActivityIconFor } from './Activity'
import { call } from '../lib/client'
import { clock, greeting, longDate, timeAgo } from '../lib/format'
import { submitInstruction, useActiveTasks, useCompanion, useNow } from '../lib/hooks'
import { getState, navigate, setState, useStore } from '../lib/store'
import { attempt } from '../lib/useAction'

const STAGE_COPY: Record<string, { title: string; body: string }> = {
  idle: { title: 'I’m here.', body: 'Tell me what you need, and I’ll take care of it.' },
  listening: { title: 'I’m listening.', body: 'Go ahead — I’ll stop when you pause.' },
  thinking: { title: 'Thinking it through.', body: 'Working out the best way to help.' },
  planning: { title: 'Making a plan.', body: 'Breaking the work into steps.' },
  speaking: { title: 'Here’s what I found.', body: 'Speaking my reply.' },
  executing: { title: 'On it.', body: 'Working in the background — you can keep going.' },
  waiting_permission: { title: 'I need your OK.', body: 'Review the request below before I continue.' },
  completed: { title: 'Done.', body: 'The task finished. Details are in Tasks.' },
  error: { title: 'Something needs attention.', body: 'Open the task or settings to see what happened.' },
  offline: { title: 'I’m offline.', body: 'Connect an AI provider in Settings so I can think and act.' },
  dnd: { title: 'Deep work mode.', body: 'Notifications are paused. I’m still here if you need me.' }
}

export function Home() {
  const now = useNow(15_000)
  const name = useStore((s) => s.settings?.profile.name)
  const voice = useStore((s) => s.voice)
  const level = useStore((s) => s.voiceLevel)
  const transcript = useStore((s) => s.liveTranscript)
  const permissions = useStore((s) => s.permissions)
  const interactions = useStore((s) => s.interactions)
  const policy = useStore((s) => s.notificationPolicy)
  const companion = useCompanion()
  const [text, setText] = useState('')
  const [model, setModel] = useState<string | undefined>()
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const listening = voice?.state === 'listening' || voice?.state === 'wake_detected'
  const standby = voice?.state === 'standby'
  const copy =
    companion.state === 'idle' && standby
      ? { title: 'I’m listening.', body: `Say “${voice?.wakePhrase ?? 'Hey Zvyra'}” or tell me what you need.` }
      : STAGE_COPY[companion.state]
  const latest = interactions.find((i) => i.source === 'home' || i.source === 'voice')
  const date = new Date(now)

  const prefill = (t: string) => {
    setText(t)
    requestAnimationFrame(() => {
      const el = inputRef.current
      el?.focus()
      el?.setSelectionRange(t.length, t.length)
    })
  }

  const send = async () => {
    setSending(true)
    const r = await submitInstruction(text, 'home', model)
    setSending(false)
    if (r) setText('')
  }

  /** Quick actions that go straight to the AI. */
  const ask = async (prompt: string) => {
    if (sending) return
    setSending(true)
    await submitInstruction(prompt, 'home', model)
    setSending(false)
  }

  const planMyDay = () => {
    const work = Object.values(getState().tasks)
      .filter((t) => ['queued', 'planning', 'running', 'paused', 'waiting_permission'].includes(t.status))
      .map((t) => `- ${t.title}`)
    const scheduled = Object.values(getState().automations)
      .filter((a) => a.enabled && a.nextRunAt && new Date(a.nextRunAt).toDateString() === new Date().toDateString())
      .map((a) => `- ${a.name} at ${clock(new Date(a.nextRunAt!))}`)
    void ask(
      `Plan my day. It is ${new Date().toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' })}.` +
        (work.length ? `\nWork in progress:\n${work.join('\n')}` : '') +
        (scheduled.length ? `\nScheduled today:\n${scheduled.join('\n')}` : '') +
        '\nSuggest a realistic, prioritised schedule with focus blocks and breaks.'
    )
  }

  const summarizeClipboard = async () => {
    let clip = ''
    try {
      clip = (await navigator.clipboard.readText()).trim()
    } catch {
      clip = ''
    }
    if (!clip) return prefill('Summarize ')
    void ask(`Summarize this concisely, then list key points and any action items:\n\n${clip.slice(0, 12000)}`)
  }

  const deepWork = !!policy?.doNotDisturb
  const toggleDeepWork = async () => {
    const next = await attempt(() => call('notifications.setPolicy', { doNotDisturb: !deepWork }), {
      success: !deepWork ? 'Deep work mode on — notifications paused' : 'Deep work mode off'
    })
    if (next) setState({ notificationPolicy: next })
  }

  return (
    <div className="page">
      <div className="home">
        <div className="home-center">
          <header className="home-head">
            <div className="home-greet">
              <h1>
                {greeting(date)}
                {name ? `, ${name}` : ''}.
              </h1>
              <p>What shall we accomplish today?</p>
            </div>
            <div className="home-clock" aria-label="Current date and time">
              <div className="date">{longDate(date)}</div>
              <div className="time">{clock(date)}</div>
            </div>
          </header>

          <section className="stage" aria-live="polite">
            <Pet state={companion.state} size={150} level={level} className="stage-pet" />
            <h2>{copy.title}</h2>
            <p>{companion.state === 'executing' || companion.state === 'waiting_permission' ? companion.detail ?? copy.body : copy.body}</p>
            <div className="stage-wave">
              <HelixWave level={voice?.state === 'speaking' ? Math.max(level, 0.25) : level} active={listening || voice?.state === 'speaking' || voice?.state === 'transcribing'} width={360} height={40} tone={voice?.state === 'speaking' ? 'speak' : voice?.state === 'transcribing' ? 'think' : 'listen'} />
            </div>
            {listening && transcript && <div className="stage-transcript">“{transcript}”</div>}
            {!listening && latest?.response && (latest.status === 'streaming' || Date.now() - Date.parse(latest.updatedAt) < 120_000) && (
              <div className="stage-transcript">{latest.response.length > 280 ? latest.response.slice(0, 277) + '…' : latest.response}</div>
            )}
            <div className="quick-actions">
              <button type="button" className="quick" disabled={sending} onClick={planMyDay}>
                <CalendarDays /> Plan my day
              </button>
              <button type="button" className="quick" onClick={() => navigate('projects')}>
                <FileText /> Work on a project
              </button>
              <button type="button" className="quick" onClick={() => navigate('apps')}>
                <LayoutGrid /> Use an app
              </button>
              <button type="button" className="quick" onClick={() => prefill('Find ')}>
                <Search /> Find something
              </button>
              <button type="button" className="quick" onClick={() => prefill('Help me with ')}>
                <Sparkles /> Help me with…
              </button>
            </div>
          </section>

          {permissions.slice(0, 2).map((p) => (
            <PermissionCard key={p.id} request={p} />
          ))}

          <Composer
            ref={inputRef}
            value={text}
            onChange={setText}
            onSubmit={() => void send()}
            busy={sending}
            source="home"
            model={model}
            onModel={setModel}
          />
          <div className="chips">
            <button type="button" className="quick" onClick={() => void toggleDeepWork()} aria-pressed={deepWork}>
              <Target /> Deep work mode{deepWork ? ': on' : ''}
            </button>
            <button type="button" className="quick" disabled={sending} onClick={() => void ask('Check my calendar and tell me what’s coming up next today.')}>
              <CalendarDays /> Check my calendar
            </button>
            <button type="button" className="quick" disabled={sending} onClick={() => void summarizeClipboard()} title="Summarizes the text on your clipboard">
              <FileText /> Summarize this
            </button>
            <button type="button" className="quick" onClick={() => prefill('Create a document about ')}>
              <Sun /> Create a document
            </button>
            <button type="button" className="quick" onClick={() => navigate('apps')}>
              <MoreHorizontal /> More
            </button>
          </div>
        </div>

        <aside className="rail">
          <StatusCard />
          <FocusCard />
          <NotificationsCard />
          <ActivityCard now={now} />
          <QuickLaunchCard />
          <div className="tagline">A MORE CAPABLE YOU</div>
        </aside>
      </div>
    </div>
  )
}

function StatusCard() {
  const companion = useCompanion()
  const mock = useStore((s) => s.backendMode?.mode === 'mock')
  const swarm = useStore((s) => s.swarm?.status)
  const runtime = useStore((s) => s.runtime)
  const phase =
    companion.state === 'thinking' || companion.state === 'listening'
      ? 'thinking'
      : companion.state === 'planning'
        ? 'planning'
        : companion.state === 'executing' || companion.state === 'waiting_permission'
          ? 'doing'
          : null
  const online = swarm === 'connected'
  const tone = mock ? 'warning' : online ? 'success' : 'danger'
  const title = mock ? 'ZVYRA preview' : online ? 'ZVYRA is active' : 'ZVYRA is offline'
  return (
    <button type="button" className="card status-card" onClick={() => navigate(online || mock ? 'agents' : 'settings/ai')}>
      <Dot tone={tone} pulse={!!phase} />
      <div>
        <div className="status-title">{title}</div>
        <div className="status-sub">
          {(['thinking', 'planning', 'doing'] as const).map((p, i) => (
            <span key={p}>
              {i > 0 && ' · '}
              {phase === p ? <b>{p[0].toUpperCase() + p.slice(1)}</b> : p[0].toUpperCase() + p.slice(1)}
            </span>
          ))}
          {runtime && runtime.runningTasks > 0 && ` · ${runtime.runningTasks} running`}
        </div>
      </div>
      <ChevronRight />
    </button>
  )
}

function FocusCard() {
  const active = useActiveTasks()
  const tasks = useStore((s) => s.tasks)
  const automations = useStore((s) => s.automations)
  const items = useMemo(() => {
    const today = new Date().toDateString()
    const doneToday = Object.values(tasks)
      .filter((t) => t.status === 'completed' && t.finishedAt && new Date(t.finishedAt).toDateString() === today)
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
    const upcoming = Object.values(automations)
      .filter((a) => a.enabled && a.nextRunAt && new Date(a.nextRunAt).toDateString() === today)
      .sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))
    return [
      ...active.map((t) => ({
        key: t.id,
        title: t.title,
        sub: t.status === 'waiting_permission' ? 'Needs your approval' : t.currentAction ?? (t.status === 'queued' ? 'Queued' : 'Working now…'),
        ring: t.status === 'waiting_permission' || t.status === 'paused' ? 'warn' : 'live',
        time: t.startedAt ? clock(new Date(t.startedAt)) : '',
        go: `tasks/${t.id}`
      })),
      ...upcoming.map((a) => ({ key: a.id, title: a.name, sub: 'Scheduled automation', ring: '', time: clock(new Date(a.nextRunAt!)), go: 'automations' })),
      ...doneToday.slice(0, 3).map((t) => ({ key: t.id, title: t.title, sub: 'Completed', ring: 'done', time: clock(new Date(t.finishedAt!)), go: `tasks/${t.id}` }))
    ].slice(0, 6)
  }, [active, tasks, automations])
  return (
    <Card
      title="Today’s Focus"
      actions={
        <button type="button" className="link-btn" onClick={() => navigate('tasks')}>
          View all <ChevronRight />
        </button>
      }
    >
      {items.length === 0 ? (
        <div className="muted" style={{ fontSize: 13, padding: '4px 0 2px' }}>
          Nothing running. Ask ZVYRA for something and it will show up here.
        </div>
      ) : (
        items.map((i) => (
          <button key={i.key} type="button" className="focus-item" onClick={() => navigate(i.go)}>
            <span className={`focus-ring ${i.ring}`} />
            <span className="focus-body">
              <div className="focus-title">{i.title}</div>
              <div className="focus-sub">{i.sub}</div>
            </span>
            <span className="focus-time">{i.time}</span>
          </button>
        ))
      )}
    </Card>
  )
}

function NotificationsCard() {
  const notes = useStore((s) => s.notifications)
  const important = notes.filter((n) => !n.read && (n.priority === 'high' || n.priority === 'critical')).slice(0, 3)
  if (!important.length) return null
  return (
    <Card title="Important" icon={BellRing}>
      <div className="list">
        {important.map((n) => (
          <button
            key={n.id}
            type="button"
            className="list-item"
            onClick={() => {
              void call('notifications.markRead', { id: n.id }).catch(() => undefined)
              setState((s) => ({ notifications: s.notifications.map((x) => (x.id === n.id ? { ...x, read: true } : x)) }))
              if (n.taskId) navigate(`tasks/${n.taskId}`)
            }}
          >
            <span className={`li-icon ${n.priority === 'critical' ? 'danger' : 'warning'}`}>
              <BellRing />
            </span>
            <span className="li-body">
              <div className="li-title">{n.title}</div>
              <div className="li-sub">{n.body}</div>
            </span>
          </button>
        ))}
      </div>
    </Card>
  )
}

function ActivityCard({ now }: { now: number }) {
  const activity = useStore((s) => s.activity)
  const tasks = useStore((s) => s.tasks)
  return (
    <Card
      title="Recent Activity"
      actions={
        <button type="button" className="link-btn" onClick={() => navigate('activity')}>
          View all <ChevronRight />
        </button>
      }
    >
      {activity.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>
          No activity yet.
        </div>
      ) : (
        <div className="list">
          {activity.slice(0, 5).map((a) => {
            const Icon = ActivityIconFor(a.type)
            return (
              <button key={a.id} type="button" className="list-item" onClick={() => navigate(a.taskId && tasks[a.taskId] ? `tasks/${a.taskId}` : 'activity')}>
                <span className={`li-icon ${a.level === 'error' ? 'danger' : a.level === 'warning' ? 'warning' : a.level === 'success' ? 'success' : ''}`}>
                  <Icon />
                </span>
                <span className="li-body">
                  <div className="li-title">{a.title}</div>
                  {a.detail && <div className="li-sub">{a.detail}</div>}
                </span>
                <span className="li-meta">{timeAgo(a.ts, now)}</span>
              </button>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function QuickLaunchCard() {
  const appsCap = useStore((s) => s.system?.capabilities.apps)
  const [apps, setApps] = useState<LaunchableApp[] | null>(null)
  useEffect(() => {
    if (!appsCap) return
    call('apps.launchable')
      .then((list) => setApps(list.filter((a) => a.pinned).slice(0, 6)))
      .catch(() => setApps([]))
  }, [appsCap])
  if (!appsCap) return null
  return (
    <Card
      title="Quick launch"
      actions={
        <button type="button" className="link-btn" onClick={() => navigate('apps')}>
          Manage <ChevronRight />
        </button>
      }
    >
      {!apps?.length ? (
        <div className="muted" style={{ fontSize: 13 }}>
          Pin apps in Apps to launch them from here.
        </div>
      ) : (
        <div className="list">
          {apps.map((a) => (
            <button key={a.id} type="button" className="list-item" onClick={() => void attempt(() => call('apps.launch', { id: a.id }), { success: `Opening ${a.name}` })}>
              <span className="li-icon">{a.iconDataUrl ? <img src={a.iconDataUrl} alt="" width={18} height={18} /> : <AppWindow />}</span>
              <span className="li-body">
                <div className="li-title">{a.name}</div>
              </span>
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}
