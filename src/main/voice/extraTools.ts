/**
 * OWNER: Kiro. Everyday assistant tools ported from E.D.I.T.H. (no computer
 * control): web research, page reading, media playback, webcam vision,
 * weather, PC status, timers and clipboard. Every visible tool reports its
 * progress as a `tool.activity` event so the Dynamic Island can animate it.
 */
import { randomUUID } from 'node:crypto'
import { clipboard, shell } from 'electron'
import { Type, type FunctionDeclaration } from '@google/genai'
import type { ToolActivity, ToolKind } from '../../shared/contract'
import { DESKTOP_TOOL_DECLARATIONS, runDesktopTool, type DesktopToolHost, type ToolResult } from './desktopTools'
import { readWebpage, webSearch } from '../tools/research'
import { mediaControl, spotifySearchUri, youtubeResultsUrl, youtubeSearch, type MediaAction } from '../tools/media'
import { describeImage } from '../tools/vision'
import { weather } from '../tools/weather'
import { systemStatus } from '../tools/system'

export interface ToolHost extends DesktopToolHost {
  geminiKey(): string | null
  toolActivity(a: ToolActivity): void
  notify(title: string, body: string): void
  camera: {
    open(): void
    close(): void
    /** Opens the island preview if needed and resolves with a JPEG data URL. */
    capture(): Promise<string>
  }
}

/* ---------------------------------------------------------------- declarations */

export const EXTRA_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'web_search',
    description:
      'Search the live web (Google Search). Use for ANY question about current facts, news, prices, people, products, sports, releases — never guess. Modes: search (default), news (latest headlines), research (deep, comprehensive answer), price (what something costs now), compare (side-by-side, pass items).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'What to search for' },
        mode: { type: Type.STRING, description: 'search | news | research | price | compare' },
        items: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Things to compare (compare mode)' },
        aspect: { type: Type.STRING, description: 'Compare by: price | specs | reviews | features' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_webpage',
    description: 'Fetch one public web page and return its readable text (first 20k characters). Use to read an article or docs page the user mentions, or a source from web_search.',
    parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING } }, required: ['url'] }
  },
  {
    name: 'play_media',
    description: 'Play a song, video, podcast or artist. YouTube (default) opens the best matching real video (not Shorts) in the browser and it starts playing; Spotify opens the search in the Spotify app.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'e.g. "lofi hip hop", "Blinding Lights The Weeknd"' },
        platform: { type: Type.STRING, description: 'youtube | spotify' },
        app: { type: Type.STRING, description: 'Optional browser for YouTube: brave, chrome, edge, firefox, opera' }
      },
      required: ['query']
    }
  },
  {
    name: 'media_control',
    description: 'Control whatever is playing on the PC and the system volume: play_pause, next, previous, stop, volume_up, volume_down (value = percent step, default 10), mute (toggle), set_volume (value 0-100), get_volume.',
    parameters: {
      type: Type.OBJECT,
      properties: { action: { type: Type.STRING }, value: { type: Type.NUMBER } },
      required: ['action']
    }
  },
  {
    name: 'camera',
    description:
      'The user’s webcam, shown live in the Dynamic Island. action=open shows the preview; action=look captures a frame and tells you what is visible (pass the user’s question) — you have NO vision without this; action=close turns the camera off. Call look whenever the user asks what you see, to look at something, read something they hold up, etc.',
    parameters: {
      type: Type.OBJECT,
      properties: { action: { type: Type.STRING, description: 'open | look | close' }, question: { type: Type.STRING, description: 'What to look for (look only)' } },
      required: ['action']
    }
  },
  {
    name: 'weather',
    description: 'Current weather and a short forecast for a city (real data). Ask which city if you don’t know it.',
    parameters: { type: Type.OBJECT, properties: { city: { type: Type.STRING }, days: { type: Type.NUMBER, description: '1-7, default 3' } }, required: ['city'] }
  },
  {
    name: 'system_status',
    description: 'Live PC stats: CPU and RAM usage, battery, free disk space, uptime.',
    parameters: { type: Type.OBJECT, properties: {} }
  },
  {
    name: 'set_timer',
    description: 'Timers and quick reminders while ZVYRA is running. action=set (minutes and/or seconds, label), list, or cancel (id, or all when no id). A notification pops up when it ends.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, description: 'set | list | cancel' },
        minutes: { type: Type.NUMBER },
        seconds: { type: Type.NUMBER },
        label: { type: Type.STRING, description: 'What it is for, e.g. "Pasta"' },
        id: { type: Type.STRING }
      },
      required: ['action']
    }
  },
  {
    name: 'clipboard',
    description: 'Read the text currently on the clipboard (action=read) or put text on it (action=write, text).',
    parameters: { type: Type.OBJECT, properties: { action: { type: Type.STRING }, text: { type: Type.STRING } }, required: ['action'] }
  }
]

