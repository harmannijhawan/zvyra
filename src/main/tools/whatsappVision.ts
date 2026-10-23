/**
 * OWNER: Kiro. WhatsApp Desktop by contact NAME ("call Manan").
 *
 * WhatsApp's WinUI window exposes no accessibility tree (only its caption
 * buttons), so this uses the keyboard plus vision: search the chat list,
 * open the chat whose name matches, read the chat header back from a fresh
 * screenshot to confirm it is the right person, and only then (after the
 * user's approval, handled by the caller) press the call button or Enter.
 * Every step is re-checked from a new screenshot; nothing is assumed.
 */
import { desktopCapturer, screen, shell } from 'electron'
import { captureScreen } from './screenVision'
import { generateWithFallback } from './gemini'
import { pcControl } from './pcControl'
import { uia, type UiRect } from './uia'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Shot {
  jpeg: Buffer
  rect: UiRect
}

async function focusWhatsApp(): Promise<UiRect> {
  let w = (await pcControl.windows()).find((x) => /^whatsapp/i.test(x.process))
  if (!w) {
    await shell.openExternal('whatsapp:')
    for (let i = 0; i < 25 && !w; i++) {
      await sleep(400)
      w = (await pcControl.windows()).find((x) => /^whatsapp/i.test(x.process))
    }
  }
  if (!w) throw new Error('WhatsApp Desktop did not open. Check it is installed and signed in.')
  await pcControl.show(w, 'focus')
  await sleep(700)
  const fg = await uia.foreground()
  if (!/^whatsapp/i.test(fg.process) || !fg.rect) throw new Error('WhatsApp did not come to the front, so nothing was done.')
  return fg.rect
}

async function shot(rect: UiRect): Promise<Shot> {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: rect.w, height: rect.h } })
  const src = sources.find((s) => /^whatsapp$/i.test(s.name.trim())) ?? sources.find((s) => /whatsapp/i.test(s.name))
  if (!src || src.thumbnail.isEmpty()) throw new Error('Could not capture the WhatsApp window.')
  return { jpeg: src.thumbnail.toJPEG(80), rect }
}

type Box = [number, number, number, number] // ymin, xmin, ymax, xmax (0-1000)

async function ask<T>(key: string, s: Shot, prompt: string): Promise<T> {
  const { res } = await generateWithFallback(
    key,
    { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: s.jpeg.toString('base64') } }, { text: `${prompt}\nbox_2d is [ymin, xmin, ymax, xmax] normalised 0-1000 to this screenshot. Return JSON only.` }] }], config: { temperature: 0, maxOutputTokens: 800, responseMimeType: 'application/json' } },
    { timeoutMs: 40_000 }
  )
  return JSON.parse((res.text ?? '{}').replace(/^```(?:json)?\s*|\s*```$/g, '')) as T
}

/** Physical screen point at the centre of a normalised box inside the window. */
const centre = (s: Shot, b: Box) => ({ x: s.rect.x + (((b[1] + b[3]) / 2) / 1000) * s.rect.w, y: s.rect.y + (((b[0] + b[2]) / 2) / 1000) * s.rect.h })
const validBox = (b: unknown): b is Box => Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && v >= 0 && v <= 1000)

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim()
/** Header "Manan Sharma" matches a request for "Manan"; "Mananya" does not. */
export function nameMatches(header: string, wanted: string) {
  const h = norm(header).split(' ')
  const w = norm(wanted).split(' ')
  return !!w.length && w.every((x) => h.includes(x))
}

export interface OpenedChat {
  header: string
  rect: UiRect
}

