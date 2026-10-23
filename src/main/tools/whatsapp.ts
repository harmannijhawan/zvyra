/**
 * OWNER: Kiro. WhatsApp Desktop integration through supported means only:
 *
 *  - the official click-to-chat deep link (whatsapp://send?phone=…&text=…)
 *    opens the right conversation with a prefilled draft,
 *  - sending = pressing Enter in that draft, only after the user approved the
 *    exact recipient and text, then checking the compose box emptied,
 *  - calls = invoking WhatsApp's own call button through UI Automation after
 *    approval; that opens the call screen, it does not prove anyone answered.
 *
 * No tokens, cookies, session files or unofficial APIs are touched.
 */
import { pcControl, type WinInfo } from './pcControl'
import { uia } from './uia'

export interface WaDeps {
  openExternal(url: string): Promise<void>
  sleep?(ms: number): Promise<void>
}

/** WhatsApp needs the full international number (country code, digits only). */
export function toWaNumber(phone: string, defaultCountryCode?: string): string {
  const raw = phone.trim()
  const d = raw.replace(/\D/g, '')
  if (raw.startsWith('+') || raw.startsWith('00')) {
    const n = raw.startsWith('00') ? d.slice(2) : d
    if (n.length < 8 || n.length > 15) throw new Error(`“${phone}” is not a valid international number.`)
    return n
  }
  const cc = (defaultCountryCode ?? '').replace(/\D/g, '')
  if (cc) {
    const local = d.replace(/^0+/, '')
    if (local.length >= 6 && local.length <= 12) return cc + local
  }
  throw new Error(`“${phone}” has no country code. Ask for the number in international format (e.g. +91 98220 12345).`)
}

export function waLink(number: string, text?: string) {
  return `whatsapp://send?phone=${number}${text ? `&text=${encodeURIComponent(text)}` : ''}`
}

export function checkMessage(text: string) {
  const t = text.trim()
  if (!t) throw new Error('The message is empty.')
  if (t.length > 4000) throw new Error('The message is too long for one WhatsApp message (max ~4000 characters).')
  return t
}

const isWa = (w: Pick<WinInfo, 'process'>) => /^whatsapp/i.test(w.process)
const COMPOSE = '^(Type a message|Type a message.*|Message|Write a message.*|Compose message)$'

async function waitForWindow(sleep: (ms: number) => Promise<void>, ms = 10_000): Promise<WinInfo | null> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const w = (await pcControl.windows().catch(() => [])).find(isWa)
    if (w) return w
    await sleep(400)
  }
  return null
}

async function composeValue(proc: string): Promise<string | null> {
  const els = await uia.getValue({ process: proc, name: COMPOSE, types: ['Edit', 'Document'] }).catch(() => [])
  const el = els.find((e) => typeof e.value === 'string')
  return el ? (el.value ?? '') : null
}

export interface OpenResult {
  opened: boolean
  window?: string
  process?: string
  foreground: boolean
  draftVisible: boolean | null
  note: string
}

export async function openChat(deps: WaDeps, number: string, text?: string): Promise<OpenResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  await deps.openExternal(waLink(number, text))
  const w = await waitForWindow(sleep)
  if (!w) return { opened: false, foreground: false, draftVisible: null, note: 'WhatsApp did not open. Check that WhatsApp Desktop is installed and signed in.' }
  await pcControl.show(w, 'focus').catch(() => undefined)
  await sleep(1200)
  const fg = await uia.foreground().catch(() => null)
  const foreground = !!fg && /^whatsapp/i.test(fg.process)
  let draftVisible: boolean | null = null
  if (text) {
    const v = await composeValue(w.process)
    draftVisible = v === null ? null : v.replace(/\s+/g, ' ').includes(text.trim().replace(/\s+/g, ' ').slice(0, 60))
  }
  return {
    opened: true,
    window: w.title,
    process: w.process,
    foreground,
    draftVisible,
    note:
      draftVisible === null
        ? 'WhatsApp opened the chat link. Its message box is not exposed to accessibility, so ZVYRA cannot read the draft back.'
        : draftVisible
          ? 'The draft is in the message box and has not been sent.'
          : 'WhatsApp opened, but the draft text is not in the message box (the number may not be on WhatsApp).'
  }
}

export interface SendResult extends OpenResult {
  status: 'sent_verified' | 'sent_unverified' | 'not_sent'
}

/** Call only after the user approved this exact number + text. */
export async function sendApproved(deps: WaDeps, number: string, text: string): Promise<SendResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const o = await openChat(deps, number, text)
  if (!o.opened) return { ...o, status: 'not_sent' }
  if (!o.foreground) return { ...o, status: 'not_sent', note: 'WhatsApp did not come to the front, so nothing was pressed. The draft is open for you to send.' }
  if (o.draftVisible === false) return { ...o, status: 'not_sent' }
  // Re-check right before pressing Enter: still WhatsApp in front?
  const fg = await uia.foreground().catch(() => null)
  if (!fg || !/^whatsapp/i.test(fg.process)) return { ...o, status: 'not_sent', note: 'Another window took focus, so nothing was sent.' }
  await pcControl.keys('enter')
  await sleep(1500)
  const after = await composeValue(o.process ?? 'WhatsApp.Root')
  if (after === null) return { ...o, status: 'sent_unverified', note: 'Pressed send in the WhatsApp chat. WhatsApp does not expose its chat to accessibility here, so delivery could not be confirmed. Please check the chat.' }
  if (!after.trim()) return { ...o, status: 'sent_verified', note: 'The message left the compose box (sent). Delivery/read ticks are not checked.' }
  return { ...o, status: 'not_sent', note: 'The text is still in the message box; it was not sent.' }
}

export interface CallResult {
  status: 'call_interface_opened' | 'call_button_clicked' | 'call_button_not_found' | 'whatsapp_not_open'
  note: string
}

/** Call only after the user approved calling this number. */
export async function callApproved(deps: WaDeps, number: string, video = false): Promise<CallResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const o = await openChat(deps, number)
  if (!o.opened) return { status: 'whatsapp_not_open', note: o.note }
  const proc = o.process ?? 'WhatsApp.Root'
  const name = video ? '^(Video call|Start video call)$' : '^(Voice call|Audio call|Call|Start voice call)$'
  try {
    await uia.invoke({ process: proc, name, types: ['Button', 'SplitButton'], focus: true })
  } catch {
    return { status: 'call_button_not_found', note: 'The chat is open, but WhatsApp’s call button is not reachable through accessibility. Press the call button in WhatsApp yourself.' }
  }
  await sleep(2500)
  const end = await uia.getValue({ process: proc, name: '^(End call|Hang up|Leave call|End)$', types: ['Button'] }).catch(() => [])
  return end.length
    ? { status: 'call_interface_opened', note: 'WhatsApp’s call screen is open (ringing or connecting). ZVYRA cannot tell whether the call is answered.' }
    : { status: 'call_button_clicked', note: 'The call button was pressed but no call screen was detected. Check WhatsApp.' }
}

/** Visible text in the open WhatsApp window (only when the user asks to read a chat). */
export async function readVisible(max = 60): Promise<string[]> {
  const els = await uia.tree({ process: 'WhatsApp.Root', types: ['Text', 'ListItem'], max: Math.min(200, max), depth: 40 })
  return els.map((e) => e.name).filter((n) => n && n.length > 1)
}
