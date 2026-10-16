/**
 * OWNER: Kiro. Web research tools (ported from E.D.I.T.H. web_search):
 * Gemini grounded Google Search first, keyless fallbacks after
 * (DuckDuckGo HTML results, Google News RSS). A 429 from grounding trips a
 * 15-minute breaker so later searches go straight to the fallbacks.
 * Also: read_webpage, which fetches one public page and returns its text.
 */
import { parse } from 'node-html-parser'
import type { ToolSource } from '../../shared/contract'
import { generateWithFallback } from './gemini'

export type SearchMode = 'search' | 'news' | 'research' | 'price' | 'compare'

export interface SearchResult {
  text: string
  sources: ToolSource[]
  backend: 'google' | 'web' | 'news'
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const SEARCH_MODELS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite']
const QUOTA_COOLDOWN_MS = 15 * 60_000
let quotaBlockedUntil = 0

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function dedupeSources(list: ToolSource[], max = 8) {
  const seen = new Set<string>()
  const out: ToolSource[] = []
  for (const s of list) {
    if (!s.url || seen.has(s.url)) continue
    seen.add(s.url)
    out.push({ title: s.title || host(s.url), url: s.url })
    if (out.length >= max) break
  }
  return out
}

/* ---------------------------------------------------------------- backends */

async function grounded(key: string, prompt: string, signal?: AbortSignal): Promise<SearchResult> {
  if (Date.now() < quotaBlockedUntil) throw new Error('Google Search grounding is cooling down after a quota error')
  try {
    const { res } = await generateWithFallback(
      key,
      {
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          temperature: 0.3,
          systemInstruction: 'You are a precise research assistant. Answer from the search results with concrete facts, numbers and dates. Use short paragraphs or bullet points. No preamble.'
        }
      },
      { timeoutMs: 35_000, models: SEARCH_MODELS, signal }
    )
    const text = (res.text ?? '').trim()
    if (!text) throw new Error('Search returned an empty answer')
    const chunks = res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []
    const sources = dedupeSources(chunks.map((c) => ({ title: c.web?.title ?? '', url: c.web?.uri ?? '' })))
    return { text, sources, backend: 'google' }
  } catch (err) {
    if (/429|RESOURCE_EXHAUSTED|quota/i.test(err instanceof Error ? err.message : String(err))) quotaBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS
    throw err
  }
}

interface WebHit {
  title: string
  snippet: string
  url: string
  source?: string
}

export async function duckDuckGo(query: string, max = 8, signal?: AbortSignal): Promise<WebHit[]> {
  const timeout = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000))
  // Note: DuckDuckGo serves an empty page to requests with an Accept-Language header.
  let r = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: query }).toString(),
    signal: timeout()
  })
  if (r.status !== 200) r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA }, signal: timeout() })
  // 202 = DuckDuckGo's anti-bot challenge page; use Bing's results page instead.
  if (r.status !== 200) return bing(query, max, signal)
  const root = parse(await r.text())
  const hits: WebHit[] = []
  for (const el of root.querySelectorAll('.result')) {
    if (el.classList.contains('result--ad')) continue
    const a = el.querySelector('.result__a')
    if (!a) continue
    let href = a.getAttribute('href') ?? ''
    const uddg = /[?&]uddg=([^&]+)/.exec(href)
    if (uddg) href = decodeURIComponent(uddg[1])
    if (href.startsWith('//')) href = `https:${href}`
    if (!/^https?:\/\//.test(href)) continue
    hits.push({ title: decodeEntities(a.text.trim()), snippet: decodeEntities(el.querySelector('.result__snippet')?.text.trim() ?? ''), url: href })
    if (hits.length >= max) break
  }
  return hits.length ? hits : bing(query, max, signal)
}

export async function bing(query: string, max = 8, signal?: AbortSignal): Promise<WebHit[]> {
  const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`, {
    headers: { 'User-Agent': UA },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000)
  })
  if (!r.ok) throw new Error(`Web search answered ${r.status}`)
  const root = parse(await r.text())
  const hits: WebHit[] = []
  for (const li of root.querySelectorAll('li.b_algo')) {
    const a = li.querySelector('h2 a')
    let href = a?.getAttribute('href') ?? ''
    // Bing wraps links as /ck/a?…&u=a1<base64url>
    const u = /[?&]u=a1([^&]+)/.exec(href)
    if (u) {
      try {
        href = Buffer.from(u[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
      } catch {
        /* keep the wrapped link */
      }
    }
    if (!a || !/^https?:\/\//.test(href)) continue
    const snippet = li.querySelector('.b_caption p') ?? li.querySelector('p')
    hits.push({ title: decodeEntities(a.text.trim()), snippet: decodeEntities(snippet?.text.trim() ?? ''), url: href })
    if (hits.length >= max) break
  }
  return hits
}

export async function googleNews(query: string, max = 8, signal?: AbortSignal): Promise<WebHit[]> {
  const url = query.trim() ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en` : 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en'
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`Google News answered ${r.status}`)
  const xml = await r.text()
  const hits: WebHit[] = []
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1]
    const pick = (tag: string) => decodeEntities((new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(item)?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim())
    const title = pick('title')
    const link = pick('link')
    if (!title || !link) continue
    const date = pick('pubDate')
    hits.push({ title, url: link, snippet: date ? new Date(date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '', source: pick('source') })
    if (hits.length >= max) break
  }
  return hits
}

