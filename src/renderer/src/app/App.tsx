/** Main window: sidebar navigation, title bar, preview banner and routed pages. */
import {
  Activity as ActivityIcon,
  AlertTriangle,
  Bot,
  BookOpen,
  CalendarClock,
  CheckSquare,
  Database,
  FolderKanban,
  Home as HomeIcon,
  LayoutGrid,
  MessageSquare,
  Minus,
  Monitor,
  Settings as SettingsIcon,
  Square,
  X,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useMemo, type ReactNode } from 'react'
import { BrandLockup } from '../components/brand'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { Button, Spinner, Toasts } from '../components/ui'
import { shellCall } from '../lib/client'
import { useActiveTasks } from '../lib/hooks'
import { navigate, useStore } from '../lib/store'
import { ZMark } from '../components/brand'
import { Home } from '../pages/Home'
import { Chat } from '../pages/Chat'
import { Tasks } from '../pages/Tasks'
import { Computer } from '../pages/Computer'
import { Apps } from '../pages/Apps'
import { Projects } from '../pages/Projects'
import { Agents } from '../pages/Agents'
import { ActivityPage } from '../pages/Activity'
import { Knowledge } from '../pages/Knowledge'
import { Memory } from '../pages/Memory'
import { Automations } from '../pages/Automations'
import { Settings } from '../pages/Settings'
import { Onboarding } from '../onboarding/Onboarding'

interface NavDef {
  id: string
  label: string
  icon: LucideIcon
}

const NAV: NavDef[] = [
  { id: 'home', label: 'Home', icon: HomeIcon },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare },
  { id: 'computer', label: 'Computer', icon: Monitor },
  { id: 'apps', label: 'Apps', icon: LayoutGrid },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'activity', label: 'Activity', icon: ActivityIcon },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'memory', label: 'Memory', icon: Database },
  { id: 'automations', label: 'Automations', icon: CalendarClock },
  { id: 'settings', label: 'Settings', icon: SettingsIcon }
]

export function App() {
  const boot = useStore((s) => s.boot)
  const route = useStore((s) => s.route)
  const setup = useStore((s) => s.setup)
  const reduceMotion = useStore((s) => !!s.settings?.appearance.reduceMotion)
  const uiScale = useStore((s) => s.settings?.appearance.uiScale ?? 1)

  useEffect(() => {
    document.body.classList.toggle('reduce-motion', reduceMotion)
  }, [reduceMotion])
  useEffect(() => {
    document.documentElement.style.zoom = String(uiScale)
  }, [uiScale])

  // Keyboard shortcuts inside the main window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= 9) {
        e.preventDefault()
        navigate(NAV[n - 1].id)
      } else if (e.key === ',') {
        e.preventDefault()
        navigate('settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (boot !== 'ready') return <BootScreen />
  if (setup && !setup.onboarded) return <Onboarding />

  const [section, ...rest] = route.split('/')
  const sub = rest.join('/') || undefined

  return (
    <div className="app">
      <Sidebar current={section} />
      <main className="main">
        <TitleBar />
        <PreviewBanner />
        <ErrorBoundary key={route} label={route}>
          <Page section={section} sub={sub} />
        </ErrorBoundary>
      </main>
      <Toasts />
    </div>
  )
}

function Page({ section, sub }: { section: string; sub?: string }): ReactNode {
  switch (section) {
    case 'chat':
      return <Chat conversationId={sub} />
    case 'tasks':
      return <Tasks taskId={sub} />
    case 'computer':
      return <Computer />
    case 'apps':
      return <Apps module={sub} />
    case 'projects':
      return <Projects projectId={sub} />
    case 'agents':
      return <Agents />
    case 'activity':
      return <ActivityPage />
    case 'knowledge':
      return <Knowledge />
    case 'memory':
      return <Memory />
    case 'automations':
      return <Automations />
    case 'settings':
      return <Settings section={sub} />
    default:
      return <Home />
  }
}

function BootScreen() {
  const boot = useStore((s) => s.boot)
  const err = useStore((s) => s.bootError)
  return (
    <div className="app" style={{ display: 'block' }}>
      <TitleBar />
      <div className="boot">
        <div className="boot-inner">
          <ZMark size={64} glow />
          {boot === 'error' ? (
            <>
              <div>ZVYRA couldn’t start its interface.</div>
              <div className="muted selectable">{err}</div>
              <Button onClick={() => location.reload()}>Reload</Button>
            </>
          ) : (
            <>
              <Spinner />
              <div className="muted">Starting ZVYRA…</div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Sidebar({ current }: { current: string }) {
  const permissions = useStore((s) => s.permissions)
  const active = useActiveTasks()
  const unread = useStore((s) => s.notifications.filter((n) => !n.read).length)
  const name = useStore((s) => s.settings?.profile.name) || 'You'
  const mock = useStore((s) => s.backendMode?.mode === 'mock')
  const swarm = useStore((s) => s.swarm?.status)
  const counts = useMemo<Record<string, { n: number; warn?: boolean }>>(
    () => ({
      tasks: permissions.length ? { n: permissions.length, warn: true } : { n: active.length },
      activity: { n: unread }
    }),
    [permissions.length, active.length, unread]
  )
  const status = mock ? { tone: 'warning', text: 'Preview backend' } : swarm === 'connected' ? { tone: 'success', text: 'ZVYRA Online' } : { tone: 'danger', text: 'Models offline' }
  return (
    <aside className="sidebar">
      <BrandLockup />
      <nav className="nav" aria-label="Main">
        {NAV.map((item, i) => {
          const c = counts[item.id]
          return (
            <button
              key={item.id}
              type="button"
              className="nav-item"
              aria-current={current === item.id || (current === '' && item.id === 'home') ? 'page' : undefined}
              onClick={() => navigate(item.id)}
              title={`${item.label}${i < 9 ? `  (Ctrl+${i + 1})` : ''}`}
            >
              <item.icon />
              <span className="nav-label">{item.label}</span>
              {c && c.n > 0 && <span className={`nav-count ${c.warn ? 'warn' : ''}`}>{c.n}</span>}
            </button>
          )
        })}
      </nav>
      <button type="button" className="profile-card" onClick={() => navigate('settings/profile')} title="Profile & settings">
        <span className="avatar">{name.slice(0, 1).toUpperCase()}</span>
        <span className="profile-text">
          <div className="profile-name">{name}</div>
          <div className="profile-status">
            <span className={`dot ${status.tone}`} /> {status.text}
          </div>
        </span>
      </button>
    </aside>
  )
}

function TitleBar() {
  return (
    <div className="titlebar">
      <div className="win-controls">
        <button type="button" onClick={() => void shellCall('main.minimize')} aria-label="Minimize" title="Minimize">
          <Minus />
        </button>
        <button type="button" onClick={() => void shellCall('main.toggleMaximize')} aria-label="Maximize" title="Maximize / restore">
          <Square />
        </button>
        <button type="button" className="close" onClick={() => void shellCall('main.close')} aria-label="Close" title="Close (ZVYRA keeps running in the tray)">
          <X />
        </button>
      </div>
    </div>
  )
}

function PreviewBanner() {
  const mode = useStore((s) => s.backendMode)
  const system = useStore((s) => s.system)
  if (mode?.mode !== 'mock' && system?.backend !== 'mock') return null
  return (
    <div className="banner" role="status">
      <AlertTriangle />
      <span className="grow">
        <b>Preview backend.</b> Tasks, replies and voice are simulated so you can explore the interface — nothing on your PC is changed.
        {mode?.reason ? ` (${mode.reason})` : ''}
      </span>
    </div>
  )
}
