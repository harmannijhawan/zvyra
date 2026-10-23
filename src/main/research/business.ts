/**
 * OWNER: Kiro. "Research this business": finds the official site, reads it and
 * its menu/contact/about pages (rendering JavaScript pages when needed), reads
 * a few public third-party profiles, and builds a source-attributed dossier.
 *
 * Nothing is invented: missing facts are listed as unavailable, blocked pages
 * are recorded as blocked (never bypassed), disagreements become conflicts.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brave, duckDuckGo } from '../tools/research'
import { buildDossier, summarizeDossier, type Dossier, type ExtractInput, type SourceRecord } from './dossier'
import { emptyExtract, extractPage, normalizePhone, type PageExtract } from './extract'
import { fetchPage, publicUrl, robotsAllows } from './fetcher'
import { readMenuDocuments, type MenuReaderDeps } from './menuReader'

export interface ResearchRequest {
  name?: string
  location?: string
  url?: string
  /** Folder to save research/dossier.json in (e.g. the website project). */
  saveTo?: string
  maxPages?: number
}

export interface ResearchDeps {
  /** Renders a JavaScript page (hidden browser). Optional so the flow is testable without Electron. */
  render?: (url: string, signal?: AbortSignal) => Promise<{ html: string; finalUrl: string; title: string }>
  search?: (query: string, max: number, signal?: AbortSignal) => Promise<{ title: string; url: string; snippet: string }[]>
  fetch?: typeof fetchPage
  robots?: (url: string, signal?: AbortSignal) => Promise<boolean>
  /** Candidate official URLs from a search-grounded model (optional; needs the user's key). */
  grounded?: (query: string, signal?: AbortSignal) => Promise<string[]>
  /** Official website from a knowledge base (default: Wikidata). Pass null to skip. */
  knowledge?: ((name: string, signal?: AbortSignal) => Promise<{ url: string; source: string } | null>) | null
  /** Menu image/PDF transcription (default: local OCR + optional vision). Pass null to skip. */
  readMenus?: typeof readMenuDocuments | null
  /** AI transcription of one menu page; optional, needs the user's key. */
  vision?: MenuReaderDeps['vision']
  progress?: (step: string) => void
}

/** Listing sites that publish structured profiles readable without signing in rank first; review sub-pages last. */
export function listingRank(url: string) {
  const h = host(url)
  const site = /eazydiner/.test(h) ? 6 : /district\.in$/.test(h) ? 5 : /magicpin|dineout/.test(h) ? 4 : /zomato|swiggy/.test(h) ? 3 : /tripadvisor|justdial|yelp/.test(h) ? 1 : 2
  return site - (/review|ShowUserReviews|-or\d+-|\/photos?\b/i.test(url) ? 3 : 0)
}

/** A listing's profile page from one of its sub-pages (…/menu, …/reviews, …/about). */
export function listingRoot(url: string) {
  try {
    const u = new URL(url)
    u.hash = ''
    u.search = ''
    u.pathname = u.pathname.replace(/\/(menu|photos?|reviews?|about|info|order|book|gallery|overview)\/?$/i, '') || '/'
    return u.href
  } catch {
    return url
  }
}

/** Phones that search engines show for a listing of this business ("Call: +91 93117 14702"). */
export function snippetFacts(name: string, hits: { title: string; url: string; snippet?: string }[], officialOrigin: string | null): ExtractInput | null {
  const phones = new Set<string>()
  const used: string[] = []
  for (const h of hits) {
    if (!h.snippet || (officialOrigin && host(h.url) === host(officialOrigin))) continue
    if (!words(name).length || words(name).filter((w) => h.title.toLowerCase().includes(w)).length / words(name).length < 0.6) continue
    for (const m of h.snippet.matchAll(/(?:call|phone|tel(?:ephone)?|contact)\s*[:\-]?\s*((?:\+?\d[\d\s()-]{8,16}\d)(?:\s*,\s*\+?\d[\d\s()-]{8,16}\d)*)/gi)) {
      for (const raw of m[1].split(',')) {
        const p = normalizePhone(raw)
        if (p) {
          phones.add(p)
          if (!used.includes(h.url)) used.push(h.url)
        }
      }
    }
  }
  if (!phones.size) return null
  return { extract: emptyExtract(used[0], 'Search engine snippet', { phones: [...phones].slice(0, 3) }), retrievedAt: new Date().toISOString(), official: false, via: 'snippet' }
}

