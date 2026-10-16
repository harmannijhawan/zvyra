/** Tasks / Mission Control — real task lifecycle, plan, events and controls. */
import {
  AlertCircle,
  Bot,
  CheckSquare,
  CircleDot,
  Eraser,
  Flag,
  ListChecks,
  MessageCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
  Wrench
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Task, TaskEvent, TaskEventKind, TaskStatus } from '@shared/contract'
import { PermissionCard } from '../components/PermissionCard'
import { PlanSteps, TaskProgress, TaskStatusBadge } from '../components/TaskBits'
import { Button, Card, ConfirmDialog, EmptyState, Field, KeyValue, Modal } from '../components/ui'
import { call } from '../lib/client'
import { dateTime, duration, humanize, TASK_STATUS_LABEL, timeAgo } from '../lib/format'
import { useNow } from '../lib/hooks'
import { loadTaskEvents, navigate, sortedTasks, useStore } from '../lib/store'
import { attempt, useAction } from '../lib/useAction'
import { toast } from '../lib/toast'

type Filter = 'all' | 'active' | 'approval' | 'completed' | 'failed' | 'cancelled'

const FILTERS: { id: Filter; label: string; match: (s: TaskStatus) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'active', label: 'Active', match: (s) => ['queued', 'planning', 'running', 'paused', 'verifying', 'waiting_permission'].includes(s) },
  { id: 'approval', label: 'Needs approval', match: (s) => s === 'waiting_permission' },
  { id: 'completed', label: 'Completed', match: (s) => s === 'completed' },
  { id: 'failed', label: 'Failed', match: (s) => s === 'failed' || s === 'interrupted' },
  { id: 'cancelled', label: 'Cancelled', match: (s) => s === 'cancelled' }
]

export function Tasks({ taskId }: { taskId?: string }) {
  const tasks = useStore((s) => s.tasks)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const now = useNow(30_000)
  const all = useMemo(() => sortedTasks(tasks), [tasks])
  const f = FILTERS.find((x) => x.id === filter)!
  const list = all.filter((t) => f.match(t.status) && (!query || `${t.title} ${t.instruction}`.toLowerCase().includes(query.toLowerCase())))

  return (
    <div className="page flush">
      <div className="split" style={{ gridTemplateColumns: '340px minmax(0,1fr)' }}>
        <aside className="split-side">
          <div className="split-side-head">
            <h1>Tasks</h1>
            <div className="row">
              <Button size="sm" variant="ghost" icon={Eraser} onClick={() => setConfirmClear(true)} title="Clear finished task history">
                Clear
              </Button>
              <Button size="sm" variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                New task
              </Button>
            </div>
          </div>
          <div className="search">
            <Search />
            <input className="input" placeholder="Search tasks" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search tasks" />
          </div>
          <div className="filters" role="group" aria-label="Filter tasks">
            {FILTERS.map((x) => (
              <button key={x.id} type="button" className="filter" aria-pressed={filter === x.id} onClick={() => setFilter(x.id)}>
                {x.label}
                <span className="n">{all.filter((t) => x.match(t.status)).length}</span>
              </button>
            ))}
          </div>
          <div className="split-list list">
            {list.length === 0 && <div className="muted" style={{ padding: '10px 8px', fontSize: 13 }}>No tasks here.</div>}
            {list.map((t) => (
              <button key={t.id} type="button" className={`list-item ${t.id === taskId ? 'selected' : ''}`} onClick={() => navigate(`tasks/${t.id}`)}>
                <span className="li-body">
                  <div className="li-title">{t.title}</div>
                  <div className="li-sub">{t.currentAction ?? t.summary ?? t.error ?? timeAgo(t.createdAt, now)}</div>
                </span>
                <TaskStatusBadge status={t.status} />
              </button>
            ))}
          </div>
        </aside>
        <div className="split-main">
          {taskId && tasks[taskId] ? (
            <TaskDetail task={tasks[taskId]} />
          ) : (
            <div style={{ margin: 'auto' }}>
              <EmptyState
                icon={CheckSquare}
                title={taskId ? 'Task not found' : 'Mission Control'}
                action={
                  <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                    New task
                  </Button>
                }
              >
                Pick a task to see its plan, live progress and activity log. Everything shown comes from real task events.
              </EmptyState>
            </div>
          )}
        </div>
      </div>
      <NewTaskModal open={creating} onClose={() => setCreating(false)} />
      <ConfirmDialog
        open={confirmClear}
        title="Clear task history?"
        body="Completed, failed, cancelled and interrupted tasks will be removed from history. Running tasks are kept."
        confirmLabel="Clear history"
        danger
        onClose={() => setConfirmClear(false)}
        onConfirm={() => void attempt(() => call('tasks.clearHistory')).then((r) => r && toast({ tone: 'success', title: `Removed ${r.removed} task(s)` }))}
      />
    </div>
  )
}

