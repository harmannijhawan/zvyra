/** Apps — unified launcher for ZVYRA modules, integrations and your own apps. */
import {
  AppWindow,
  ArrowLeft,
  BookOpen,
  CalendarClock,
  CheckSquare,
  Code2,
  Database,
  FolderOpen,
  Globe,
  Monitor,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings as SettingsIcon,
  SquareTerminal,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Capability, Integration, IntegrationStatus, LaunchableApp } from '@shared/contract'
import { Badge, Button, Card, EmptyState, IconButton } from '../components/ui'
import { call, errorMessage } from '../lib/client'
import { humanize } from '../lib/format'
import { navigate, useStore } from '../lib/store'
import { attempt } from '../lib/useAction'
import type { Tone } from '../lib/format'
import { BrowserModule } from './modules/Browser'
import { CodeStudio } from './modules/CodeStudio'
import { FilesModule } from './modules/Files'
import { ResearchModule } from './modules/Research'
import { TerminalModule } from './modules/Terminal'

interface ModuleDef {
  id: string
  name: string
  desc: string
  icon: LucideIcon
  route: string
  cap?: Capability
}

const MODULES: ModuleDef[] = [
  { id: 'code', name: 'Code Studio', desc: 'Browse and edit project files, open your editor, hand work to the Code agent.', icon: Code2, route: 'apps/code', cap: 'files' },
  { id: 'browser', name: 'Browser', desc: 'Open pages in your browser and let the Browser agent work with them.', icon: Globe, route: 'apps/browser', cap: 'browser' },
  { id: 'terminal', name: 'Terminal', desc: 'Run approved commands in a project folder and watch their output.', icon: SquareTerminal, route: 'apps/terminal', cap: 'terminal' },
  { id: 'files', name: 'Files', desc: 'Browse folders you’ve authorised ZVYRA to use.', icon: FolderOpen, route: 'apps/files', cap: 'files' },
  { id: 'research', name: 'Research', desc: 'Ask a question; the Research agent reads sources and reports back.', icon: Search, route: 'apps/research', cap: 'tasks' },
  { id: 'automations', name: 'Automations', desc: 'Scheduled and recurring work.', icon: CalendarClock, route: 'automations', cap: 'automations' },
  { id: 'knowledge', name: 'Knowledge', desc: 'Notes and project facts ZVYRA can use.', icon: BookOpen, route: 'knowledge', cap: 'memory' },
  { id: 'memory', name: 'Memory', desc: 'Everything ZVYRA remembers about you — editable.', icon: Database, route: 'memory', cap: 'memory' },
  { id: 'tasks', name: 'Tasks', desc: 'Mission Control for running and past work.', icon: CheckSquare, route: 'tasks', cap: 'tasks' },
  { id: 'computer', name: 'Computer Control', desc: 'Screen observation, mouse and keyboard with approval.', icon: Monitor, route: 'computer', cap: 'computerControl' },
  { id: 'settings', name: 'Settings', desc: 'Voice, AI models, permissions and more.', icon: SettingsIcon, route: 'settings' }
]

const NO_CAPS: Partial<Record<Capability, boolean>> = {}

const STATUS_TONE: Record<IntegrationStatus, Tone> = {
  connected: 'success',
  available: 'info',
  not_installed: 'neutral',
  needs_setup: 'warning',
  error: 'danger',
  unsupported: 'neutral'
}

export function Apps({ module }: { module?: string }) {
  if (module) {
    const def = MODULES.find((m) => m.id === module)
    const body =
      module === 'code' ? <CodeStudio /> : module === 'browser' ? <BrowserModule /> : module === 'terminal' ? <TerminalModule /> : module === 'files' ? <FilesModule /> : module === 'research' ? <ResearchModule /> : null
    return (
      <div className="page">
        <header className="page-head">
          <div className="row" style={{ alignItems: 'center' }}>
            <IconButton icon={ArrowLeft} label="Back to Apps" onClick={() => navigate('apps')} />
            <div>
              <h1>{def?.name ?? 'App'}</h1>
              {def && <p>{def.desc}</p>}
            </div>
          </div>
        </header>
        {body ?? <EmptyState icon={AppWindow} title="Unknown module" />}
      </div>
    )
  }
  return <Launcher />
}