export const ALL_TOOL_DECLARATIONS: FunctionDeclaration[] = [...DESKTOP_TOOL_DECLARATIONS, ...EXTRA_TOOL_DECLARATIONS]

/* ---------------------------------------------------------------- timers */

interface Timer {
  id: string
  label: string
  endsAt: number
  handle: NodeJS.Timeout
}
const timers = new Map<string, Timer>()

const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return [h ? `${h}h` : '', m ? `${m}m` : '', r || (!h && !m) ? `${r}s` : ''].filter(Boolean).join(' ')
}

/* ---------------------------------------------------------------- activity cards */

const MEDIA_LABEL: Record<string, string> = {
  play_pause: 'Play / pause',
  next: 'Next track',
  previous: 'Previous track',
  stop: 'Stopped playback',
  volume_up: 'Volume up',
  volume_down: 'Volume down',
  mute: 'Mute',
  set_volume: 'Volume',
  get_volume: 'Volume'
}

const SEARCH_LABEL: Record<string, string> = { news: 'Checking the news', research: 'Researching', price: 'Checking prices', compare: 'Comparing', search: 'Searching the web' }

const DONE_LABEL: Record<string, string> = {
  Researching: 'Research ready',
  'Searching the web': 'Found it',
  'Checking the news': 'Latest news',
  'Checking prices': 'Prices',
  Comparing: 'Comparison',
  'Reading a page': 'Page read',
  'Playing on YouTube': 'Now playing',
  'Looking through the camera': 'What I see',
  'PC status': 'PC status',
  Timer: 'Timer started'
}

function describe(name: string, args: Record<string, unknown>): { kind: ToolKind; label: string; subject?: string } | null {
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
  switch (name) {
    case 'web_search': {
      const items = Array.isArray(args['items']) ? (args['items'] as unknown[]).map(String) : []
      const mode = items.length >= 2 ? 'compare' : s('mode').toLowerCase() || 'search'
      return { kind: 'research', label: SEARCH_LABEL[mode] ?? 'Searching the web', subject: items.length >= 2 ? items.join(' vs ') : s('query') }
    }
    case 'read_webpage':
      return { kind: 'web', label: 'Reading a page', subject: s('url').replace(/^https?:\/\/(www\.)?/, '').slice(0, 80) }
    case 'play_media':
      return { kind: 'media', label: s('platform').toLowerCase() === 'spotify' ? 'Opening on Spotify' : 'Playing on YouTube', subject: s('query') }
    case 'media_control':
      return { kind: 'media', label: MEDIA_LABEL[s('action')] ?? 'Media', subject: s('action') === 'set_volume' && typeof args['value'] === 'number' ? `${args['value']}%` : undefined }
    case 'camera':
      return s('action').toLowerCase() === 'look' ? { kind: 'camera', label: 'Looking through the camera', subject: s('question') } : null
    case 'weather':
      return { kind: 'weather', label: 'Weather', subject: s('city') }
    case 'system_status':
      return { kind: 'system', label: 'PC status' }
    case 'set_timer':
      return s('action').toLowerCase() === 'set' ? { kind: 'timer', label: 'Timer', subject: s('label') || undefined } : null
    default:
      return null
  }
}