export function NewTaskModal({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: string }) {
  const projects = useStore((s) => s.projects)
  const activeProject = useStore((s) => s.activeProjectId)
  const [text, setText] = useState(initial ?? '')
  const [projectId, setProjectId] = useState<string>('')
  const [run, pending] = useAction()
  useEffect(() => {
    if (open) {
      setText(initial ?? '')
      setProjectId(activeProject ?? '')
    }
  }, [open, initial, activeProject])
  const submit = async () => {
    const t = await run(() => call('tasks.create', { instruction: text.trim(), source: 'home', projectId: projectId || undefined }), { success: 'Task started' })
    if (t) {
      onClose()
      navigate(`tasks/${t.id}`)
    }
  }
  return (
    <Modal
      open={open}
      title="New task"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={Play} disabled={!text.trim()} loading={pending} onClick={() => void submit()}>
            Start task
          </Button>
        </>
      }
    >
      <Field label="What should ZVYRA do?" htmlFor="task-instruction" help="Describe the outcome. ZVYRA plans the steps and asks before anything risky.">
        <textarea
          id="task-instruction"
          className="textarea"
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.ctrlKey && text.trim()) void submit()
          }}
          placeholder="e.g. Research three competitors and write a one-page summary"
        />
      </Field>
      <Field label="Project" htmlFor="task-project">
        <select id="task-project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">No project</option>
          {Object.values(projects).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  )
}

const EVENT_ICON: Record<TaskEventKind, typeof Flag> = {
  status: CircleDot,
  plan: ListChecks,
  thought: Bot,
  tool_call: Wrench,
  tool_result: Terminal,
  output: Terminal,
  permission: ShieldAlert,
  message: MessageCircle,
  verification: CheckSquare,
  error: AlertCircle
}