/** Listing / social / map sites: useful as secondary sources, never "the official website". */
export const AGGREGATORS =
  /(^|\.)(district|zomato|swiggy|tripadvisor|yelp|justdial|magicpin|eazydiner|dineout|ubereats|doordash|grubhub|opentable|deliveroo|talabat|foodpanda|google|goo\.gl|maps\.app|facebook|instagram|x|twitter|linkedin|youtube|tiktok|pinterest|wikipedia|wikidata|crunchbase|glassdoor|indeed|ambitionbox|quora|reddit|medium|yellowpages|sulekha|indiamart|tradeindia|booking|agoda|makemytrip|expedia|airbnb|amazon|flipkart|nykaa|myntra|meesho|zaubacorp|tofler|bloomberg|reuters|economictimes|moneycontrol|thehindu|timesofindia|ndtv|bbc|nytimes)\.[a-z.]+$/i

const SUBPAGE = /(menu|food|drink|dishes|cuisine|order|contact|about|story|location|visit|find-us|reach|hours|services|treatments|products|collections|shop|catalog|gallery|pricing|price|team)/i

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}
const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|restaurant|cafe|bar|kitchen|shop|store|official|india|pvt|ltd|limited|inc|llc|company|co)$/.test(w))

/** How likely a search hit is the business's own website (0..1). */
export function officialScore(name: string, hit: { url: string; title: string }) {
  const h = host(hit.url)
  if (!h) return 0
  const nameWords = words(name)
  if (!nameWords.length) return 0
  const hostFlat = h.replace(/[^a-z0-9]/g, '')
  const isAggregator = AGGREGATORS.test(h)
  // The subject itself may be a platform ("research Swiggy").
  if (isAggregator && !nameWords.some((w) => h.split('.')[0] === w)) return 0
  const inHost = nameWords.filter((w) => hostFlat.includes(w)).length / nameWords.length
  const inTitle = nameWords.filter((w) => hit.title.toLowerCase().includes(w)).length / nameWords.length
  const path = (() => {
    try {
      return new URL(hit.url).pathname
    } catch {
      return '/'
    }
  })()
  return Math.min(1, inHost * 0.7 + inTitle * 0.2 + (path.length <= 1 ? 0.1 : 0))
}

/**
 * Keyless engines in turn. An engine "worked" only if its hits mention the query
 * (DuckDuckGo serves challenge pages and Bing serves unrelated results to automated requests).
 */
async function defaultSearch(q: string, max: number, signal?: AbortSignal) {
  const subject = q.replace(/\b(menu|prices|contact|phone|address)\b/gi, ' ')
  for (const engine of [duckDuckGo, brave]) {
    const hits = await engine(q, max, signal).catch(() => [])
    if (relevantHits(subject, hits).length) return hits
    if (signal?.aborted) break
  }
  return []
}

/** Keeps hits that actually mention the business (search engines serve unrelated results to automated requests). */
export function relevantHits<T extends { title: string; url: string; snippet?: string }>(name: string, hits: T[]): T[] {
  const w = words(name)
  if (!w.length) return hits
  return hits.filter((h) => {
    const hay = `${h.title} ${h.url} ${h.snippet ?? ''}`.toLowerCase().replace(/[^a-z0-9\p{L} ]+/gu, '')
    return w.filter((x) => hay.includes(x)).length / w.length >= 0.5
  })
}

const WD_UA = 'ZVYRA-Research/0.4 (+https://zvyra.org)'

/** Official website from Wikidata (property P856), keyless and attributable. */
export async function wikidataWebsite(name: string, signal?: AbortSignal): Promise<{ url: string; source: string } | null> {
  const t = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000))
  const s = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&format=json&limit=3`, { headers: { 'User-Agent': WD_UA }, signal: t() })
  if (!s.ok) return null
  const ids = ((await s.json()) as { search?: { id: string; label?: string }[] }).search?.filter((x) => words(x.label ?? '').some((w) => words(name).includes(w))).map((x) => x.id) ?? []
  if (!ids.length) return null
  const e = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join('|')}&props=claims&format=json`, { headers: { 'User-Agent': WD_UA }, signal: t() })
  if (!e.ok) return null
  const j = (await e.json()) as { entities?: Record<string, { claims?: { P856?: { mainsnak?: { datavalue?: { value?: string } } }[] } }> }
  for (const id of ids) {
    const url = j.entities?.[id]?.claims?.P856?.[0]?.mainsnak?.datavalue?.value
    if (url) return { url, source: `https://www.wikidata.org/wiki/${id}` }
  }
  return null
}

