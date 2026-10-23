/**
 * OWNER: Kiro. Research dossier: merges page extracts into source-attributed
 * facts with confidence and conflicts (pure, unit-tested).
 *
 * Rules:
 *  - every fact keeps the URL(s) and retrieval time it came from,
 *  - a fact stated by the official site's structured data, or by two independent
 *    sites, is "high"; one source is "medium"; a heuristic read is "low",
 *  - disagreeing values are kept side by side as a conflict, never averaged,
 *  - fields nobody stated are listed as unavailable, never filled in.
 */
import type { ImageRef, MenuItem, PageExtract, ProductItem } from './extract'

export type Confidence = 'high' | 'medium' | 'low'

export interface Provenance {
  url: string
  retrievedAt: string
  /** ocr / vision = transcribed from a menu image or PDF; snippet = a search engine's summary of the page. */
  via: 'jsonld' | 'meta' | 'link' | 'html' | 'text' | 'ocr' | 'vision' | 'snippet'
  official: boolean
  /** The menu image/PDF a transcribed item came from (with its page number). */
  document?: string
  page?: number
}

export interface DossierMenuDocument {
  url: string
  pageUrl: string
  kind: 'image' | 'pdf'
  section?: string
  official: boolean
  page?: number
  /** Filled in by the menu reader. */
  read?: { method: string; items: number; at: string } | { error: string; at: string }
  local?: string
}

export interface Fact<T = string> {
  value: T
  sources: Provenance[]
  confidence: Confidence
}

export interface SourceRecord {
  url: string
  title?: string
  retrievedAt: string
  status: 'ok' | 'blocked' | 'login-required' | 'robots-disallowed' | 'error' | 'not-html'
  rendered?: boolean
  official?: boolean
  note?: string
}

export interface DossierImage extends ImageRef {
  pageUrl: string
  retrievedAt: string
  official: boolean
  /** Filled in by the asset downloader. */
  local?: string
  rights: string
}

export interface Dossier {
  version: 1
  query: { name?: string; location?: string; url?: string }
  createdAt: string
  officialWebsite: Fact | null
  name: Fact | null
  category: Fact | null
  description: Fact | null
  phones: Fact[]
  emails: Fact[]
  whatsapp: Fact[]
  addresses: Fact[]
  hours: Fact[]
  socials: Fact<{ platform: string; url: string }>[]
  priceRange: Fact | null
  cuisine: Fact[]
  rating: Fact<{ value: number; count?: number; best?: number }>[]
  menu: (MenuItem & { sources: Provenance[]; confidence: Confidence })[]
  products: (ProductItem & { sources: Provenance[] })[]
  images: DossierImage[]
  /** Menus published as images or PDFs, and whether they could be read. */
  menuDocuments?: DossierMenuDocument[]
  brand: { themeColor?: string; colors: string[]; logo?: string }
  conflicts: { field: string; values: { value: string; sources: string[] }[]; note: string }[]
  unavailable: string[]
  sources: SourceRecord[]
  searchResults: { title: string; url: string; snippet?: string }[]
  /** How the official site was found (or that it wasn't). */
  discovery?: string[]
}

export interface ExtractInput {
  extract: PageExtract
  retrievedAt: string
  official: boolean
  /** Set for synthetic inputs (menu transcriptions, search snippets): how every fact in it was obtained. */
  via?: Provenance['via']
  /** Menu items transcribed from documents, each with the document it came from. */
  documentItems?: (MenuItem & { document: string; page?: number })[]
}

const ID_SEGMENT = /(?:^|[/_-])(\d{5,}|[a-f0-9]{16,})(?=[/_.-]|$)/gi
const idSegments = (u: string) => {
  try {
    return [...new URL(u).pathname.matchAll(ID_SEGMENT)].map((m) => m[1].toLowerCase())
  } catch {
    return []
  }
}

/**
 * Listing pages (Zomato, EazyDiner…) also show photos of other restaurants
 * ("similar places nearby"). Keep a third-party image only when the page's
 * structured data / share image names it, its alt text names the business, or
 * it lives under the same listing id as those images.
 */
