import type { TaskStatus } from '@shared/contract'

export function timeAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

export function clock(date: Date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function longDate(date: Date) {
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

export function dateTime(iso?: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

export function duration(startIso?: string, endIso?: string, now = Date.now()) {
  if (!startIso) return ''
  const ms = (endIso ? Date.parse(endIso) : now) - Date.parse(startIso)
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function greeting(date = new Date()) {
  const h = date.getHours()
  if (h < 5) return 'Good evening'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'Queued',
  planning: 'Planning',
  running: 'Running',
  paused: 'Paused',
  waiting_permission: 'Needs approval',
  verifying: 'Verifying',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted'
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent'

export const TASK_STATUS_TONE: Record<TaskStatus, Tone> = {
  queued: 'neutral',
  planning: 'accent',
  running: 'info',
  paused: 'warning',
  waiting_permission: 'warning',
  verifying: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  interrupted: 'warning'
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function humanize(s: string) {
  return s.replace(/[_.]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}