function TaskDetail({ task }: { task: Task }) {
  const events = useStore((s) => s.taskEvents[task.id])
  const allPermissions = useStore((s) => s.permissions)
  const permissions = useMemo(() => allPermissions.filter((p) => p.taskId === task.id), [allPermissions, task.id])
  const project = useStore((s) => (task.projectId ? s.projects[task.projectId] : undefined))
  const agent = useStore((s) => (task.agentId ? s.agents[task.agentId] : undefined))
  const [followUp, setFollowUp] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [run, pending] = useAction()
  const [eventsError, setEventsError] = useState<string | null>(null)
  const now = useNow(1000)
  const live = ['queued', 'planning', 'running', 'paused', 'waiting_permission', 'verifying'].includes(task.status)

  useEffect(() => {
    setEventsError(null)
    loadTaskEvents(task.id).catch((e) => setEventsError(String(e?.message ?? e)))
  }, [task.id])

  const send = async () => {
    const r = await run(() => call('tasks.message', { id: task.id, text: followUp.trim() }))
    if (!r) return
    setFollowUp('')
    if (r.id !== task.id) {
      toast({ tone: 'success', title: 'Follow-up task started', message: 'It continues from this task’s objective.' })
      navigate(`tasks/${r.id}`)
    } else toast({ tone: 'success', title: 'Sent to the task' })
  }

  return (
    <div className="detail">
      <header className="detail-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>{task.title}</h2>
          <div className="detail-sub">
            <TaskStatusBadge status={task.status} />
            <span>{humanize(task.source)}</span>
            <span>·</span>
            <span>Created {dateTime(task.createdAt)}</span>
            {task.startedAt && (
              <>
                <span>·</span>
                <span>{live ? 'Running for' : 'Took'} {duration(task.startedAt, task.finishedAt, now)}</span>
              </>
            )}
          </div>
        </div>
        <div className="page-actions">
          {task.canPause && live && (
            <Button icon={Pause} disabled={pending} onClick={() => void run(() => call('tasks.pause', { id: task.id }))}>
              Pause
            </Button>
          )}
          {task.canResume && (
            <Button icon={Play} disabled={pending} onClick={() => void run(() => call('tasks.resume', { id: task.id }))}>
              Resume
            </Button>
          )}
          {live && (
            <Button variant="danger" icon={Square} disabled={pending} onClick={() => void run(() => call('tasks.cancel', { id: task.id }), { success: 'Cancel requested' })}>
              Cancel
            </Button>
          )}
          {task.canRetry && !live && (
            <Button
              icon={RotateCcw}
              disabled={pending}
              onClick={() => void run(() => call('tasks.retry', { id: task.id }), { success: 'Retrying' }).then((t) => t && t.id !== task.id && navigate(`tasks/${t.id}`))}
            >
              Retry
            </Button>
          )}
          {!live && <Button variant="ghost" icon={Trash2} onClick={() => setConfirmDelete(true)} aria-label="Delete task" />}
        </div>
      </header>

      <div className="detail-grid">
        <div className="stack">
          {permissions.map((p) => (
            <PermissionCard key={p.id} request={p} />
          ))}
          <Card title="Objective" icon={Flag}>
            <div className="instruction">{task.instruction}</div>
          </Card>
          {!live && (
            <Card title="Follow up" icon={MessageCircle}>
              <div className="row">
                <input
                  className="input"
                  value={followUp}
                  onChange={(e) => setFollowUp(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && followUp.trim() && void send()}
                  placeholder="Ask ZVYRA to continue, refine or extend this result"
                  aria-label="Follow-up instruction"
                />
                <Button variant="primary" icon={Send} disabled={!followUp.trim() || pending} onClick={() => void send()}>
                  Continue
                </Button>
              </div>
            </Card>
          )}
          {(live || task.plan.length > 0) && (
            <Card title="Plan & progress" icon={ListChecks}>
              <div className="stack" style={{ gap: 12 }}>
                {task.currentAction && (
                  <div className="row" style={{ fontSize: 13 }}>
                    <span className="muted">Now:</span> <span>{task.currentAction}</span>
                  </div>
                )}
                <TaskProgress task={task} />
                {task.plan.length ? <PlanSteps steps={task.plan} /> : <div className="muted" style={{ fontSize: 13 }}>No plan reported yet.</div>}
              </div>
            </Card>
          )}
          {(task.summary || task.output || task.error) && (
            <Card title={task.status === 'failed' ? 'What went wrong' : 'Result'} icon={task.status === 'failed' ? AlertCircle : CheckSquare}>
              <div className="stack" style={{ gap: 10 }}>
                {task.summary && <div className="instruction">{task.summary}</div>}
                {task.error && <div className="notice danger">{task.error}</div>}
                {task.output && <pre className="output">{task.output}</pre>}
              </div>
            </Card>
          )}
          {live && (
            <Card title="Redirect or follow up" icon={MessageCircle}>
              <div className="row">
                <input
                  className="input"
                  value={followUp}
                  onChange={(e) => setFollowUp(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && followUp.trim() && void send()}
                  placeholder="e.g. Focus on pricing only, skip the logo comparison"
                  aria-label="Message to task"
                />
                <Button variant="primary" icon={Send} disabled={!followUp.trim() || pending} onClick={() => void send()}>
                  Send
                </Button>
              </div>
            </Card>
          )}
          <Card title="Activity log" icon={Terminal} actions={<span className="muted" style={{ fontSize: 12 }}>{events?.length ?? 0} events</span>}>
            {eventsError && <div className="notice danger">Couldn’t load events: {eventsError}</div>}
            {!events ? (
              <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
            ) : events.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>No events recorded yet.</div>
            ) : (
              <Timeline events={events} />
            )}
          </Card>
        </div>
        <div className="stack">
          <Card title="Details">
            <KeyValue
              items={[
                { label: 'Status', value: TASK_STATUS_LABEL[task.status] },
                { label: 'Agent', value: agent?.name ?? task.agentId ?? 'Assigned by planner' },
                { label: 'Model', value: task.model ?? 'Auto' },
                {
                  label: 'Project',
                  value: project ? (
                    <button type="button" className="link-btn" onClick={() => navigate(`projects/${project.id}`)}>
                      {project.name}
                    </button>
                  ) : (
                    '—'
                  )
                },
                { label: 'Started', value: dateTime(task.startedAt) },
                { label: 'Finished', value: dateTime(task.finishedAt) },
                { label: 'Progress', value: task.progress ? `${task.progress.completed} of ${task.progress.total}` : 'Not reported' }
              ]}
            />
          </Card>
          {task.conversationId && (
            <Button icon={MessageCircle} onClick={() => navigate(`chat/${task.conversationId}`)}>
              Open conversation
            </Button>
          )}
          {task.automationId && <Button onClick={() => navigate('automations')}>View automation</Button>}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete task?"
        body="The task and its activity log will be removed from history."
        confirmLabel="Delete"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void attempt(() => call('tasks.delete', { id: task.id }), { success: 'Task deleted' }).then(() => navigate('tasks'))}
      />
    </div>
  )
}

function Timeline({ events }: { events: TaskEvent[] }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <ol className="timeline">
      {[...events].reverse().map((e) => {
        const Icon = EVENT_ICON[e.kind] ?? CircleDot
        const hasData = e.data && Object.keys(e.data).length > 0
        return (
          <li key={e.id} className={`tl-item ${e.kind}`}>
            <span className="tl-icon">
              <Icon />
            </span>
            <span className="tl-msg">
              {e.message}
              {hasData && (
                <button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={() => setOpen(open === e.id ? null : e.id)}>
                  {open === e.id ? 'hide' : 'details'}
                </button>
              )}
            </span>
            <span className="tl-time">{new Date(e.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
            {open === e.id && hasData && <pre className="tl-data">{JSON.stringify(e.data, null, 2)}</pre>}
          </li>
        )
      })}
    </ol>
  )
}