export function relevantListingImages(x: PageExtract, businessName?: string): PageExtract['images'] {
  const nameWords = (businessName ?? x.entities.find((e) => e.name)?.name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !/^(the|and|restaurant|kitchen|cafe|bar)$/.test(w))
  const named = (alt?: string) => !!alt && nameWords.length > 0 && nameWords.filter((w) => alt.toLowerCase().includes(w)).length / nameWords.length >= 0.5
  const anchors = x.images.filter((i) => i.role === 'og' || i.role === 'jsonld')
  const ids = new Set(anchors.flatMap((i) => idSegments(i.url)))
  // Ids shared with many unrelated images (a CDN bucket) are not listing ids.
  for (const id of [...ids]) if (x.images.filter((i) => idSegments(i.url).includes(id)).length > 60) ids.delete(id)
  return x.images.filter((i) => {
    if (i.role === 'icon') return false
    if (/\b(?:bank|payment|card|app store|google play|offer|banner|advert)\b/i.test(i.alt ?? '') && !named(i.alt)) return false
    if (i.role === 'og' || i.role === 'jsonld') return true
    if (i.role === 'logo') return named(i.alt)
    return named(i.alt) || idSegments(i.url).some((id) => ids.has(id))
  })
}

/** A phone printed next to the platform's copyright line is the platform's number, not the business's. */
export function platformPhones(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/©|copyright|customer care|helpline|toll[- ]free/gi)) {
    const digits = text.slice(Math.max(0, m.index - 40), m.index + 160).replace(/\D/g, ' ')
    for (const d of digits.match(/\d[\d ]{8,}\d/g) ?? []) {
      const k = d.replace(/\D/g, '')
      if (k.length >= 10) out.add(k.slice(-10))
    }
  }
  return out
}

const domain = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return u
  }
}

/** Same phone written differently (+91 98…, 098…, 98…): compare the last 10 digits. */
export const phoneKey = (p: string) => p.replace(/\D/g, '').slice(-10)
const textKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

function tokens(s: string) {
  return new Set(textKey(s).split(' ').filter((w) => w.length > 1))
}
/** Token overlap of two addresses (0..1, relative to the shorter one). */
export function addressSimilarity(a: string, b: string) {
  const A = tokens(a)
  const B = tokens(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const t of A) if (B.has(t)) hit++
  return hit / Math.min(A.size, B.size)
}

function confidenceOf(sources: Provenance[]): Confidence {
  const domains = new Set(sources.map((s) => domain(s.url)))
  // Machine transcriptions and search summaries are leads, not confirmations.
  const weak = (s: Provenance) => s.via === 'ocr' || s.via === 'vision' || s.via === 'snippet'
  const strong = sources.filter((s) => !weak(s))
  if (!strong.length) return new Set(sources.map((s) => domain(s.url))).size >= 2 && sources.some((s) => s.via !== 'snippet') ? 'medium' : 'low'
  if (strong.some((s) => s.official && (s.via === 'jsonld' || s.via === 'link' || s.via === 'meta'))) return 'high'
  if (domains.size >= 2) return 'high'
  if (strong.every((s) => s.via === 'html' || s.via === 'text')) return 'low'
  return 'medium'
}

class FactSet<T> {
  private map = new Map<string, { value: T; sources: Provenance[] }>()
  constructor(private readonly key: (v: T) => string) {}
  add(value: T | undefined | null, p: Provenance) {
    if (value === undefined || value === null || value === '') return
    const k = this.key(value)
    if (!k) return
    const cur = this.map.get(k)
    if (cur) {
      if (!cur.sources.some((s) => s.url === p.url && s.via === p.via)) cur.sources.push(p)
    } else this.map.set(k, { value, sources: [p] })
  }
  facts(): Fact<T>[] {
    return [...this.map.values()]
      .map((f) => ({ ...f, confidence: confidenceOf(f.sources) }))
      .sort((a, b) => rank(b.confidence) - rank(a.confidence) || b.sources.length - a.sources.length)
  }
}
const rank = (c: Confidence) => (c === 'high' ? 2 : c === 'medium' ? 1 : 0)