function formatHits(heading: string, hits: WebHit[]) {
  if (!hits.length) return `No results found (${heading.replace(/^[^:]+:\s*/, '')}). Try different words.`
  return [
    heading,
    ...hits.map((h, i) => `${i + 1}. ${h.title}${h.source ? ` [${h.source}]` : ''}${h.snippet ? `\n   ${h.snippet.slice(0, 220)}` : ''}\n   ${h.url}`)
  ].join('\n')
}

const hitSources = (hits: WebHit[]) => dedupeSources(hits.map((h) => ({ title: h.source || h.title, url: h.url })))

/* ---------------------------------------------------------------- modes */

export async function webSearch(
  key: string | null,
  input: { query: string; mode?: string; items?: string[]; aspect?: string },
  signal?: AbortSignal
): Promise<SearchResult> {
  const query = input.query.trim()
  const items = (input.items ?? []).map((s) => s.trim()).filter(Boolean)
  let mode = (input.mode ?? 'search').toLowerCase() as SearchMode
  if (items.length >= 2) mode = 'compare'
  const aspect = input.aspect?.trim() || 'overall'
  if (!query && !items.length) throw new Error('Tell me what to search for.')

  const prompt =
    mode === 'research'
      ? `Comprehensive, detailed explanation of: ${query}. Include background, key facts, the current state as of today, and important nuances or disagreements.`
      : mode === 'price'
        ? `Current price of ${query} today. List prices from major retailers with currency, and note recent deals.`
        : mode === 'compare'
          ? `Compare ${items.join(', ')} in terms of ${aspect}. Give specific facts and data, then a one-line verdict.`
          : mode === 'news'
            ? `Latest news today about: ${query || 'world events'}. Give the top developments with dates.`
            : query

  // News: the free RSS feed is fast and doesn't spend the grounding quota.
  if (mode === 'news') {
    const hits = await googleNews(query, 8, signal).catch(() => [] as WebHit[])
    if (hits.length >= 3) return { text: formatHits(`Latest news: ${query || 'top stories'}`, hits), sources: hitSources(hits), backend: 'news' }
  }

  if (key) {
    try {
      return await grounded(key, prompt, signal)
    } catch (err) {
      if (signal?.aborted) throw err
    }
  }

  // Google Search unavailable (quota / no key): collect relevant results from keyless sources,
  // read the best pages, then let plain Gemini (separate quota) write the actual answer.
  const queries = mode === 'compare' ? items.map((it) => `${it} ${aspect}`) : [mode === 'price' ? `${query} price` : query]
  const hits = dedupeHits((await Promise.all(queries.map((q) => keylessHits(q, mode === 'research' ? 9 : 7, signal)))).flat()).slice(0, 10)
  const excerpts = await readTopPages(hits, mode === 'research' ? 4 : 3, signal)
  const list = formatHits(`Search results for: ${queries.join(' | ')}`, hits)
  if (key) {
    const answer = await synthesize(key, prompt, hits, excerpts, signal).catch(() => null)
    if (answer) return { text: answer, sources: hitSources(hits), backend: 'web' }
  }
  const text = [list, excerpts.length ? `\nPage excerpts (answer from these):\n${excerpts.join('\n\n')}` : ''].join('\n')
  return { text, sources: hitSources(hits), backend: 'web' }
}

/* ---------------------------------------------------------------- keyless fallback */

const STOP = new Set(
  'the a an and or of in on at for to with without from by is are was be what which who how when where why best top near me my your this that these those do does give find list show tell about some any all latest current new today now news price prices cost good'.split(' ')
)
const terms = (q: string) => [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)))]

/** Share of the query's meaningful words that a result mentions (filters engines that drop words). */
function relevance(q: string, h: WebHit) {
  const t = terms(q)
  if (!t.length) return 1
  const hay = `${h.title} ${h.snippet} ${h.url}`.toLowerCase()
  return t.filter((w) => hay.includes(w) || hay.includes(w.slice(0, Math.max(4, w.length - 2)))).length / t.length
}