function summarize(name: string, r: ToolResult): Pick<ToolActivity, 'summary' | 'sources' | 'subject'> {
  switch (name) {
    case 'web_search':
      return { summary: String(r['answer'] ?? '').split('\nPage excerpts')[0].slice(0, 900), sources: (r['sources'] as ToolActivity['sources']) ?? [] }
    case 'read_webpage':
      return { summary: String(r['title'] ?? '') }
    case 'play_media':
      return { summary: [r['playing'], r['channel']].filter(Boolean).join(' — ') || String(r['note'] ?? '') }
    case 'media_control':
      return { summary: typeof r['volume'] === 'number' ? `Volume ${r['volume']}%${r['muted'] ? ' (muted)' : ''}` : 'Done' }
    case 'camera':
      return { summary: String(r['description'] ?? '') }
    case 'weather':
      return { summary: String(r['summary'] ?? '') }
    case 'system_status':
      return { summary: `CPU ${r['cpuPercent']}% · RAM ${r['ramUsedGb']}/${r['ramTotalGb']} GB · Battery ${r['battery']}${r['diskFreeGb'] !== undefined ? ` · ${r['diskFreeGb']} GB free` : ''}` }
    case 'set_timer':
      return { summary: String(r['note'] ?? '') }
    default:
      return {}
  }
}

/* ---------------------------------------------------------------- executor */