/** Opens the chat for `name` and confirms the header shows that name. */
export async function openChatByName(key: string, name: string): Promise<OpenedChat> {
  const rect = await focusWhatsApp()
  // Close any open overlay, then search chats.
  await pcControl.keys('esc')
  await sleep(200)
  await pcControl.keys('ctrl+f')
  await sleep(400)
  await pcControl.keys('ctrl+a')
  await uia.typeText(name)
  await sleep(1500)
  const s1 = await shot(rect)
  const r1 = await ask<{ results?: { name: string; box_2d: Box }[] }>(key, s1, `This is WhatsApp Desktop after searching for "${name}". List the contact/chat rows in the search results (not messages), each with its exact display name and box_2d. {"results":[{"name":"...","box_2d":[...]}]}`)
  const rows = (r1.results ?? []).filter((r) => r && typeof r.name === 'string' && validBox(r.box_2d))
  const exact = rows.filter((r) => norm(r.name) === norm(name))
  const candidates = exact.length ? exact : rows.filter((r) => nameMatches(r.name, name))
  if (!candidates.length) throw new Error(`No WhatsApp chat named “${name}” was found${rows.length ? ` (results: ${rows.map((r) => r.name).slice(0, 5).join(', ')})` : ''}.`)
  if (candidates.length > 1 && !exact.length) throw new Error(`Several chats match “${name}”: ${candidates.map((c) => c.name).slice(0, 6).join(', ')}. Say the full name.`)
  const p = centre(s1, candidates[0].box_2d)
  await uia.click(p.x, p.y)
  await sleep(1500)
  const s2 = await shot(rect)
  const r2 = await ask<{ header?: string }>(key, s2, 'This is WhatsApp Desktop. What is the contact or group name shown in the header of the open chat (top of the conversation pane)? {"header":"..."} or {"header":""} if no chat is open.')
  const header = String(r2.header ?? '').trim()
  if (!header || !nameMatches(header, candidates[0].name)) throw new Error(`Opened a chat but its header reads “${header || 'nothing'}”, not “${candidates[0].name}”. Nothing was done.`)
  return { header, rect }
}

export interface ByNameCall {
  status: 'call_interface_opened' | 'call_button_not_found' | 'call_not_confirmed'
  header: string
  note: string
}

/** Presses the voice/video call button of the chat that is open now (call after approval). */
export async function callOpenChat(key: string, chat: OpenedChat, video = false): Promise<ByNameCall> {
  await focusWhatsApp()
  const s = await shot(chat.rect)
  const r = await ask<{ header?: string; voice_call?: Box | null; video_call?: Box | null }>(
    key,
    s,
    'WhatsApp Desktop with a chat open. Give the chat header name and the box_2d of the voice-call (phone icon) and video-call (camera icon) buttons in the chat header (top right of the conversation). {"header":"...","voice_call":[...] or null,"video_call":[...] or null}'
  )
  if (!r.header || !nameMatches(r.header, chat.header)) return { status: 'call_not_confirmed', header: String(r.header ?? ''), note: `The open chat changed (now “${r.header ?? 'unknown'}”), so no call was started.` }
  const box = video ? r.video_call : r.voice_call
  if (!validBox(box)) return { status: 'call_button_not_found', header: chat.header, note: 'The chat is open but the call button could not be found. Press it in WhatsApp yourself.' }
  const p = centre(s, box)
  await uia.click(p.x, p.y)
  await sleep(3500)
  // Calls may open in their own window; look at the screen region again.
  const after = await shot(chat.rect).catch(() => null)
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 640, height: 640 } })
  // A separate call window titled with the contact or "call".
  const callWin = sources.find((x) => x.name.trim() !== 'WhatsApp' && (/\b(voice call|video call|calling|ringing)\b/i.test(x.name) || nameMatches(x.name, chat.header)))
  const v = after ? await ask<{ calling?: boolean; state?: string }>(key, after, 'Is a WhatsApp call screen visible (Calling…, Ringing…, a timer, or End call / hang-up button)? {"calling": true|false, "state": "calling|ringing|connected|none"}').catch(() => ({ calling: false, state: 'unknown' })) : { calling: false }
  if (v.calling || callWin) {
    return { status: 'call_interface_opened', header: chat.header, note: `WhatsApp is calling ${chat.header}${'state' in v && v.state ? ` (${v.state})` : ''}. ZVYRA cannot hear whether they answer unless call audio is routed to it.` }
  }
  return { status: 'call_not_confirmed', header: chat.header, note: 'The call button was pressed but no call screen was seen. Check WhatsApp.' }
}