function rightsNote(official: boolean, pageUrl: string) {
  return official
    ? `From the business's own website (${domain(pageUrl)}). The business owns the rights: fine for a proposal or mock-up shown to them; get written permission before publishing.`
    : `Hosted on ${domain(pageUrl)}. Rights belong to the business or the platform; do not publish without permission.`
}

export function buildDossier(query: Dossier['query'], inputs: ExtractInput[], sources: SourceRecord[], searchResults: Dossier['searchResults'], now = new Date().toISOString()): Dossier {
  const names = new FactSet<string>(textKey)
  const categories = new FactSet<string>((v) => v.toLowerCase())
  const descriptions = new FactSet<string>(textKey)
  const phones = new FactSet<string>(phoneKey)
  const emails = new FactSet<string>((v) => v.toLowerCase())
  const whatsapp = new FactSet<string>(phoneKey)
  const addresses: { value: string; sources: Provenance[] }[] = []
  const hours = new FactSet<string>(textKey)
  const socials = new FactSet<{ platform: string; url: string }>((v) => v.url.toLowerCase().replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, ''))
  const priceRanges = new FactSet<string>(textKey)
  const cuisine = new FactSet<string>((v) => v.toLowerCase())
  const ratings = new FactSet<{ value: number; count?: number; best?: number }>((v) => `${v.value}|${v.count ?? ''}`)
  const menu = new Map<string, MenuItem & { sources: Provenance[] }>()
  const products = new Map<string, ProductItem & { sources: Provenance[] }>()
  const images: DossierImage[] = []
  const colors = new Map<string, number>()
  let themeColor: string | undefined
  let logo: string | undefined
  let official: Fact | null = null

  // A page often carries the hosting platform's own structured data too (a listing site's
  // Organization/WebSite entity, e.g. "EazyDiner"). When we're researching a named business,
  // the entity whose name matches the query is the subject; the platform's is not.
  const queryWords = query.name ? textKey(query.name).split(' ').filter((w) => w.length > 2 && !/^(the|and|bar|cafe|kitchen|restaurant|pub|club|grill|house|co)$/.test(w)) : []
  const matchesQuery = (value?: string) => {
    if (!value || !queryWords.length) return false
    const hay = textKey(value)
    return queryWords.filter((w) => hay.includes(w)).length / queryWords.length >= 0.5
  }
  const queryNames = new Set<string>()
  const queryDescriptions = new Set<string>()

  const menuDocuments: DossierMenuDocument[] = []
  for (let { extract: x, retrievedAt, official: isOfficial, via: forcedVia, documentItems } of inputs) {
    const p = (via: Provenance['via']): Provenance => ({ url: x.url, retrievedAt, via: forcedVia ?? via, official: isOfficial })
    for (const m of documentItems ?? []) {
      const k = `${textKey(m.name)}|${m.amount ?? ''}|${textKey(m.section ?? '')}`
      const prov: Provenance = { url: x.url, retrievedAt, via: m.via === 'vision' ? 'vision' : 'ocr', official: isOfficial, document: m.document, page: m.page }
      const cur = menu.get(k)
      if (cur) {
        if (!cur.sources.some((s) => s.document === m.document)) cur.sources.push(prov)
      } else menu.set(k, { name: m.name, price: m.price, amount: m.amount, currency: m.currency, description: m.description, section: m.section, via: m.via, sources: [prov] })
    }
    x.menuDocuments.forEach((d, i) => {
      if (!menuDocuments.some((m) => m.url.split('?')[0] === d.url.split('?')[0])) menuDocuments.push({ ...d, pageUrl: x.url, official: isOfficial, page: i + 1 })
    })
    const platform = isOfficial ? new Set<string>() : platformPhones(x.text)
    if (!isOfficial) x = { ...x, images: relevantListingImages(x, query.name), phones: x.phones.filter((ph) => !platform.has(phoneKey(ph))) }
    if (isOfficial && !official) {
      let origin = x.url
      try {
        origin = new URL(x.canonical ?? x.url).origin
      } catch {
        /* keep */
      }
      official = { value: origin, sources: [p('link')], confidence: 'high' }
    }
    for (const e of x.entities) {
      // A local-business entity (Restaurant, Store…) is the subject; a bare Organization/WebSite
      // on a listing site is usually the platform. Don't let the platform's name/description win.
      const platformEntity = !isOfficial && queryWords.length > 0 && /^(Organization|Corporation|WebSite|OnlineBusiness|OnlineStore)$/.test(e.type) && !matchesQuery(e.name)
      names.add(e.name, p('jsonld'))
      if (matchesQuery(e.name)) queryNames.add(textKey(e.name!))
      categories.add(e.type, p('jsonld'))
      if (!platformEntity) {
        descriptions.add(e.description, p('jsonld'))
        if (e.description && matchesQuery(e.name)) queryDescriptions.add(textKey(e.description))
      }
      priceRanges.add(e.priceRange, p('jsonld'))
      for (const c of e.cuisine ?? []) cuisine.add(c, p('jsonld'))
      if (e.rating) ratings.add(e.rating, p('jsonld'))
      for (const h of e.hours ?? []) hours.add(h, p('jsonld'))
      if (e.logo && isOfficial && !logo) logo = e.logo
    }
    if (isOfficial && x.siteName) names.add(x.siteName, p('meta'))
    // The official page title usually carries the brand ("Order food online | Swiggy").
    if (isOfficial && query.name) {
      const seg = x.title.split(/\s[|–—-]\s|\s·\s/).map((s) => s.trim()).find((s) => textKey(s).includes(textKey(query.name!)) && s.length <= 60)
      if (seg) names.add(seg, p('meta'))
    }
    if (isOfficial && x.description) descriptions.add(x.description, p('meta'))
    const ldHours = new Set(x.entities.flatMap((e) => e.hours ?? []))
    for (const h of x.hours) if (!ldHours.has(h)) hours.add(h, p('text'))
    for (const ph of x.phones) phones.add(ph, p(x.entities.some((e) => e.telephone?.includes(ph)) ? 'jsonld' : 'link'))
    for (const em of x.emails) emails.add(em, p('link'))
    for (const w of x.whatsapp) whatsapp.add(w, p('link'))
    for (const s of x.socials) socials.add(s, p('link'))
    for (const a of x.addresses) {
      const via: Provenance['via'] = x.entities.some((e) => e.address === a) ? 'jsonld' : 'html'
      const near = addresses.find((f) => addressSimilarity(f.value, a) >= 0.75)
      if (near) {
        if (!near.sources.some((s) => s.url === x.url)) near.sources.push(p(via))
        if (a.length > near.value.length) near.value = a
      } else addresses.push({ value: a, sources: [p(via)] })
    }
    for (const m of x.menu) {
      const k = `${textKey(m.name)}|${m.amount ?? ''}`
      const cur = menu.get(k)
      if (cur) {
        if (!cur.sources.some((s) => s.url === x.url)) cur.sources.push(p(m.via))
      } else menu.set(k, { ...m, sources: [p(m.via)] })
    }
    for (const pr of x.products) {
      const k = textKey(pr.name)
      if (!products.has(k)) products.set(k, { ...pr, sources: [p('jsonld')] })
    }
    for (const img of x.images) {
      if (images.some((i) => i.url === img.url)) continue
      images.push({ ...img, pageUrl: x.url, retrievedAt, official: isOfficial, rights: rightsNote(isOfficial, x.url) })
    }
    if (isOfficial) {
      themeColor = themeColor ?? x.themeColor
      x.cssColors.forEach((c, i) => colors.set(c, (colors.get(c) ?? 0) + (8 - i)))
      if (!logo) logo = x.images.find((i) => i.role === 'logo')?.url
    }
  }

  const addrFacts: Fact[] = addresses.map((a) => ({ ...a, confidence: confidenceOf(a.sources) }))
  const phoneFacts = phones.facts()
  // When researching a named business, a name/description that matches the query outranks a
  // platform's own (a listing site's Organization name/description applies to the platform).
  const nameFacts = names.facts().sort((a, b) => Number(queryNames.has(textKey(b.value))) - Number(queryNames.has(textKey(a.value))))
  const descFacts = descriptions.facts().sort((a, b) => Number(queryDescriptions.has(textKey(b.value))) - Number(queryDescriptions.has(textKey(a.value))))

  // Conflicts: values that disagree across sources.
  const conflicts: Dossier['conflicts'] = []
  const officialPhones = phoneFacts.filter((f) => f.sources.some((s) => s.official))
  const thirdOnly = phoneFacts.filter((f) => !f.sources.some((s) => s.official))
  if (officialPhones.length && thirdOnly.length) {
    conflicts.push({
      field: 'phone',
      values: [...officialPhones, ...thirdOnly].map((f) => ({ value: f.value, sources: f.sources.map((s) => s.url) })),
      note: 'Third-party listings show numbers the official site does not. Prefer the official number; the others may be outdated or belong to a platform.'
    })
  }
  if (addrFacts.length > 1) {
    conflicts.push({
      field: 'address',
      values: addrFacts.map((f) => ({ value: f.value, sources: f.sources.map((s) => s.url) })),
      note: 'Sources list different addresses (possibly several branches or an old location). Confirm which one applies.'
    })
  }
  const distinctNames = nameFacts.filter((f, i) => !nameFacts.slice(0, i).some((g) => textKey(g.value).includes(textKey(f.value)) || textKey(f.value).includes(textKey(g.value))))
  if (distinctNames.length > 1) {
    conflicts.push({ field: 'name', values: distinctNames.map((f) => ({ value: f.value, sources: f.sources.map((s) => s.url) })), note: 'Sources use different names; check they are the same business.' })
  }
  const ratingFacts = ratings.facts()
  if (ratingFacts.length > 1) {
    conflicts.push({
      field: 'rating',
      values: ratingFacts.map((f) => ({ value: `${f.value.value}${f.value.count ? ` (${f.value.count} reviews)` : ''}`, sources: f.sources.map((s) => s.url) })),
      note: 'Ratings differ by platform and over time; quote them with their source and date.'
    })
  }
  const menuItems = [...menu.values()].map((m) => ({ ...m, confidence: confidenceOf(m.sources) }))
  const priceClash = new Map<string, Set<number>>()
  for (const m of menuItems) if (m.amount !== undefined) priceClash.set(textKey(m.name), (priceClash.get(textKey(m.name)) ?? new Set()).add(m.amount))
  for (const [name, set] of priceClash) {
    if (set.size < 2) continue
    const vals = menuItems.filter((m) => textKey(m.name) === name)
    // Several prices on one page are sizes/variants, not a disagreement.
    if (new Set(vals.flatMap((m) => m.sources.map((s) => s.url))).size < 2) continue
    conflicts.push({ field: `menu price: ${vals[0].name}`, values: vals.map((m) => ({ value: m.price ?? String(m.amount), sources: m.sources.map((s) => s.url) })), note: 'Different prices on different pages (sizes, delivery-app markup or outdated menu).' })
  }

  const dossier: Dossier = {
    version: 1,
    query,
    createdAt: now,
    officialWebsite: official,
    name: nameFacts[0] ?? null,
    category: categories.facts()[0] ?? null,
    description: descFacts[0] ?? null,
    phones: phoneFacts,
    emails: emails.facts(),
    whatsapp: whatsapp.facts(),
    addresses: addrFacts,
    hours: hours.facts(),
    socials: socials.facts(),
    priceRange: priceRanges.facts()[0] ?? null,
    cuisine: cuisine.facts(),
    rating: ratingFacts,
    menu: menuItems,
    products: [...products.values()],
    images: images.sort((a, b) => imageRank(b) - imageRank(a)).slice(0, 80),
    menuDocuments,
    brand: { themeColor, colors: [...colors.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, 6), logo },
    conflicts,
    unavailable: [],
    sources,
    searchResults
  }
  const missing: [string, unknown][] = [
    ['official website', dossier.officialWebsite],
    ['name', dossier.name],
    ['category', dossier.category],
    ['phone', dossier.phones.length],
    ['email', dossier.emails.length],
    ['address', dossier.addresses.length],
    ['opening hours', dossier.hours.length],
    ['menu or products', dossier.menu.length || dossier.products.length],
    ['images', dossier.images.length]
  ]
  dossier.unavailable = missing.filter(([, v]) => !v).map(([k]) => k)
  return dossier
}