function dedupeHits(list: WebHit[]) {
  const seen = new Set<string>()
  return list.filter((h) => !seen.has(h.url) && !!seen.add(h.url))
}

async function wikipedia(query: string, max = 3, signal?: AbortSignal): Promise<WebHit[]> {
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${max}&srsearch=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'ZVYRA/0.1 (personal desktop assistant)' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000)
  })
  if (!r.ok) return []
  const j = (await r.json()) as { query?: { search?: { title: string; snippet: string }[] } }
  return (j.query?.search ?? []).map((s) => ({
    title: `${s.title} — Wikipedia`,
    snippet: decodeEntities(s.snippet.replace(/<[^>]+>/g, '')),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`
  }))
}

async function keylessHits(q: string, max: number, signal?: AbortSignal): Promise<WebHit[]> {
  const [web, wiki, news] = await Promise.all([
    duckDuckGo(q, max, signal).catch(() => [] as WebHit[]),
    wikipedia(q, 3, signal).catch(() => [] as WebHit[]),
    googleNews(q, 5, signal).catch(() => [] as WebHit[])
  ])
  // Short queries need every key word; longer ones most of them.
  const need = terms(q).length <= 2 ? 1 : 0.6
  const ok = (h: WebHit) => relevance(q, h) >= need
  return dedupeHits([...web.filter(ok), ...news.filter(ok), ...wiki.filter(ok)]).slice(0, max)
}

async function synthesize(key: string, request: string, hits: WebHit[], excerpts: string[], signal?: AbortSignal) {
  const sources = hits.map((h, i) => `[${i + 1}] ${h.title} — ${h.url}${h.snippet ? `\n${h.snippet}` : ''}`).join('\n')
  const { res } = await generateWithFallback(
    key,
    {
      contents: `REQUEST: ${request}\n\nSEARCH RESULTS:\n${sources || '(none)'}\n\nPAGE EXCERPTS:\n${excerpts.join('\n\n') || '(none)'}`,
      config: {
        temperature: 0.3,
        maxOutputTokens: 1500,
        systemInstruction:
          'Answer the request directly and concretely (names, numbers, dates). Use the search results and page excerpts first and mention the site names you used. ' +
          'Where they don’t cover it, answer from your own knowledge and say that part is general knowledge that may be out of date. ' +
          'Never answer that nothing was found when you can still give a useful answer. Short paragraphs or bullets, no preamble.'
      }
    },
    { timeoutMs: 30_000, models: ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.5-flash'], signal }
  )
  const text = (res.text ?? '').trim()
  return text || null
}

async function readTopPages(hits: WebHit[], n: number, signal?: AbortSignal): Promise<string[]> {
  const picks = hits.filter((h) => !/youtube\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com/i.test(h.url)).slice(0, n)
  const pages = await Promise.all(
    picks.map((h) =>
      Promise.race([
        readWebpage(h.url, signal)
          .then((p) => `## ${p.title || h.title} (${h.url})\n${p.text.slice(0, 1800)}`)
          .catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 7000))
      ])
    )
  )
  return pages.filter((p): p is string => !!p && p.length > 200)
}

/* ---------------------------------------------------------------- read a page */

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[::1\]|::1$)/i

export async function readWebpage(rawUrl: string, signal?: AbortSignal): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`)
  } catch {
    throw new Error('That isn’t a valid web address.')
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http(s) pages can be read.')
  if (PRIVATE_HOST.test(url.hostname)) throw new Error('For safety ZVYRA only reads public web pages.')
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' },
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
  })
  if (!r.ok) throw new Error(`The site answered ${r.status} ${r.statusText}`)
  const type = r.headers.get('content-type') ?? ''
  if (!/text|html|json|xml/i.test(type)) throw new Error(`That page is ${type || 'binary'}, not text.`)
  const raw = (await r.text()).slice(0, 3_000_000)
  if (!/html/i.test(type)) return { url: r.url, title: url.hostname, text: raw.slice(0, 20_000), truncated: raw.length > 20_000 }
  const root = parse(raw)
  const title = decodeEntities(root.querySelector('title')?.text.trim() ?? url.hostname)
  for (const el of root.querySelectorAll('script, style, noscript, svg, template, iframe, nav, footer, header, form, [aria-hidden="true"]')) el.remove()
  const main = root.querySelector('article') ?? root.querySelector('main') ?? root.querySelector('body') ?? root
  const text = decodeEntities(main.structuredText)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  return { url: r.url, title, text: text.slice(0, 20_000), truncated: text.length > 20_000 }
}
