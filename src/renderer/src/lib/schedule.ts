import type { Schedule } from '@shared/contract'

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function describeSchedule(s: Schedule): string {
  switch (s.type) {
    case 'interval':
      return s.everyMinutes % 60 === 0
        ? `Every ${s.everyMinutes / 60 === 1 ? 'hour' : `${s.everyMinutes / 60} hours`}`
        : `Every ${s.everyMinutes} minute${s.everyMinutes === 1 ? '' : 's'}`
    case 'daily': {
      const days = [...s.days].sort()
      const label =
        days.length === 7 ? 'Every day' : days.join() === '1,2,3,4,5' ? 'Weekdays' : days.join() === '0,6' ? 'Weekends' : days.map((d) => DAY[d]).join(', ')
      return `${label} at ${formatTime(s.time)}`
    }
    case 'once':
      return `Once on ${new Date(s.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
  }
}

export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Validates editor input; returns an error message or null. */
export function validateSchedule(s: Schedule, now = Date.now()): string | null {
  if (s.type === 'interval') return Number.isInteger(s.everyMinutes) && s.everyMinutes >= 1 ? null : 'Interval must be at least 1 minute'
  if (s.type === 'daily') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) return 'Choose a time'
    return s.days.length ? null : 'Pick at least one day'
  }
  const t = Date.parse(s.at)
  if (Number.isNaN(t)) return 'Choose a date and time'
  return t > now ? null : 'The time must be in the future'
}

/** `<input type="datetime-local">` value ↔ ISO */
export function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
