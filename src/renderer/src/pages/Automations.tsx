/** Automations — scheduled and recurring tasks, honest about the scheduler. */
import { CalendarClock, History, Info, Pencil, Play, Plus, Save, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Automation, AutomationRun, Schedule, SchedulerStatus } from '@shared/contract'
import { TaskStatusBadge } from '../components/TaskBits'
import { Button, Card, ConfirmDialog, EmptyState, Field, IconButton, Modal, Segmented, Toggle } from '../components/ui'
import { call, errorMessage } from '../lib/client'
import { dateTime } from '../lib/format'
import { describeSchedule, toLocalInput, validateSchedule } from '../lib/schedule'
import { navigate, setState, useStore } from '../lib/store'
import { attempt, useAction } from '../lib/useAction'

export function Automations() {
  const automations = useStore((s) => s.automations)
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null)
  const [editing, setEditing] = useState<Automation | null | undefined>(undefined)
  const [deleting, setDeleting] = useState<Automation | null>(null)
  const [history, setHistory] = useState<Automation | null>(null)
  const list = useMemo(() => Object.values(automations).sort((a, b) => a.name.localeCompare(b.name)), [automations])

  useEffect(() => {
    call('automations.scheduler').then(setScheduler).catch(() => undefined)
    call('automations.list')
      .then((l) => setState({ automations: Object.fromEntries(l.map((a) => [a.id, a])) }))
      .catch(() => undefined)
  }, [])

  const upsert = (a?: Automation) => a && setState((s) => ({ automations: { ...s.automations, [a.id]: a } }))

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Automations</h1>
          <p>Work that runs on a schedule and reports back.</p>
        </div>
        <div className="page-actions">
          <Button variant="primary" icon={Plus} onClick={() => setEditing(null)}>
            New automation
          </Button>
        </div>
      </header>
      {scheduler && (
        <div className={`notice ${scheduler.running ? '' : 'warning'}`} style={{ marginBottom: 16 }}>
          <Info />
          <span>
            <b>{scheduler.running ? 'Scheduler running.' : 'Scheduler not running.'}</b> {scheduler.note}
          </span>
        </div>
      )}
      {list.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No automations"
          action={
            <Button variant="primary" icon={Plus} onClick={() => setEditing(null)}>
              Create one
            </Button>
          }
        >
          For example: “Every weekday at 9:00, summarise new files in my Downloads folder.”
        </EmptyState>
      ) : (
        <div className="card padded" style={{ padding: 6 }}>
          <div className="list">
            {list.map((a) => (
              <div key={a.id} className="list-item">
                <Toggle
                  checked={a.enabled}
                  label={`${a.enabled ? 'Disable' : 'Enable'} ${a.name}`}
                  onChange={(v) => void attempt(() => call('automations.update', { id: a.id, enabled: v })).then(upsert)}
                />
                <span className="li-body">
                  <div className="li-title">{a.name}</div>
                  <div className="li-sub">
                    {describeSchedule(a.schedule)}
                    {a.nextRunAt && a.enabled ? ` · next ${dateTime(a.nextRunAt)}` : ''}
                    {a.lastRunAt ? ` · last ${dateTime(a.lastRunAt)}` : ''}
                    {a.lastResult ? ` · ${a.lastResult}` : ''}
                  </div>
                </span>
                {a.lastStatus && (
                  <button type="button" onClick={() => a.lastTaskId && navigate(`tasks/${a.lastTaskId}`)} title="Open last run">
                    <TaskStatusBadge status={a.lastStatus} />
                  </button>
                )}
                <Button
                  size="sm"
                  icon={Play}
                  onClick={() => void attempt(() => call('automations.runNow', { id: a.id }), { success: 'Running now' }).then((t) => t && navigate(`tasks/${t.id}`))}
                >
                  Run now
                </Button>
                <IconButton icon={History} size="sm" label="Run history" onClick={() => setHistory(a)} />
                <IconButton icon={Pencil} size="sm" label="Edit" onClick={() => setEditing(a)} />
                <IconButton icon={Trash2} size="sm" label="Delete" onClick={() => setDeleting(a)} />
              </div>
            ))}
          </div>
        </div>
      )}
      <AutomationEditor open={editing !== undefined} item={editing ?? null} onClose={() => setEditing(undefined)} onSaved={upsert} />
      <RunHistory automation={history} onClose={() => setHistory(null)} />
      <ConfirmDialog
        open={!!deleting}
        title="Delete automation?"
        body={`“${deleting?.name}” will stop running and be removed. Past task records are kept.`}
        confirmLabel="Delete"
        danger
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && void attempt(() => call('automations.delete', { id: deleting.id }), { success: 'Automation deleted' })}
      />
    </div>
  )
}

const ALL_DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