/** Likely domains for a business name (katzsdelicatessen.com, spice-garden.in…), checked by the caller. */
export function domainGuesses(name: string, location = ''): string[] {
  const w = name.toLowerCase().normalize('NFKD').replace(/['’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
  if (!w.length || w.join('').length > 40) return []
  const stems = [...new Set([w.join(''), w.join('-'), w.filter((x) => !/^(the|and|of)$/.test(x)).join('')])]
  const tlds = /india|mumbai|delhi|pune|bengaluru|bangalore|chennai|hyderabad|kolkata|ahmedabad|jaipur|goa/i.test(location) ? ['in', 'co.in', 'com'] : /uk|london|england|manchester/i.test(location) ? ['co.uk', 'com'] : ['com', 'net', 'co']
  return stems.flatMap((s) => tlds.map((t) => `https://${s}.${t}/`)).slice(0, 9)
}

/** Does this URL answer with a page whose title names the business? */
async function confirmSite(url: string, name: string, fetchFn: typeof fetchPage, signal?: AbortSignal): Promise<string | null> {
  try {
    const p = await fetchFn(url, signal, { timeoutMs: 8000 })
    if (p.blocked || !p.html.trim()) return null
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(p.html)?.[1] ?? ''
    const site = /property="og:site_name"\s+content="([^"]*)"/i.exec(p.html)?.[1] ?? ''
    const w = words(name)
    const hay = `${title} ${site}`.toLowerCase().replace(/[^a-z0-9\p{L} ]+/gu, '')
    return w.length && w.filter((x) => hay.includes(x)).length / w.length >= 0.6 ? new URL(p.finalUrl || url).origin : null
  } catch {
    return null
  }
}

