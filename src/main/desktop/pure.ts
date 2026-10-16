/**
 * OWNER: Kiro. Pure helpers for the desktop-services layer (no Electron/Node
 * side effects) so they can be unit-tested.
 */
import type { NotificationPriority, Schedule } from '../../shared/contract'

/* ---------------------------------------------------------------- paths */

function norm(p: string, win: boolean) {
  let s = p.replace(/[\\/]+/g, '/')
  if (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/i.test(s)) s = s.slice(0, -1)
  return win ? s.toLowerCase() : s
}

/** True when `target` is `root` or inside it. Compare already-resolved real paths. */
export function isInside(root: string, target: string, win = process.platform === 'win32'): boolean {
  const r = norm(root, win)
  const t = norm(target, win)
  if (t === r) return true
  return t.startsWith(r.endsWith('/') ? r : r + '/')
}

/* ---------------------------------------------------------------- branding */

const BRAND_RULES: [RegExp, string][] = [
  [/Embedded SWARM:\s*/gi, ''],
  [/SWARM embedded/gi, 'ZVYRA engine'],
  [/SWARM PcControlService\s*\/\s*nut-js/gi, 'ZVYRA computer control (nut-js)'],
  [/SWARM providers/gi, 'AI providers'],
  [/SWARM assigns agents/gi, 'ZVYRA assigns agents'],
  [/through SWARM/gi, 'through ZVYRA'],
  [/\bSWARM\b/g, 'ZVYRA'],
  [/\ba BYOK provider\b/gi, 'an AI provider'],
  [/\bBYOK provider\b/gi, 'AI provider']
]

/** Removes internal engine branding from user-visible strings. */
export function debrand(text: string): string
export function debrand(text: string | undefined): string | undefined
export function debrand(text: string | undefined): string | undefined {
  if (!text) return text
  let out = text
  for (const [re, rep] of BRAND_RULES) out = out.replace(re, rep)
  return out === text ? out : out.replace(/^\s*[a-z]/, (c) => c.toUpperCase())
}

/* ---------------------------------------------------------------- schedules */

function parseHHMM(t: string): [number, number] | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t)
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** Next run strictly after `from` (local time), or null when the schedule is finished. */
export function nextRun(s: Schedule, from: number): number | null {
  if (s.type === 'once') {
    const t = Date.parse(s.at)
    return Number.isFinite(t) && t > from ? t : null
  }
  if (s.type === 'interval') {
    const every = Math.max(1, Math.floor(s.everyMinutes)) * 60_000
    return from + every
  }
  const hm = parseHHMM(s.time)
  if (!hm || !s.days.length) return null
  const d = new Date(from)
  for (let i = 0; i <= 7; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hm[0], hm[1], 0, 0)
    if (c.getTime() > from && s.days.includes(c.getDay())) return c.getTime()
  }
  return null
}

/* ---------------------------------------------------------------- notifications */

const PRIORITY_RANK: Record<NotificationPriority, number> = { low: 0, normal: 1, high: 2, critical: 3 }

export function atLeast(p: NotificationPriority, min: NotificationPriority) {
  return PRIORITY_RANK[p] >= PRIORITY_RANK[min]
}

/** Is local time inside a quiet-hours window ("HH:MM"–"HH:MM", may wrap midnight)? */
export function inQuietHours(start: string, end: string, now: Date): boolean {
  const s = parseHHMM(start)
  const e = parseHHMM(end)
  if (!s || !e) return false
  const m = now.getHours() * 60 + now.getMinutes()
  const sm = s[0] * 60 + s[1]
  const em = e[0] * 60 + e[1]
  if (sm === em) return true
  return sm < em ? m >= sm && m < em : m >= sm || m < em
}

/** Engines that only accept whole hours get HH:00. */
export function toWholeHour(t: string): string {
  const hm = parseHHMM(t)
  return hm ? `${String(hm[0]).padStart(2, '0')}:00` : '00:00'
}

/* ---------------------------------------------------------------- misc */

/** Splits an object into keys accepted by an engine and the remainder. */
export function splitKeys<T extends Record<string, unknown>>(obj: T, accepted: readonly string[]): [Partial<T>, Partial<T>] {
  const a: Record<string, unknown> = {}
  const b: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (accepted.includes(k)) a[k] = v
    else b[k] = v
  }
  return [a as Partial<T>, b as Partial<T>]
}

export function maskPhone(n: string): string {
  const d = n.replace(/[^\d+]/g, '')
  return d.length <= 4 ? d : `${d.slice(0, Math.min(3, d.length - 4))}••••${d.slice(-4)}`
}

/** Strict E.164 check for call destinations. */
export function isE164(n: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(n)
}

/** Simple keyword relevance for memory → task context. */
export function relevance(query: string, text: string): number {
  const words = new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
  if (!words.size) return 0
  let hits = 0
  for (const w of new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])) if (words.has(w)) hits++
  return hits / words.size
}

/** Removes tool-call markup some models leak into plain-text replies. */
export function stripToolMarkup(text: string): string {
  return text
    .replace(/<\|tool_call_start\|>[\s\S]*?(<\|tool_call_end\|>|$)/g, '')
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '')
    .replace(/<\|(?:im_start|im_end|eot_id|end_of_text)\|>/g, '')
    .trim()
}

export function xmlEscape(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)
}
