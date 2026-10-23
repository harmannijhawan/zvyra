/**
 * OWNER: Kiro. Polite public-page fetching for research.
 *
 *  - identifies itself (ZVYRA-Research token in the user agent) and honours robots.txt,
 *  - public http(s) only (no localhost / private networks),
 *  - size and time limits,
 *  - reports blocks (401/403/429, CAPTCHA, login walls) instead of working around them.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ZVYRA-Research/0.4 (+https://zvyra.org)'
export const RESEARCH_UA = UA
const ROBOTS_TOKEN = 'zvyra-research'

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[::1\]|::1$|\[fc|\[fd|\[fe80)/i

export function publicUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`)
  } catch {
    throw new Error(`Not a valid web address: ${raw}`)
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) pages can be researched.')
  if (PRIVATE_HOST.test(u.hostname)) throw new Error('Research only reads public web pages.')
  return u
}

/* ---------------------------------------------------------------- robots.txt */

interface Rule {
  allow: boolean
  pattern: string
}
interface Group {
  agents: string[]
  rules: Rule[]
}

export function parseRobots(text: string): Group[] {
  const groups: Group[] = []
  let cur: Group | null = null
  let lastAgent = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const i = line.indexOf(':')
    if (!line || i < 0) continue
    const key = line.slice(0, i).trim().toLowerCase()
    const value = line.slice(i + 1).trim()
    if (key === 'user-agent') {
      if (!cur || !lastAgent) groups.push((cur = { agents: [], rules: [] }))
      cur.agents.push(value.toLowerCase())
      lastAgent = true
    } else {
      lastAgent = false
      if ((key === 'allow' || key === 'disallow') && cur && !(key === 'disallow' && value === '')) cur.rules.push({ allow: key === 'allow', pattern: value })
    }
  }
  return groups
}

const toRe = (p: string) => {
  const end = p.endsWith('$')
  return new RegExp('^' + (end ? p.slice(0, -1) : p).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (end ? '$' : ''))
}

export function robotsAllow(groups: Group[], token: string, path: string): boolean {
  const g = groups.find((x) => x.agents.some((a) => a !== '*' && token.includes(a))) ?? groups.find((x) => x.agents.includes('*'))
  if (!g) return true
  let best: Rule | null = null
  for (const r of g.rules) {
    if (!toRe(r.pattern).test(path)) continue
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r
  }
  return best ? best.allow : true
}

const robotsCache = new Map<string, { at: number; groups: Group[] | 'all' | 'none' }>()

export async function robotsAllows(url: string, signal?: AbortSignal): Promise<boolean> {
  const u = new URL(url)
  let e = robotsCache.get(u.origin)
  if (!e || Date.now() - e.at > 6 * 3600_000) {
    let groups: Group[] | 'all' | 'none' = 'all'
    try {
      const r = await fetch(`${u.origin}/robots.txt`, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000) })
      // RFC 9309 §2.3.1: 4xx (including 401/403) means "no robots.txt": no stated restrictions.
      // A WAF that refuses the robots.txt request is not the site asking tools to stay away;
      // the page request itself then reports the block honestly. 5xx = assume complete disallow.
      if (r.ok) groups = /html/i.test(r.headers.get('content-type') ?? '') ? 'all' : parseRobots((await r.text()).slice(0, 500_000))
      else if (r.status >= 500) groups = 'none'
    } catch {
      groups = 'all' // unreachable robots.txt = no stated restrictions
    }
    e = { at: Date.now(), groups }
    robotsCache.set(u.origin, e)
  }
  if (e.groups === 'all') return true
  if (e.groups === 'none') return false
  return robotsAllow(e.groups, ROBOTS_TOKEN, u.pathname + u.search)
}

/* ---------------------------------------------------------------- fetch */

export interface FetchedPage {
  url: string
  finalUrl: string
  status: number
  contentType: string
  html: string
  retrievedAt: string
  /** Why the page could not be used, when it couldn't. */
  blocked?: 'robots-disallowed' | 'blocked' | 'login-required' | 'not-html' | 'error'
  note?: string
}

export async function fetchPage(raw: string, signal?: AbortSignal, opts: { timeoutMs?: number; skipRobots?: boolean } = {}): Promise<FetchedPage> {
  const u = publicUrl(raw)
  const retrievedAt = new Date().toISOString()
  const base = { url: u.href, finalUrl: u.href, status: 0, contentType: '', html: '', retrievedAt }
  if (!opts.skipRobots && !(await robotsAllows(u.href, signal))) return { ...base, blocked: 'robots-disallowed', note: 'The site’s robots.txt asks automated tools not to read this page.' }
  let r: Response
  try {
    r = await fetch(u, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? 15_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 15_000)
    })
  } catch (err) {
    if (signal?.aborted) throw err
    return { ...base, blocked: 'error', note: err instanceof Error ? err.message : String(err) }
  }
  const finalUrl = r.url || u.href
  // The redirect target must be public too.
  try {
    publicUrl(finalUrl)
  } catch {
    return { ...base, finalUrl, status: r.status, blocked: 'error', note: 'Redirected to a non-public address.' }
  }
  const contentType = r.headers.get('content-type') ?? ''
  if (r.status === 401 || r.status === 407) return { ...base, finalUrl, status: r.status, contentType, blocked: 'login-required', note: `HTTP ${r.status}: the site requires signing in.` }
  if (r.status === 403 || r.status === 429 || r.status === 451 || r.status === 503) {
    const waf = /cloudflare/i.test(r.headers.get('server') ?? '') || r.headers.has('cf-ray') ? 'Cloudflare security service' : /akamai/i.test(r.headers.get('server') ?? '') ? 'Akamai security service' : ''
    await r.body?.cancel().catch(() => undefined)
    return { ...base, finalUrl, status: r.status, contentType, blocked: 'blocked', note: `HTTP ${r.status}: ${waf ? `the site's ${waf} blocked this connection` : 'the site refused automated access'}${r.status === 429 ? ' (rate limit)' : ''}. Not retried or bypassed.` }
  }
  if (!r.ok) return { ...base, finalUrl, status: r.status, contentType, blocked: 'error', note: `HTTP ${r.status} ${r.statusText}` }
  if (!/html|xml/i.test(contentType)) return { ...base, finalUrl, status: r.status, contentType, blocked: 'not-html', note: `Not a web page (${contentType || 'unknown type'}).` }
  const html = (await r.text()).slice(0, 4_000_000)
  return { url: u.href, finalUrl, status: r.status, contentType, html, retrievedAt }
}