/** Completion is about collected evidence, not whether the tool returned. */
export function researchOutcome(d: Dossier) {
  const pagesRead = new Set(d.sources.filter((s) => s.status === 'ok').map((s) => s.url)).size
  const usable = pagesRead > 0 && !!(d.name || d.description || d.phones.length || d.addresses.length || d.menu.length || d.products.length)
  const status = !usable ? 'failed' : d.unavailable.length || d.conflicts.length ? 'partial' : 'complete'
  const docs = d.menuDocuments ?? []
  return {
    ok: usable, status, pagesRead,
    menuItems: d.menu.length,
    menuItemsTranscribed: d.menu.filter((m) => m.via === 'ocr' || m.via === 'vision').length,
    menuDocuments: docs.length,
    menuDocumentsRead: docs.filter((m) => m.read && 'method' in m.read && m.read.items > 0).length,
    imageCandidates: d.images.length,
    imagesDownloaded: d.images.filter((i) => i.local).length,
    missing: d.unavailable,
    error: usable ? undefined : 'No usable business evidence was retrieved. Research is incomplete; do not generate factual business content from this result.'
  }
}

function imageRank(i: DossierImage) {
  const role = { og: 5, jsonld: 4, logo: 3, content: 2, icon: 0 }[i.role]
  const size = (i.width ?? 0) >= 800 ? 2 : (i.width ?? 0) >= 400 ? 1 : 0
  return (i.official ? 10 : 0) + role + size
}