function AutomationEditor({ open, item, onClose, onSaved }: { open: boolean; item: Automation | null; onClose: () => void; onSaved: (a?: Automation) => void }) {
  const projects = useStore((s) => s.projects)
  const [name, setName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [type, setType] = useState<Schedule['type']>('daily')
  const [minutes, setMinutes] = useState(60)
  const [time, setTime] = useState('09:00')
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [at, setAt] = useState(() => toLocalInput(new Date(Date.now() + 3600_000).toISOString()))
  const [projectId, setProjectId] = useState('')
  const [run, pending] = useAction()

  useEffect(() => {
    if (!open) return
    setName(item?.name ?? '')
    setInstruction(item?.instruction ?? '')
    setProjectId(item?.projectId ?? '')
    const s = item?.schedule
    setType(s?.type ?? 'daily')
    if (s?.type === 'interval') setMinutes(s.everyMinutes)
    if (s?.type === 'daily') {
      setTime(s.time)
      setDays(s.days)
    }
    setAt(toLocalInput(s?.type === 'once' ? s.at : new Date(Date.now() + 3600_000).toISOString()))
  }, [open, item])

  const schedule: Schedule = type === 'interval' ? { type, everyMinutes: minutes } : type === 'daily' ? { type, time, days } : { type, at: new Date(at).toISOString() }
  const invalid = validateSchedule(schedule)

  const save = async () => {
    const payload = { name: name.trim(), instruction: instruction.trim(), schedule, projectId: projectId || undefined }
    const a = await run(() => (item ? call('automations.update', { id: item.id, ...payload }) : call('automations.create', { ...payload, enabled: true })), {
      success: item ? 'Automation saved' : 'Automation created'
    })
    if (a) {
      onSaved(a)
      onClose()
    }
  }

  return (
    <Modal
      open={open}
      title={item ? 'Edit automation' : 'New automation'}
      onClose={onClose}
      width={580}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={Save} disabled={!name.trim() || !instruction.trim() || !!invalid} loading={pending} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Name" htmlFor="auto-name">
        <input id="auto-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning briefing" />
      </Field>
      <Field label="What should ZVYRA do?" htmlFor="auto-instruction">
        <textarea id="auto-instruction" className="textarea" rows={4} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
      </Field>
      <Field label="Schedule">
        <Segmented
          label="Schedule type"
          value={type}
          onChange={setType}
          options={[
            { value: 'once', label: 'Once' },
            { value: 'daily', label: 'Daily / weekly' },
            { value: 'interval', label: 'Repeat every' }
          ]}
        />
      </Field>
      {type === 'once' && (
        <Field label="Date and time" htmlFor="auto-at">
          <input id="auto-at" type="datetime-local" className="input" value={at} onChange={(e) => setAt(e.target.value)} />
        </Field>
      )}
      {type === 'daily' && (
        <div className="form-grid">
          <Field label="Time" htmlFor="auto-time">
            <input id="auto-time" type="time" className="input" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label="Days">
            <div className="segmented" role="group" aria-label="Days">
              {ALL_DAYS.map((d, i) => (
                <button
                  key={i}
                  type="button"
                  aria-pressed={days.includes(i)}
                  aria-label={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]}
                  onClick={() => setDays((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]))}
                  style={{ padding: '0 9px' }}
                >
                  {d}
                </button>
              ))}
            </div>
          </Field>
        </div>
      )}
      {type === 'interval' && (
        <Field label="Every (minutes)" htmlFor="auto-min">
          <input id="auto-min" type="number" min={1} className="input" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
        </Field>
      )}
      <div className="muted" style={{ fontSize: 12.5 }}>
        {invalid ? <span style={{ color: '#ffadb5' }}>{invalid}</span> : describeSchedule(schedule)}
      </div>
      <Field label="Project" htmlFor="auto-project">
        <select id="auto-project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
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

function RunHistory({ automation, onClose }: { automation: Automation | null; onClose: () => void }) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!automation) return
    setRuns(null)
    setError(null)
    call('automations.runs', { id: automation.id, limit: 50 })
      .then(setRuns)
      .catch((e) => setError(errorMessage(e)))
  }, [automation])
  return (
    <Modal open={!!automation} title={`Run history · ${automation?.name ?? ''}`} onClose={onClose} width={560}>
      {error && <div className="notice danger">{error}</div>}
      {runs && runs.length === 0 && <div className="muted">This automation hasn’t run yet.</div>}
      <Card padded={false}>
        <div className="list">
          {runs?.map((r) => (
            <button key={r.id} type="button" className="list-item" onClick={() => r.taskId && (onClose(), navigate(`tasks/${r.taskId}`))}>
              <span className="li-body">
                <div className="li-title">{dateTime(r.startedAt)}</div>
                <div className="li-sub">{r.summary ?? (r.finishedAt ? `Finished ${dateTime(r.finishedAt)}` : 'Running')}</div>
              </span>
              <TaskStatusBadge status={r.status} />
            </button>
          ))}
        </div>
      </Card>
    </Modal>
  )
}