async function runExtra(host: ToolHost, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult | null> {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
  const num = (k: string) => (typeof args[k] === 'number' && Number.isFinite(args[k]) ? (args[k] as number) : undefined)
  switch (name) {
    case 'web_search': {
      const items = Array.isArray(args['items']) ? (args['items'] as unknown[]).map(String) : []
      const r = await webSearch(host.geminiKey(), { query: str('query'), mode: str('mode') || undefined, items, aspect: str('aspect') || undefined }, signal)
      host.activity('web.search', `Searched: ${str('query') || items.join(', ')}`.slice(0, 120), r.sources[0]?.url)
      const note =
        r.backend === 'web'
          ? 'Live Google Search was unavailable, so this answer comes from other web sources plus general knowledge. Tell the user the answer; do not say you found nothing.'
          : undefined
      // The island card shows the readable list; the model gets everything incl. page excerpts.
      return { ok: true, answer: r.text, sources: r.sources, via: r.backend, ...(note ? { note } : {}) }
    }
    case 'read_webpage': {
      const r = await readWebpage(str('url'), signal)
      return { ok: true, ...r }
    }
    case 'play_media': {
      const query = str('query')
      if (!query) return { error: 'What should I play?' }
      if (str('platform').toLowerCase() === 'spotify') {
        try {
          await shell.openExternal(spotifySearchUri(query))
        } catch {
          await shell.openExternal(`https://open.spotify.com/search/${encodeURIComponent(query)}`)
        }
        host.activity('media.play', `Spotify: ${query}`)
        return { ok: true, note: `Opened Spotify search for “${query}” — press play on the top result.` }
      }
      const hit = (await youtubeSearch(query, 1).catch(() => []))[0]
      const target = hit?.url ?? youtubeResultsUrl(query)
      const opened = await runDesktopTool(host, 'open', { target, app: str('app') || undefined })
      if (opened['error']) return opened
      host.activity('media.play', `Playing: ${hit?.title ?? query}`, target)
      return hit ? { ok: true, playing: hit.title ?? query, channel: hit.channel, length: hit.length, url: hit.url } : { ok: true, note: `Opened YouTube results for “${query}”.` }
    }
    case 'media_control': {
      const action = str('action').toLowerCase().replace(/[\s-]+/g, '_') as MediaAction
      return mediaControl(action, num('value'))
    }
    case 'camera': {
      const action = str('action').toLowerCase()
      if (action === 'open') {
        host.camera.open()
        return { ok: true, note: 'The live camera preview is showing in the Dynamic Island.' }
      }
      if (action === 'close') {
        host.camera.close()
        return { ok: true, note: 'Camera off.' }
      }
      if (action !== 'look') return { error: 'Use open, look or close.' }
      const key = host.geminiKey()
      if (!key) return { error: 'Add a Gemini API key in Settings → Voice so I can see.' }
      const frame = await host.camera.capture()
      const description = await describeImage(key, frame, str('question'), signal)
      return { ok: true, source: 'webcam', description, note: 'The preview stays open until the user asks to close the camera.' }
    }
    case 'weather':
      return { ok: true, ...(await weather(str('city'), num('days') ?? 3)) }
    case 'system_status':
      return { ok: true, ...(await systemStatus()) }
    case 'set_timer': {
      const action = str('action').toLowerCase()
      if (action === 'list') return { timers: [...timers.values()].map((t) => ({ id: t.id, label: t.label, remaining: fmtDuration(t.endsAt - Date.now()) })) }
      if (action === 'cancel') {
        const id = str('id')
        const list = id ? [...timers.values()].filter((t) => t.id === id || t.label.toLowerCase() === id.toLowerCase()) : [...timers.values()]
        for (const t of list) {
          clearTimeout(t.handle)
          timers.delete(t.id)
        }
        return { ok: true, cancelled: list.length }
      }
      const ms = ((num('minutes') ?? 0) * 60 + (num('seconds') ?? 0)) * 1000
      if (ms < 1000) return { error: 'How long should the timer be?' }
      if (ms > 24 * 3600_000) return { error: 'Timers can be up to 24 hours. Use an automation for longer.' }
      const id = randomUUID().slice(0, 8)
      const label = str('label') || 'Timer'
      const handle = setTimeout(() => {
        timers.delete(id)
        host.notify(`⏰ ${label}`, `Your ${fmtDuration(ms)} timer is done.`)
        const now = new Date().toISOString()
        host.toolActivity({ id: `timer-${id}`, tool: 'set_timer', kind: 'timer', label: 'Time’s up', subject: label, status: 'done', summary: `${fmtDuration(ms)} timer finished`, startedAt: now, updatedAt: now })
        host.activity('timer.done', `Timer done: ${label}`, undefined, 'success')
      }, ms)
      handle.unref?.()
      timers.set(id, { id, label, endsAt: Date.now() + ms, handle })
      return { ok: true, id, note: `${label} — ${fmtDuration(ms)} timer started.` }
    }
    case 'clipboard': {
      if (str('action').toLowerCase() === 'write') {
        const text = typeof args['text'] === 'string' ? (args['text'] as string) : ''
        if (!text) return { error: 'Nothing to copy.' }
        await Promise.resolve(clipboard.writeText(text))
        return { ok: true, copied: text.length }
      }
      const text = await Promise.resolve(clipboard.readText())
      return text ? { ok: true, text: text.slice(0, 20_000), truncated: text.length > 20_000 } : { ok: true, text: '', note: 'The clipboard has no text.' }
    }
    default:
      return null
  }
}

/**
 * Runs any tool (desktop or extra). Visible tools emit running → done/error
 * activity so the island can show a live card.
 */
export async function runTool(host: ToolHost, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const meta = describe(name, args)
  const startedAt = new Date().toISOString()
  const card: ToolActivity | null = meta ? { id: randomUUID(), tool: name, ...meta, status: 'running', startedAt, updatedAt: startedAt } : null
  if (card) host.toolActivity(card)
  try {
    const r = (await runExtra(host, name, args, signal)) ?? (await runDesktopTool(host, name, args))
    if (card) {
      const err = typeof r['error'] === 'string' ? (r['error'] as string) : undefined
      const label = err ? `${card.label} failed` : (DONE_LABEL[card.label] ?? card.label)
      host.toolActivity({ ...card, ...(err ? { summary: err } : summarize(name, r)), label, subject: card.subject, status: err ? 'error' : 'done', updatedAt: new Date().toISOString() })
    }
    return r
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (card) host.toolActivity({ ...card, status: 'error', summary: message, updatedAt: new Date().toISOString() })
    throw err
  }
}