function Launcher() {
  const caps = useStore((s) => s.system?.capabilities) ?? NO_CAPS
  const [integrations, setIntegrations] = useState<Integration[] | null>(null)
  const [intError, setIntError] = useState<string | null>(null)
  const [apps, setApps] = useState<LaunchableApp[] | null>(null)
  const [appsError, setAppsError] = useState<string | null>(null)

  const loadApps = () =>
    call('apps.launchable')
      .then((a) => {
        setApps(a)
        setAppsError(null)
      })
      .catch((e) => {
        setApps([])
        setAppsError(errorMessage(e))
      })

  useEffect(() => {
    call('apps.integrations')
      .then(setIntegrations)
      .catch((e) => {
        setIntegrations([])
        setIntError(errorMessage(e))
      })
    void loadApps()
  }, [])

  const add = async () => {
    const a = await attempt(() => call('apps.add'))
    if (a) setApps((l) => [...(l ?? []), a])
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Apps</h1>
          <p>ZVYRA’s workspaces and the apps it can work with.</p>
        </div>
      </header>

      <div className="tiles">
        {MODULES.map((m) => {
          const ok = !m.cap || caps[m.cap]
          return (
            <button key={m.id} type="button" className="tile" onClick={() => navigate(m.route)}>
              <span className="tile-icon">
                <m.icon />
              </span>
              <span className="tile-title">{m.name}</span>
              <span className="tile-desc">{m.desc}</span>
              <span className="tile-foot">{ok ? <Badge tone="success">Ready</Badge> : <Badge tone="warning">Backend not ready</Badge>}</span>
            </button>
          )
        })}
      </div>

      <div className="grid-2" style={{ marginTop: 22 }}>
        <Card
          title="Your apps"
          icon={AppWindow}
          actions={
            <Button size="sm" icon={Plus} onClick={() => void add()}>
              Add app
            </Button>
          }
        >
          {appsError && <div className="notice warning" style={{ marginBottom: 8 }}>{appsError}</div>}
          {apps && apps.length === 0 && !appsError && <div className="muted" style={{ fontSize: 13 }}>No apps added yet. Add an app so ZVYRA can launch it for you.</div>}
          <div className="list">
            {apps?.map((a) => (
              <div key={a.id} className="list-item clickable">
                <span className="li-icon">{a.iconDataUrl ? <img src={a.iconDataUrl} alt="" width={18} height={18} /> : <AppWindow />}</span>
                <button type="button" className="li-body" style={{ textAlign: 'left' }} onClick={() => void attempt(() => call('apps.launch', { id: a.id }), { success: `Opening ${a.name}` })}>
                  <div className="li-title">{a.name}</div>
                  {a.path && <div className="li-sub">{a.path}</div>}
                </button>
                <div className="li-actions" style={{ opacity: 1 }}>
                  <IconButton
                    icon={a.pinned ? PinOff : Pin}
                    size="sm"
                    label={a.pinned ? 'Unpin from Home' : 'Pin to Home'}
                    onClick={() =>
                      void attempt(() => call('apps.setPinned', { id: a.id, pinned: !a.pinned })).then((u) => u && setApps((l) => l?.map((x) => (x.id === u.id ? u : x)) ?? null))
                    }
                  />
                  <IconButton
                    icon={Trash2}
                    size="sm"
                    label="Remove"
                    onClick={() => void attempt(() => call('apps.remove', { id: a.id })).then(() => setApps((l) => l?.filter((x) => x.id !== a.id) ?? null))}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Integrations">
          {intError && <div className="notice warning" style={{ marginBottom: 8 }}>{intError}</div>}
          {integrations && integrations.length === 0 && !intError && <div className="muted" style={{ fontSize: 13 }}>The backend reports no integrations.</div>}
          <div className="list">
            {integrations?.map((i) => (
              <div key={i.id} className="list-item">
                <span className="li-body">
                  <div className="li-title">{i.name}</div>
                  <div className="li-sub">{i.detail ?? i.setupHint ?? humanize(i.category)}</div>
                </span>
                <Badge tone={STATUS_TONE[i.status]}>{humanize(i.status)}</Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