export async function researchBusiness(req: ResearchRequest, deps: ResearchDeps = {}, signal?: AbortSignal): Promise<{ dossier: Dossier; path?: string; summary: ReturnType<typeof summarizeDossier> }> {
  const search = deps.search ?? defaultSearch
  const fetchFn = deps.fetch ?? fetchPage
  const robots = deps.robots ?? robotsAllows
  const progress = deps.progress ?? (() => undefined)
  const maxPages = Math.max(3, Math.min(16, req.maxPages ?? 10))
  const name = req.name?.trim() ?? ''
  const where = req.location?.trim() ?? ''
  if (!name && !req.url) throw new Error('Give the business name or its website.')

  const sources: SourceRecord[] = []
  const inputs: ExtractInput[] = []
  const searchResults: Dossier['searchResults'] = []
  const visited = new Set<string>()

  // 1. Search (several angles), unless only a URL was given.
  if (name) {
    const queries = [`${name} ${where}`.trim(), `${name} ${where} menu prices`.trim(), `${name} ${where} contact phone address`.trim()]
    for (const q of queries) {
      if (signal?.aborted) throw new Error('Cancelled')
      progress(`Searching: ${q}`)
      for (const h of relevantHits(name, await search(q, 8, signal).catch(() => []))) if (!searchResults.some((r) => r.url === h.url)) searchResults.push({ title: h.title, url: h.url, snippet: h.snippet })
    }
  }
  const discovery: string[] = [`search: ${searchResults.length} relevant result(s)`]

  // 2. Official site: given URL → best search hit → search-grounded model → Wikidata → likely domains (each confirmed by its page title).
  let officialOrigin: string | null = null
  if (req.url) officialOrigin = publicUrl(req.url).origin
  else {
    const best = searchResults.map((h) => ({ h, s: officialScore(name, h) })).sort((a, b) => b.s - a.s)[0]
    if (best && best.s >= 0.45) officialOrigin = await confirmSite(best.h.url, name, fetchFn, signal)
    if (!officialOrigin && deps.grounded) {
      progress('Looking up the official website')
      const urls = await deps.grounded(`${name} ${where}`.trim(), signal).catch(() => [] as string[])
      if (signal?.aborted) throw new Error('Cancelled')
      // Keep grounded listing candidates for reading; they are not facts yet.
      for (const raw of urls.slice(0, 12)) {
        try {
          const url = publicUrl(raw).href
          if (!searchResults.some((h) => h.url === url)) searchResults.push({ title: name, url, snippet: 'Candidate from grounded search; page evidence required.' })
        } catch { /* Ignore invalid or non-public candidates. */ }
      }
      discovery.push(`grounded search: ${urls.length} candidate URL(s)`)
      for (const u of urls.filter((x) => !AGGREGATORS.test(host(x)) || officialScore(name, { url: x, title: name }) > 0).slice(0, 4)) {
        officialOrigin = await confirmSite(u, name, fetchFn, signal)
        if (officialOrigin) {
          discovery.push(`official site via grounded search: ${officialOrigin}`)
          break
        }
      }
    }
    if (!officialOrigin && deps.knowledge !== null) {
      const kb = await (deps.knowledge ?? wikidataWebsite)(name, signal).catch(() => null)
      if (kb) {
        officialOrigin = await confirmSite(kb.url, name, fetchFn, signal)
        if (officialOrigin) discovery.push(`official site via Wikidata (${kb.source})`)
      }
    }
    if (!officialOrigin) {
      progress('Trying the likely website address')
      const found = (await Promise.all(domainGuesses(name, where).map((u) => confirmSite(u, name, fetchFn, signal)))).find(Boolean)
      if (found) {
        officialOrigin = found
        discovery.push(`official site found by direct navigation: ${found}`)
      }
    }
  }
  if (!officialOrigin && !req.url) discovery.push('no official website could be confirmed')

  let pageLimit = maxPages
  const read = async (url: string, official: boolean): Promise<PageExtract | null> => {
    const key = url.replace(/#.*$/, '').replace(/\/$/, '')
    if (visited.has(key) || visited.size >= pageLimit) return null
    visited.add(key)
    if (signal?.aborted) throw new Error('Cancelled')
    progress(`Reading ${host(url)}${new URL(url).pathname.length > 1 ? new URL(url).pathname.slice(0, 40) : ''}`)
    let page: Awaited<ReturnType<typeof fetchPage>>
    try {
      page = await fetchFn(url, signal)
    } catch (err) {
      if (signal?.aborted) throw err
      sources.push({ url, retrievedAt: new Date().toISOString(), status: 'error', official, note: err instanceof Error ? err.message : String(err) })
      return null
    }
    if (page.blocked) {
      sources.push({ url, retrievedAt: page.retrievedAt, status: page.blocked === 'login-required' ? 'login-required' : page.blocked === 'robots-disallowed' ? 'robots-disallowed' : page.blocked === 'not-html' ? 'not-html' : page.blocked === 'blocked' ? 'blocked' : 'error', official, note: page.note })
      return null
    }
    let x = extractPage(page.html, page.finalUrl)
    let rendered = false
    // App-shell pages: render them (same robots decision already made above).
    if ((x.signals.jsShell || (x.text.length < 800 && !x.entities.length)) && deps.render && !x.signals.captcha) {
      try {
        const r = await deps.render(page.finalUrl, signal)
        const rx = extractPage(r.html, r.finalUrl)
        if (rx.text.length > x.text.length) {
          x = rx
          rendered = true
        }
      } catch (err) {
        if (signal?.aborted) throw err
        sources.push({ url, retrievedAt: page.retrievedAt, status: 'error', official, note: `Rendering failed: ${err instanceof Error ? err.message : String(err)}` })
      }
    }
    if (x.signals.captcha || x.signals.loginWall) {
      sources.push({ url: page.finalUrl, title: x.title, retrievedAt: page.retrievedAt, status: x.signals.captcha ? 'blocked' : 'login-required', official, rendered, note: x.signals.captcha ? 'The site showed a human-verification (CAPTCHA) page. Not bypassed.' : 'The content is behind a sign-in. Not bypassed.' })
      return null
    }
    if (x.signals.jsShell || (!x.text.trim() && !x.entities.length)) {
      sources.push({ url: page.finalUrl, title: x.title, retrievedAt: page.retrievedAt, status: 'error', official, rendered, note: 'No readable content; the page is empty or its JavaScript did not render.' })
      return null
    }
    sources.push({ url: page.finalUrl, title: x.title, retrievedAt: page.retrievedAt, status: 'ok', official, rendered })
    inputs.push({ extract: x, retrievedAt: page.retrievedAt, official })
    return x
  }

  if (officialOrigin) {
    const suppliedListing = !!req.url && AGGREGATORS.test(host(req.url)) && officialScore(name, { url: req.url, title: name }) === 0
    const home = await read(req.url ? publicUrl(req.url).href : officialOrigin, !suppliedListing)
    if (home) {
      // Follow the site's own menu / contact / about / products pages, and a JSON-LD menu URL.
      const candidates = [
        ...home.entities.map((e) => e.menuUrl).filter((u): u is string => !!u),
        ...home.links.filter((l) => SUBPAGE.test(`${l.url} ${l.text}`)).map((l) => l.url)
      ]
      const ranked = [...new Set(candidates)].sort((a, b) => (/(menu|food|products|services|pricing)/i.test(b) ? 1 : 0) - (/(menu|food|products|services|pricing)/i.test(a) ? 1 : 0))
      for (const u of ranked.slice(0, Math.max(2, maxPages - 4))) {
        if (host(u) !== host(home.url)) continue
        await read(u, !suppliedListing)
      }
    }
  }

  // 3. Public third-party profiles (listing sites often block automated reading; that is recorded).
  //    One page per listing site, its own profile page first (not review sub-pages), menus before reviews.
  const seenHosts = new Set<string>()
  const third = searchResults
    .filter((h) => host(h.url) && (!officialOrigin || host(h.url) !== host(officialOrigin)) && words(name).some((w) => `${h.title} ${h.url}`.toLowerCase().includes(w)))
    .sort((a, b) => listingRank(b.url) - listingRank(a.url))
    .filter((h) => {
      const k = host(h.url)
      if (seenHosts.has(k)) return false
      seenHosts.add(k)
      return true
    })
  // Listings get their own small budget so a large official site can't crowd them out.
  pageLimit = Math.max(maxPages, visited.size + 8)
  for (const h of third.slice(0, 6)) {
    if (signal?.aborted) throw new Error('Cancelled')
    if (visited.size >= pageLimit) break
    // Encyclopedia articles: use the public summary API (structured, attribution-friendly).
    const wiki = /^https:\/\/([a-z]{2,3})\.wikipedia\.org\/wiki\/([^?#]+)/.exec(h.url)
    if (wiki) {
      visited.add(h.url)
      const retrievedAt = new Date().toISOString()
      try {
        const r = await fetch(`https://${wiki[1]}.wikipedia.org/api/rest_v1/page/summary/${wiki[2]}`, { headers: { 'User-Agent': 'ZVYRA-Research/0.4 (+https://zvyra.org)' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = (await r.json()) as { title?: string; extract?: string; description?: string; thumbnail?: { source?: string; width?: number; height?: number } }
        const x = emptyExtract(h.url, j.title ?? h.title, {
          entities: [{ type: 'Organization', name: j.title, description: j.extract?.slice(0, 600) }],
          text: j.extract ?? ''
        })
        sources.push({ url: h.url, title: j.title, retrievedAt, status: 'ok', official: false, note: 'Wikipedia summary API (CC BY-SA)' })
        inputs.push({ extract: x, retrievedAt, official: false })
      } catch (err) {
        sources.push({ url: h.url, retrievedAt, status: 'error', official: false, note: err instanceof Error ? err.message : String(err) })
      }
      continue
    }
    const profile = listingRoot(h.url)
    if (!(await robots(profile, signal).catch(() => false))) {
      sources.push({ url: profile, title: h.title, retrievedAt: new Date().toISOString(), status: 'robots-disallowed', official: false, note: 'robots.txt disallows automated reading.' })
      continue
    }
    const page = await read(profile, false)
    if (!page) continue
    // The listing's own menu / photos pages (same site, under the same profile path).
    const base = new URL(page.url).pathname.replace(/\/$/, '')
    const follow = [
      ...page.entities.map((e) => e.menuUrl).filter((u): u is string => !!u),
      ...page.links.map((l) => l.url).filter((u) => {
        try {
          const p = new URL(u).pathname
          return base.length > 1 && p.startsWith(`${base}/`) && /\/(menu|photos?|gallery)\/?$/i.test(p)
        } catch {
          return false
        }
      })
    ]
    for (const u of [...new Set(follow)].filter((u) => host(u) === host(page.url)).slice(0, 2)) await read(u, false)
  }

  // 4. Search engines summarise listings they can read and we can't (e.g. a phone shown on a blocked
  //    listing). Kept as low-confidence "search snippet" facts with the listing URL, never as confirmed.
  const snippetInput = snippetFacts(name, searchResults, officialOrigin)
  if (snippetInput) inputs.push(snippetInput)

  // 5. Menus published only as images/PDFs: transcribe them (local OCR, optional AI vision).
  let dossier = buildDossier({ name: name || undefined, location: where || undefined, url: req.url }, inputs, sources, searchResults.slice(0, 20))
  const docs = dossier.menuDocuments ?? []
  const readMenus = deps.readMenus === null ? null : (deps.readMenus ?? readMenuDocuments)
  if (readMenus && docs.length && dossier.menu.filter((m) => m.price).length < 8) {
    if (signal?.aborted) throw new Error('Cancelled')
    progress(`Reading ${docs.length} menu page(s) published as images/PDF`)
    const keepDir = req.saveTo ? join(req.saveTo, 'assets', 'menu') : undefined
    try {
      // Official documents first, then the listing's; one listing's set is enough.
      const ordered = [...docs].sort((a, b) => Number(b.official) - Number(a.official))
      const first = ordered[0]
      const chosen = ordered.filter((d) => d.official === first.official && (d.official || d.pageUrl === first.pageUrl))
      const r = await readMenus(chosen, { businessName: name || dossier.name?.value, currency: /india|delhi|mumbai|bengaluru|bangalore|pune|chennai|hyderabad|kolkata/i.test(where) ? 'INR' : undefined, keepDir, signal }, { vision: deps.vision, progress })
      const at = new Date().toISOString()
      for (const d of docs) {
        const ok = r.read.find((x) => x.url === d.url)
        const bad = r.failed.find((x) => x.url === d.url)
        if (ok) {
          d.read = { method: ok.method, items: ok.items, at }
          if (ok.local && req.saveTo) d.local = `assets/menu/${ok.local.split(/[\\/]/).pop()}`
        } else if (bad) d.read = { error: bad.reason, at }
      }
      if (r.items.length) {
        const byPage = new Map<string, typeof r.items>()
        for (const it of r.items) byPage.set(it.document, [...(byPage.get(it.document) ?? []), it])
        for (const d of chosen) {
          const its = byPage.get(d.url)
          if (its?.length) inputs.push({ extract: emptyExtract(d.pageUrl, `Menu page ${d.page ?? ''}`.trim()), retrievedAt: at, official: d.official, documentItems: its })
        }
        discovery.push(`menu documents: ${r.read.filter((x) => x.items).length}/${chosen.length} page(s) transcribed (${[...new Set(r.read.map((x) => x.method))].join(', ')}), ${r.items.length} item(s)`)
      } else discovery.push(`menu documents: ${chosen.length} found, none could be transcribed${r.failed[0] ? ` (${r.failed[0].reason})` : ''}`)
      const keep = docs
      dossier = buildDossier({ name: name || undefined, location: where || undefined, url: req.url }, inputs, sources, searchResults.slice(0, 20))
      dossier.menuDocuments = keep
    } catch (err) {
      if (signal?.aborted) throw err
      discovery.push(`menu documents: reading failed (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  if (signal?.aborted) throw new Error('Cancelled')
  dossier.discovery = discovery
  let path: string | undefined
  if (req.saveTo) {
    const dir = join(req.saveTo, 'research')
    await mkdir(dir, { recursive: true })
    path = join(dir, 'dossier.json')
    await writeFile(path, JSON.stringify(dossier, null, 2), 'utf8')
  }
  return { dossier, path, summary: summarizeDossier(dossier) }
}
