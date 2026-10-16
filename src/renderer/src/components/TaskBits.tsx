/** Small task visuals shared across the island, Home and Mission Control. */
import { Check, Circle, Loader2, Minus, X } from 'lucide-react'
import type { Task, TaskStep } from '@shared/contract'
import { TASK_STATUS_LABEL, TASK_STATUS_TONE } from '../lib/format'
import { Badge } from './ui'

export function TaskStatusBadge({ status }: { status: Task['status'] }) {
  const live = ['planning', 'running', 'verifying'].includes(status)
  return (
    <Badge tone={TASK_STATUS_TONE[status]}>
      {live && <span className="badge-live" aria-hidden="true" />}
      {TASK_STATUS_LABEL[status]}
    </Badge>
  )
}

/**
 * Only renders a bar when the backend reports real counted progress.
 * Otherwise shows an indeterminate shimmer for live states, or nothing.
 */
export function TaskProgress({ task, showLabel = true }: { task: Task; showLabel?: boolean }) {
  const live = ['planning', 'running', 'verifying'].includes(task.status)
  if (task.progress && task.progress.total > 0) {
    const pct = Math.round((task.progress.completed / task.progress.total) * 100)
    return (
      <div className="progress-wrap">
        <div
          className={`progress ${live ? 'live' : ''}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={task.progress.total}
          aria-valuenow={task.progress.completed}
          aria-label="Task progress"
        >
          <span style={{ width: `${pct}%` }} />
        </div>
        {showLabel && (
          <span className="progress-label">
            {task.progress.completed}/{task.progress.total} steps
          </span>
        )}
      </div>
    )
  }
  if (!live) return null
  return (
    <div className="progress indeterminate" role="progressbar" aria-label="Working — progress not reported">
      <span />
    </div>
  )
}

const STEP_ICON = { pending: Circle, running: Loader2, done: Check, failed: X, skipped: Minus }

export function PlanSteps({ steps, max }: { steps: TaskStep[]; max?: number }) {
  if (!steps.length) return null
  const runningIdx = steps.findIndex((s) => s.status === 'running')
  let visible = steps
  if (max && steps.length > max) {
    const start = Math.max(0, Math.min(steps.length - max, (runningIdx >= 0 ? runningIdx : 0) - 1))
    visible = steps.slice(start, start + max)
  }
  return (
    <ol className="plan-steps">
      {visible.map((s) => {
        const Icon = STEP_ICON[s.status]
        return (
          <li key={s.id} className={`step ${s.status}`}>
            <Icon className={s.status === 'running' ? 'spin' : ''} />
            <span className="truncate">{s.title}</span>
          </li>
        )
      })}
      {max && steps.length > max && <li className="step more">{steps.length} steps total</li>}
    </ol>
  )
}