/** Types and sends a message in the chat that is open now (call after approval). */
export async function sendInOpenChat(key: string, chat: OpenedChat, text: string): Promise<{ status: 'sent_verified' | 'sent_unverified' | 'not_sent'; note: string }> {
  await focusWhatsApp()
  const s = await shot(chat.rect)
  const r = await ask<{ header?: string; compose?: Box | null }>(key, s, 'WhatsApp Desktop with a chat open. Give the chat header name and the box_2d of the "Type a message" box at the bottom. {"header":"...","compose":[...] or null}')
  if (!r.header || !nameMatches(r.header, chat.header)) return { status: 'not_sent', note: `The open chat changed (now “${r.header ?? 'unknown'}”), so nothing was sent.` }
  if (!validBox(r.compose)) return { status: 'not_sent', note: 'The message box could not be found; nothing was sent.' }
  const p = centre(s, r.compose)
  await uia.click(p.x, p.y)
  await sleep(300)
  await uia.typeText(text)
  await sleep(400)
  await pcControl.keys('enter')
  await sleep(1800)
  const after = await shot(chat.rect)
  const check = await ask<{ last_outgoing?: string; compose_empty?: boolean }>(key, after, 'WhatsApp Desktop. Read the text of the most recent OUTGOING (sent by me, right side) message bubble, and say whether the "Type a message" box is empty. {"last_outgoing":"...","compose_empty":true|false}').catch(() => null)
  if (!check) return { status: 'sent_unverified', note: 'Pressed send, but the result could not be checked. Look at the chat.' }
  const sent = norm(check.last_outgoing ?? '').includes(norm(text).slice(0, 40))
  return sent ? { status: 'sent_verified', note: `The message now shows as sent in the chat with ${chat.header}.` } : check.compose_empty ? { status: 'sent_unverified', note: 'The message box emptied, but the sent bubble could not be read back.' } : { status: 'not_sent', note: 'The text is still in the message box; it was not sent.' }
}

/** Presses WhatsApp's red end-call button wherever the call is shown (main window or call window). */
export async function hangUpCall(key: string): Promise<boolean> {
  const wa = (await pcControl.windows()).find((x) => /^whatsapp/i.test(x.process))
  const fgRect = wa ? await uia.foreground().catch(() => null) : null
  const display = fgRect?.rect ? screen.getDisplayMatching(screen.screenToDipRect(null, { x: fgRect.rect.x, y: fgRect.rect.y, width: fgRect.rect.w, height: fgRect.rect.h })) : screen.getPrimaryDisplay()
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await captureScreen(display)
    const jpeg = Buffer.from(s.dataUrl.split(',')[1], 'base64')
    const r = await ask<{ end_call?: Box | null }>(key, { jpeg, rect: { x: 0, y: 0, w: s.width, h: s.height } }, 'Find the red "End call" / hang-up button of a WhatsApp call on this screen. {"end_call":[...] or null}').catch(() => ({ end_call: null }))
    if (!validBox(r.end_call)) {
      // The call controls may be hidden until the call window is in front.
      if (wa) await pcControl.show(wa, 'focus').catch(() => undefined)
      await sleep(800)
      continue
    }
    const b = r.end_call
    const dip = { x: display.bounds.x + (((b[1] + b[3]) / 2) / 1000) * display.bounds.width, y: display.bounds.y + (((b[0] + b[2]) / 2) / 1000) * display.bounds.height }
    const p = screen.dipToScreenPoint(dip)
    await uia.click(p.x, p.y)
    return true
  }
  return false
}