/** Compact, model-friendly summary (facts with sources; no raw page text). */
export function summarizeDossier(d: Dossier, max = { menu: 40, images: 12 }) {
  const f = (x: Fact | null) => (x ? { value: x.value, confidence: x.confidence, sources: [...new Set(x.sources.map((s) => s.url))].slice(0, 3) } : 'unavailable')
  const list = <T>(xs: Fact<T>[], n = 5) => xs.slice(0, n).map((x) => ({ value: x.value, confidence: x.confidence, sources: [...new Set(x.sources.map((s) => s.url))].slice(0, 3) }))
  return {
    outcome: researchOutcome(d),
    name: f(d.name),
    officialWebsite: f(d.officialWebsite),
    category: f(d.category),
    description: f(d.description),
    phones: list(d.phones),
    emails: list(d.emails),
    whatsapp: list(d.whatsapp),
    addresses: list(d.addresses),
    hours: list(d.hours, 10),
    socials: list(d.socials, 8),
    priceRange: f(d.priceRange),
    cuisine: list(d.cuisine),
    rating: list(d.rating),
    menu: {
      count: d.menu.length,
      items: d.menu.slice(0, max.menu).map((m) => ({ name: m.name, price: m.price ?? 'unknown', section: m.section, description: m.description, confidence: m.confidence, via: m.via, source: m.sources[0]?.document ?? m.sources[0]?.url }))
    },
    menuDocuments: (d.menuDocuments ?? []).slice(0, 24).map((m) => ({ url: m.url, kind: m.kind, section: m.section, from: m.pageUrl, read: m.read })),
    products: { count: d.products.length, items: d.products.slice(0, 20).map((p) => ({ name: p.name, price: p.price, source: p.sources[0]?.url })) },
    images: { count: d.images.length, top: d.images.slice(0, max.images).map((i) => ({ url: i.url, alt: i.alt, role: i.role, official: i.official, local: i.local, width: i.width })) },
    brand: d.brand,
    conflicts: d.conflicts,
    unavailable: d.unavailable,
    discovery: d.discovery,
    sources: d.sources.map((s) => ({ url: s.url, status: s.status, official: s.official, note: s.note }))
  }
}
