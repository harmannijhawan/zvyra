/** Activity — searchable, chronological record of real service events. */
import {
  Activity as ActivityIcon,
  AppWindow,
  Bell,
  Bot,
  CheckCircle2,
  Cpu,
  Eraser,
  FileText,
  FolderKanban,
  Globe,
  Mic,
  Search,
  ShieldAlert,
  SquareTerminal,
  XCircle,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ActivityEntry } from '@shared/contract'
import { Button, ConfirmDialog, EmptyState, Spinner } from '../components/ui'
import { call, errorMessage } from '../lib/client'
import { useNow } from '../lib/hooks'
import { timeAgo } from '../lib/format'
import { navigate, setState, useStore } from '../lib/store'
import { attempt } from '../lib/useAction'

export function ActivityIconFor(type: string): LucideIcon {
  if (type.startsWith('task.completed')) return CheckCircle2
  if (type.startsWith('task.failed')) return XCircle
  if (type.startsWith('task')) return Bot
  if (type.startsWith('app')) return AppWindow
  if (type.startsWith('file')) return FileText
  if (type.startsWith('command') || type.startsWith('terminal')) return SquareTerminal
  if (type.startsWith('browser')) return Globe
  if (type.startsWith('model')) return Cpu
  if (type.startsWith('permission')) return ShieldAlert
  if (type.startsWith('voice')) return Mic
  if (type.startsWith('project')) return FolderKanban
  if (type.startsWith('notification')) return Bell
  return ActivityIcon
}

const TYPES = [
  { id: '', label: 'All' },
  { id: 'task', label: 'Tasks' },
  { id: 'app', label: 'Apps' },
  { id: 'file', label: 'Files' },
  { id: 'command', label: 'Commands' },
  { id: 'browser', label: 'Browser' },
  { id: 'model', label: 'Models' },
  { id: 'permission', label: 'Permissions' },
  { id: 'voice', label: 'Voice' }
]

export function ActivityPage() {
  const live = useStore((s) => s.activity)
  const tasks = useStore((s) => s.tasks)
  const [query, setQuery] = useState('')
  const [type, setType] = useState('')
  const [results, setResults] = useState<ActivityEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(true)
  const [confirmClear, setConfirmClear] = useState(false)
  const now = useNow(30_000)
  const filtered = !!query || !!type

  // Server-side search; live list is used when unfiltered.
  useEffect(() => {
    if (!filtered) {
      setResults(null)
      return
    }
    setLoading(true)
    const t = setTimeout(() => {
      call('activity.list', { query: query || undefined, types: type ? [type] : undefined, limit: 200 })
        .then((r) => {
          // Backends may match types exactly or by prefix; filter by prefix client-side too.
          setResults(type ? r.filter((a) => a.type.startsWith(type)) : r)
          setError(null)
        })
        .catch((e) => setError(errorMessage(e)))
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(t)
  }, [query, type, filtered])

  const items = results ?? live
  const groups = useMemo(() => {
    const out: { day: string; items: ActivityEntry[] }[] = []
    for (const a of items) {
      const day = new Date(a.ts).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
      const last = out[out.length - 1]
      if (last?.day === day) last.items.push(a)
      else out.push({ day, items: [a] })
    }
    return out
  }, [items])

  const loadMore = async () => {
    const oldest = live[live.length - 1]
    if (!oldest) return
    const older = await attempt(() => call('activity.list', { limit: 200, before: oldest.ts }))
    if (older) {
      setMore(older.length > 0)
      setState((s) => {
        const ids = new Set(s.activity.map((a) => a.id))
        return { activity: [...s.activity, ...older.filter((a) => !ids.has(a.id))] }
      })
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Activity</h1>
          <p>What ZVYRA actually did, recorded by the services that did it.</p>
        </div>
        <div className="page-actions">
          <div className="search" style={{ width: 280 }}>
            <Search />
            <input className="input" placeholder="Search activity" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search activity" />
          </div>
          <Button variant="ghost" icon={Eraser} onClick={() => setConfirmClear(true)}>
            Clear
          </Button>
        </div>
      </header>
      <div className="filters" role="group" aria-label="Filter by type">
        {TYPES.map((t) => (
          <button key={t.id} type="button" className="filter" aria-pressed={type === t.id} onClick={() => setType(t.id)}>
            {t.label}
          </button>
        ))}
        {loading && <Spinner size={14} />}
      </div>
      {error && <div className="notice danger" style={{ marginBottom: 12 }}>{error}</div>}
      {items.length === 0 ? (
        <EmptyState icon={ActivityIcon} title={filtered ? 'No matching activity' : 'No activity yet'}>
          Events appear here as ZVYRA opens apps, edits files, runs commands and finishes tasks.
        </EmptyState>
      ) : (
        <div className="stack">
          {groups.map((g) => (
            <section key={g.day}>
              <div className="section-title">
                <h2>{g.day}</h2>
              </div>
              <div className="card padded" style={{ padding: 6 }}>
                <div className="list">
                  {g.items.map((a) => {
                    const Icon = ActivityIconFor(a.type)
                    const go = a.taskId && tasks[a.taskId] ? `tasks/${a.taskId}` : a.projectId ? `projects/${a.projectId}` : null
                    return (
                      <div
                        key={a.id}
                        className={`list-item ${go ? 'clickable' : ''}`}
                        role={go ? 'button' : undefined}
                        tabIndex={go ? 0 : undefined}
                        onClick={() => go && navigate(go)}
                        onKeyDown={(e) => go && e.key === 'Enter' && navigate(go)}
                      >
                        <span className={`li-icon ${a.level === 'error' ? 'danger' : a.level === 'warning' ? 'warning' : a.level === 'success' ? 'success' : ''}`}>
                          <Icon />
                        </span>
                        <span className="li-body">
                          <div className="li-title selectable">{a.title}</div>
                          {a.detail && <div className="li-sub selectable">{a.detail}</div>}
                        </span>
                        <span className="kbd" style={{ flex: 'none' }}>
                          {a.type}
                        </span>
                        <span className="li-meta" title={new Date(a.ts).toLocaleString()}>
                          {timeAgo(a.ts, now)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </section>
          ))}
          {!filtered && more && live.length >= 50 && (
            <Button onClick={() => void loadMore()} style={{ alignSelf: 'center' }}>
              Load older activity
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmClear}
        title="Clear activity history?"
        body="All recorded activity will be permanently deleted. Tasks and conversations are not affected."
        confirmLabel="Clear activity"
        danger
        onClose={() => setConfirmClear(false)}
        onConfirm={() => void attempt(() => call('activity.clear'), { success: 'Activity cleared' }).then(() => setState({ activity: [] }))}
      />
    </div>
  )
}
