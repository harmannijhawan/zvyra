/**
 * OWNER: Kiro. Structured extraction from one public HTML page (pure, unit-tested).
 *
 * Only what the page itself states is extracted: schema.org JSON-LD, meta tags,
 * tel:/mailto:/WhatsApp links, labelled contact lines, menu or price lines,
 * images with their alt text and sizes. Nothing is guessed or filled in.
 */
import { parse, type HTMLElement } from 'node-html-parser'

export interface MenuItem {
  name: string
  price?: string
  /** Numeric amount when the price parses cleanly. */
  amount?: number
  currency?: string
  description?: string
  section?: string
  /** jsonld = stated by the site's structured data; html = read from a visible price line; ocr/vision = transcribed from a menu image or PDF. */
  via: 'jsonld' | 'html' | 'ocr' | 'vision'
}

export interface ProductItem {
  name: string
  price?: string
  amount?: number
  currency?: string
  description?: string
  image?: string
  url?: string
}

export interface ImageRef {
  url: string
  alt?: string
  width?: number
  height?: number
  role: 'og' | 'logo' | 'jsonld' | 'content' | 'icon'
}

export interface BusinessEntity {
  type: string
  name?: string
  description?: string
  telephone?: string[]
  email?: string[]
  address?: string
  geo?: { lat: number; lng: number }
  hours?: string[]
  priceRange?: string
  cuisine?: string[]
  url?: string
  sameAs?: string[]
  logo?: string
  images?: string[]
  rating?: { value: number; count?: number; best?: number }
  menuUrl?: string
  reservations?: string
}

export interface PageSignals {
  captcha: boolean
  loginWall: boolean
  /** The HTML is an app shell (content is rendered by JavaScript). */
  jsShell: boolean
}

export interface PageExtract {
  url: string
  title: string
  description?: string
  siteName?: string
  lang?: string
  canonical?: string
  themeColor?: string
  /** Colours declared in the page's own CSS (custom properties and inline styles), most frequent first. */
  cssColors: string[]
  entities: BusinessEntity[]
  phones: string[]
  emails: string[]
  whatsapp: string[]
  socials: { platform: string; url: string }[]
  addresses: string[]
  hours: string[]
  menu: MenuItem[]
  products: ProductItem[]
  images: ImageRef[]
  /** Menus published as images or PDFs (structured-data menu pages, "menu.pdf" links, images labelled as a menu). */
  menuDocuments: { url: string; kind: 'image' | 'pdf'; section?: string }[]
  links: { url: string; text: string }[]
  text: string
  signals: PageSignals
}

/* ---------------------------------------------------------------- helpers */

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
export function decode(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENT[e.toLowerCase()] ?? m
  })
}

const clean = (s: unknown) => (typeof s === 'string' ? decode(s).replace(/\s+/g, ' ').trim() : '')
const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v])

export function absolute(href: string | undefined, base: string): string | null {
  if (!href) return null
  const h = decode(href.trim())
  if (!h || /^(javascript|data|blob|about):/i.test(h) || h.startsWith('#')) return null
  try {
    return new URL(h, base).href
  } catch {
    return null
  }
}

/** Digits with a leading + when international. Returns null for things that aren't phone numbers. */
export function normalizePhone(raw: string): string | null {
  const s = raw.replace(/^(tel:|callto:)/i, '').replace(/%20/g, ' ').trim()
  const plus = s.startsWith('+') || s.startsWith('00')
  const digits = s.replace(/^00/, '').replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  if (/^(\d)\1+$/.test(digits)) return null
  return plus ? `+${digits}` : digits
}

const CURRENCY: [RegExp, string][] = [
  [/₹|\bRs\.?|\bINR\b/i, 'INR'],
  [/US\$|\bUSD\b/i, 'USD'],
  [/A\$|\bAUD\b/i, 'AUD'],
  [/C\$|\bCAD\b/i, 'CAD'],
  [/€|\bEUR\b/i, 'EUR'],
  [/£|\bGBP\b/i, 'GBP'],
  [/\bAED\b|د\.إ/i, 'AED'],
  [/\bSAR\b/i, 'SAR'],
  [/¥|\bJPY\b/i, 'JPY'],
  [/\$/, 'USD']
]
// A price: currency + amount, or amount + currency code.
const PRICE_RE =
  /(?:(₹|Rs\.?|INR|US\$|A\$|C\$|\$|€|£|AED|SAR|¥|USD|EUR|GBP)\s?(\d{1,3}(?:[,\s]\d{3})+|\d{1,6})(?:[.,](\d{1,2}))?(?!\d))|(?:(?<![\d.])(\d{1,6})(?:[.,](\d{1,2}))?\s?(₹|INR|EUR|AED|SAR|USD|GBP|€|\/-))/i

export function parsePrice(text: string): { price: string; amount?: number; currency?: string; index: number } | null {
  const m = PRICE_RE.exec(text)
  if (!m) return null
  const symbol = m[1] ?? m[6] ?? ''
  const whole = (m[2] ?? m[4] ?? '').replace(/[,\s]/g, '')
  const frac = m[3] ?? m[5]
  const amount = Number(frac ? `${whole}.${frac}` : whole)
  const currency = symbol === '/-' ? 'INR' : CURRENCY.find(([re]) => re.test(symbol))?.[1]
  return { price: m[0].trim(), amount: Number.isFinite(amount) ? amount : undefined, currency, index: m.index }
}

const SOCIAL: [RegExp, string][] = [
  [/(^|\.)instagram\.com$/i, 'instagram'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$/i, 'facebook'],
  [/(^|\.)(x|twitter)\.com$/i, 'x'],
  [/(^|\.)linkedin\.com$/i, 'linkedin'],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i, 'youtube'],
  [/(^|\.)tiktok\.com$/i, 'tiktok'],
  [/(^|\.)pinterest\.[a-z.]+$/i, 'pinterest'],
  [/(^|\.)threads\.net$/i, 'threads']
]

function whatsappNumber(url: string): string | null {
  try {
    const u = new URL(url)
    if (/^(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|chat\.whatsapp\.com|www\.whatsapp\.com)$/i.test(u.hostname) || u.protocol === 'whatsapp:') {
      const n = u.hostname === 'wa.me' ? u.pathname.slice(1) : (u.searchParams.get('phone') ?? '')
      return n ? normalizePhone(n.startsWith('+') ? n : `+${n}`) : null
    }
  } catch {
    /* not a URL */
  }
  return null
}

function postalAddress(a: unknown): string | undefined {
  if (typeof a === 'string') return clean(a) || undefined
  if (!a || typeof a !== 'object') return undefined
  const o = a as Record<string, unknown>
  const country = typeof o['addressCountry'] === 'object' ? (o['addressCountry'] as Record<string, unknown>)['name'] : o['addressCountry']
  const parts = [o['streetAddress'], o['addressLocality'], o['addressRegion'], o['postalCode'], country].map(clean).filter(Boolean)
  return parts.length ? [...new Set(parts)].join(', ') : undefined
}

function hoursOf(o: Record<string, unknown>): string[] {
  const out = arr(o['openingHours'] as string | string[]).map(clean).filter(Boolean)
  for (const s of arr(o['openingHoursSpecification'] as Record<string, unknown> | Record<string, unknown>[])) {
    if (!s || typeof s !== 'object') continue
    const days = arr(s['dayOfWeek'] as string | string[]).map((d) => clean(d).replace(/^https?:\/\/schema\.org\//, ''))
    const opens = clean(s['opens'])
    const closes = clean(s['closes'])
    if (days.length && (opens || closes)) out.push(`${days.join(', ')} ${opens}–${closes}`)
  }
  return out
}

function imageUrls(v: unknown, base: string): string[] {
  return arr(v as unknown[])
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? ((x as Record<string, unknown>)['url'] as string) || ((x as Record<string, unknown>)['contentUrl'] as string) : ''))
    .map((x) => absolute(x, base))
    .filter((x): x is string => !!x)
}

function offerOf(v: unknown): { price?: string; amount?: number; currency?: string } {
  const o = arr(v as Record<string, unknown>[])[0]
  if (!o || typeof o !== 'object') return {}
  const raw = o['price'] ?? o['lowPrice']
  const amount = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() && !isNaN(Number(raw)) ? Number(raw) : undefined
  const currency = clean(o['priceCurrency']) || undefined
  if (amount === undefined && typeof raw !== 'string') return {}
  return { price: amount !== undefined ? `${currency ? `${currency} ` : ''}${amount}` : clean(raw), amount, currency }
}

/* ---------------------------------------------------------------- JSON-LD */

function flattenLd(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const n of node) flattenLd(n, out)
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    if (Array.isArray(o['@graph'])) flattenLd(o['@graph'], out)
    if (o['@type']) out.push(o)
  }
  return out
}

const typesOf = (o: Record<string, unknown>) => arr(o['@type'] as string | string[]).map((t) => String(t).replace(/^https?:\/\/schema\.org\//, ''))

const BUSINESS_TYPES =
  /^(LocalBusiness|Organization|Corporation|Restaurant|FoodEstablishment|CafeOrCoffeeShop|Bakery|BarOrPub|Brewery|Winery|FastFoodRestaurant|IceCreamShop|Store|ClothingStore|JewelryStore|ShoeStore|ElectronicsStore|FurnitureStore|BookStore|GroceryStore|HealthAndBeautyBusiness|BeautySalon|HairSalon|NailSalon|DaySpa|ExerciseGym|SportsActivityLocation|Hotel|LodgingBusiness|Resort|MedicalBusiness|MedicalClinic|Dentist|Physician|LegalService|Attorney|RealEstateAgent|ProfessionalService|AutoDealer|AutoRepair|EducationalOrganization|School|TravelAgency|Florist|HomeAndConstructionBusiness|OnlineBusiness|OnlineStore|NGO|WebSite)$/

function menuFromLd(node: unknown, section: string | undefined, out: MenuItem[], depth = 0) {
  if (depth > 6) return
  for (const n of arr(node as Record<string, unknown>[])) {
    if (!n || typeof n !== 'object') continue
    const t = typesOf(n)
    if (t.includes('MenuItem')) {
      const name = clean(n['name'])
      if (name) out.push({ name, description: clean(n['description']) || undefined, section, via: 'jsonld', ...offerOf(n['offers']) })
    }
    const sec = t.includes('MenuSection') ? clean(n['name']) || section : section
    menuFromLd(n['hasMenuSection'], sec, out, depth + 1)
    menuFromLd(n['hasMenuItem'], sec, out, depth + 1)
    if (t.includes('Menu') || t.includes('Restaurant') || t.includes('FoodEstablishment')) menuFromLd(n['hasMenu'], sec, out, depth + 1)
  }
}

/** Menu pages published as images in structured data (Menu / MenuSection "image"). */
function menuDocsFromLd(node: unknown, section: string | undefined, base: string, out: PageExtract['menuDocuments'], depth = 0) {
  if (depth > 6) return
  for (const n of arr(node as Record<string, unknown>[])) {
    if (!n || typeof n !== 'object') continue
    const t = typesOf(n)
    const sec = t.includes('MenuSection') ? clean(n['name']) || section : section
    if (t.includes('Menu') || t.includes('MenuSection')) {
      for (const u of imageUrls(n['image'], base)) if (!out.some((d) => d.url === u)) out.push({ url: u, kind: /\.pdf(\?|$)/i.test(u) ? 'pdf' : 'image', section: sec })
    }
    menuDocsFromLd(n['hasMenuSection'], sec, base, out, depth + 1)
    if (t.includes('Restaurant') || t.includes('FoodEstablishment') || t.includes('CollectionPage') || t.includes('WebPage')) {
      menuDocsFromLd(n['hasMenu'], sec, base, out, depth + 1)
      menuDocsFromLd(n['mainEntity'], sec, base, out, depth + 1)
    }
  }
}

function fromLd(objs: Record<string, unknown>[], base: string) {
  const entities: BusinessEntity[] = []
  const menu: MenuItem[] = []
  const products: ProductItem[] = []
  const menuDocuments: PageExtract['menuDocuments'] = []
  for (const o of objs) menuDocsFromLd(o, undefined, base, menuDocuments)
  for (const o of objs) {
    const types = typesOf(o)
    if (types.includes('Menu') || types.includes('MenuSection')) menuFromLd(o, undefined, menu)
    if (types.includes('Product')) {
      const name = clean(o['name'])
      if (name) products.push({ name, description: clean(o['description']).slice(0, 400) || undefined, image: imageUrls(o['image'], base)[0], url: absolute(clean(o['url']), base) ?? undefined, ...offerOf(o['offers']) })
    }
    if (types.includes('ItemList')) {
      for (const el of arr(o['itemListElement'] as Record<string, unknown>[])) {
        const item = (el?.['item'] as Record<string, unknown>) ?? el
        if (item && typesOf(item).includes('Product')) {
          const name = clean(item['name'])
          if (name) products.push({ name, image: imageUrls(item['image'], base)[0], url: absolute(clean(item['url']), base) ?? undefined, ...offerOf(item['offers']) })
        }
      }
    }
    const biz = types.find((t) => BUSINESS_TYPES.test(t))
    if (!biz || biz === 'WebSite') continue
    menuFromLd(o['hasMenu'], undefined, menu)
    const rating = o['aggregateRating'] as Record<string, unknown> | undefined
    const geo = o['geo'] as Record<string, unknown> | undefined
    const hasMenu = o['hasMenu'] ?? o['menu']
    entities.push({
      type: biz,
      name: clean(o['name']) || undefined,
      description: clean(o['description']).slice(0, 600) || undefined,
      telephone: arr(o['telephone'] as string | string[]).map((p) => normalizePhone(String(p))).filter((p): p is string => !!p),
      email: arr(o['email'] as string | string[]).map((e) => clean(e).replace(/^mailto:/i, '')).filter((e) => /@/.test(e)),
      address: arr(o['address']).map(postalAddress).find(Boolean),
      geo: geo && Number.isFinite(Number(geo['latitude'])) && Number.isFinite(Number(geo['longitude'])) ? { lat: Number(geo['latitude']), lng: Number(geo['longitude']) } : undefined,
      hours: hoursOf(o),
      priceRange: clean(o['priceRange']) || undefined,
      cuisine: arr(o['servesCuisine'] as string | string[]).map(clean).filter(Boolean),
      url: absolute(clean(o['url']), base) ?? undefined,
      sameAs: arr(o['sameAs'] as string | string[]).map((s) => absolute(String(s), base)).filter((s): s is string => !!s),
      logo: imageUrls(o['logo'], base)[0],
      images: imageUrls(o['image'], base),
      rating:
        rating && Number.isFinite(Number(rating['ratingValue']))
          ? { value: Number(rating['ratingValue']), count: Number.isFinite(Number(rating['reviewCount'] ?? rating['ratingCount'])) ? Number(rating['reviewCount'] ?? rating['ratingCount']) : undefined, best: Number.isFinite(Number(rating['bestRating'])) ? Number(rating['bestRating']) : undefined }
          : undefined,
      menuUrl: typeof hasMenu === 'string' ? (absolute(hasMenu, base) ?? undefined) : undefined,
      reservations: typeof o['acceptsReservations'] === 'string' || typeof o['acceptsReservations'] === 'boolean' ? String(o['acceptsReservations']) : undefined
    })
  }
  return { entities, menu, products, menuDocuments }
}

/* ---------------------------------------------------------------- HTML menu lines */

const NOT_A_DISH = /\b(total|subtotal|tax|gst|vat|delivery|shipping|cart|checkout|min(imum)? order|per person|coupon|discount|off on|save|offer|free|cashback|order above|followers|reviews?)\b|^(starting at|starts at|from|only|price|prices|now|was|sale|regular|each|per|approx\.?)$/i

/** Visible "Dish name …… ₹250" lines (one price per line, short name). */
function menuFromHtml(root: HTMLElement): MenuItem[] {
  const out: MenuItem[] = []
  const seen = new Set<string>()
  let section: string | undefined
  for (const el of root.querySelectorAll('h1, h2, h3, h4, li, tr, p, dt, dd, div, span')) {
    const tag = el.tagName.toLowerCase()
    if (/^h[1-4]$/.test(tag)) {
      const t = clean(el.text)
      if (t && t.length <= 60) section = t
      continue
    }
    // Leaf-ish blocks only: the line itself, not a container of many lines.
    if (el.querySelectorAll('li, tr, p, div').length > 2) continue
    // Keep the block structure: "Name\nDescription\n$9.95" (plain .text glues "NameDescription").
    const lines = decode(el.structuredText)
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    const text = lines.join('\n')
    if (text.length < 4 || text.length > 300) continue
    // Payment promotions have prices too, but are not dishes. Check the whole
    // block because card/offer qualifiers often follow the amount.
    if (/\b(credit card|debit card|bank offer|final payable|minimum spend|transaction|cashback)\b|\d+\s*%\s*off\b|\bflat\s*[₹$£€]\s*\d+.*\boff\b/i.test(text)) continue
    const p = parsePrice(text)
    if (!p) continue
    // Exactly one price in the block.
    if (parsePrice(text.slice(p.index + p.price.length))) continue
    const beforeLines = text.slice(0, p.index).split('\n').map((l) => l.replace(/[.\-–—:|·•\s]+$/, '').trim()).filter(Boolean)
    // "Fruit toppings additional $1.00" is an add-on price, not the item's price.
    if (/\b(add|additional|extra|toppings?|plus|with)\s*[:\-]?\s*$/i.test(text.slice(Math.max(0, p.index - 25), p.index))) continue
    const after = [...beforeLines.slice(1), text.slice(p.index + p.price.length).replace(/^[\s.\-–—:|·•]+/, '').trim()].filter(Boolean).join(' ').trim()
    const name = beforeLines[0] ?? ''
    if (!name || name.length > 80 || name.split(/\s+/).length > 12 || NOT_A_DISH.test(name)) continue
    const key = `${name.toLowerCase()}|${p.amount}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, price: p.price, amount: p.amount, currency: p.currency, description: after && after.length <= 200 ? after : undefined, section, via: 'html' })
    if (out.length >= 300) break
  }
  return out
}

/* ---------------------------------------------------------------- colours */

function cssColors(raw: string): string[] {
  const counts = new Map<string, number>()
  const css = [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n') + [...raw.matchAll(/style="([^"]*)"/gi)].map((m) => m[1]).join(';')
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    let h = m[1].toLowerCase()
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    // Skip greys, black and white: brand colours have saturation.
    if (Math.max(r, g, b) - Math.min(r, g, b) < 28) continue
    counts.set(`#${h}`, (counts.get(`#${h}`) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c)
}

/* ---------------------------------------------------------------- visible address / hours lines */

const STREET = /\b(street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|marg|nagar|chowk|place|pl\.?|square|sq\.?|way|highway|hwy|plaza|sector|block|floor|building|bldg|mall|complex)(?=[\s,.]|$)/i
const POSTCODE = /\b\d{5}(-\d{4})?\b|\b\d{3}\s?\d{3}\b|\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/
const ADDRESS_LABEL = /^(address|location|find us|visit us|our address|located at)\s*[:\-–]?\s*/i

/** Lines that read like a postal address: a street word + a postcode, or a labelled address line. */
export function textAddresses(text: string): string[] {
  const out: string[] = []
  const lines = text.split('\n').map((l) => l.trim())
  for (let i = 0; i < lines.length && out.length < 5; i++) {
    let l = lines[i]
    if (ADDRESS_LABEL.test(l)) {
      l = l.replace(ADDRESS_LABEL, '')
      if (!l) l = (lines[++i] ?? '').replace(ADDRESS_LABEL, '')
      // A label followed by the address on the next one or two lines.
      if (l && !POSTCODE.test(l) && lines[i + 1] && POSTCODE.test(lines[i + 1])) l = `${l}, ${lines[i + 1]}`
      if (l.length >= 10 && l.length <= 180 && /\d/.test(l)) out.push(l)
      continue
    }
    if (l.length < 8 || l.length > 160 || /[@©]|copyright|\$|₹|€|£/i.test(l)) continue
    if (/^\d/.test(l) && STREET.test(l) && POSTCODE.test(l)) out.push(l)
    // "205 E. Houston Street" / "New York, NY 10002" on two lines.
    else if (/^\d{1,5}\s/.test(l) && STREET.test(l) && !POSTCODE.test(l) && lines[i + 1] && POSTCODE.test(lines[i + 1]) && lines[i + 1].length <= 60) out.push(`${l}, ${lines[++i]}`)
  }
  return [...new Set(out)]
}

const DAY = '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|days|\\.)?|daily|every ?day|weekdays|weekends'
const TIME = '\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)?'
const HOURS_RE = new RegExp(`(?:${DAY})(?:\\s*(?:-|–|to|&|,)\\s*(?:${DAY}))*\\s*[:\\-–]?\\s*(?:${TIME}\\s*(?:-|–|to)\\s*${TIME}|open 24 hours|closed)`, 'i')

/** "Mon–Fri 8am–10pm" style lines from the visible page. */
export function textHours(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (l.length < 6 || l.length > 140) continue
    const m = HOURS_RE.exec(l)
    if (m && /\d|24 hours|closed/i.test(m[0])) out.push(m[0].replace(/\s+/g, ' ').trim())
    if (out.length >= 14) break
  }
  return [...new Set(out)]
}

/* ---------------------------------------------------------------- main */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi
const JUNK_EMAIL = /(example\.|sentry|wixpress|domain\.com|email\.com|yourmail|@2x\.|\.png|\.jpg|\.webp|noreply|no-reply)/i
const LABELLED_PHONE = /(?:phone|tel(?:ephone)?|call(?: us)?|mobile|mob|contact|whats\s?app|ph|☎|📞)\s*(?:no\.?|number)?\s*[:.\-]?\s*(\+?\(?\d[\d\s().-]{6,18}\d)/gi

/** An extract with only the given fields (for structured sources such as an encyclopedia API). */
export function emptyExtract(url: string, title: string, patch: Partial<PageExtract> = {}): PageExtract {
  return { url, title, cssColors: [], entities: [], phones: [], emails: [], whatsapp: [], socials: [], addresses: [], hours: [], menu: [], products: [], images: [], menuDocuments: [], links: [], text: '', signals: { captcha: false, loginWall: false, jsShell: false }, ...patch }
}

export function extractPage(html: string, url: string): PageExtract {
  const raw = html.slice(0, 4_000_000)
  const root = parse(raw, { comment: false, blockTextElements: { script: true, style: true, noscript: true, pre: true } })
  const meta = (k: string) =>
    clean(root.querySelector(`meta[property="${k}"]`)?.getAttribute('content') ?? root.querySelector(`meta[name="${k}"]`)?.getAttribute('content') ?? '') || undefined

  // JSON-LD first (before scripts are removed).
  const ld: Record<string, unknown>[] = []
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      flattenLd(JSON.parse(s.text.trim().replace(/^<!--|-->$/g, '')), ld)
    } catch {
      /* malformed JSON-LD is skipped, not repaired */
    }
  }
  const { entities, menu: ldMenu, products, menuDocuments } = fromLd(ld, url)
  const scripts = root.querySelectorAll('script').length

  const phones = new Set<string>()
  const emails = new Set<string>()
  const whatsapp = new Set<string>()
  const socials = new Map<string, { platform: string; url: string }>()
  const links: { url: string; text: string }[] = []
  let host = ''
  try {
    host = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    /* keep empty */
  }
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? ''
    if (/^tel:/i.test(href)) {
      const p = normalizePhone(href)
      if (p) phones.add(p)
      continue
    }
    if (/^mailto:/i.test(href)) {
      const e = decodeURIComponent(href.replace(/^mailto:/i, '').split('?')[0]).trim()
      if (/@/.test(e) && !JUNK_EMAIL.test(e)) emails.add(e.toLowerCase())
      continue
    }
    const abs = absolute(href, url)
    if (!abs) continue
    // "Download our menu (PDF)" links.
    if (/\.pdf(\?|#|$)/i.test(abs) && /menu|food|drinks?|beverage|bar|carte|speisekarte/i.test(`${abs} ${clean(a.text)}`) && !menuDocuments.some((d) => d.url === abs) && menuDocuments.length < 24) {
      menuDocuments.push({ url: abs, kind: 'pdf', section: clean(a.text).slice(0, 40) || undefined })
      continue
    }
    const wa = whatsappNumber(abs)
    if (wa) {
      whatsapp.add(wa)
      continue
    }
    try {
      const u = new URL(abs)
      const social = SOCIAL.find(([re]) => re.test(u.hostname))
      if (social && u.pathname.length > 1 && !/\/(sharer|share|intent|dialog)/i.test(u.pathname)) socials.set(abs.replace(/\/$/, ''), { platform: social[1], url: abs.replace(/\/$/, '') })
      else if (u.hostname.replace(/^www\./, '') === host && links.length < 300) links.push({ url: abs.split('#')[0], text: clean(a.text).slice(0, 80) })
    } catch {
      /* skip */
    }
  }

  // Images (before removing elements).
  const images: ImageRef[] = []
  const addImg = (u: string | null | undefined, role: ImageRef['role'], alt?: string, w?: number, h?: number) => {
    if (!u || images.some((i) => i.url === u)) return
    if (/\.(svg)(\?|$)/i.test(u) && role === 'content') return
    if ((w && w < 40) || (h && h < 40)) return
    images.push({ url: u, role, alt: alt || undefined, width: w || undefined, height: h || undefined })
  }
  addImg(absolute(meta('og:image') ?? meta('og:image:url'), url), 'og', meta('og:image:alt'), Number(meta('og:image:width')) || undefined, Number(meta('og:image:height')) || undefined)
  addImg(absolute(meta('twitter:image'), url), 'og')
  for (const e of entities) {
    addImg(e.logo, 'logo', e.name ? `${e.name} logo` : undefined)
    for (const i of e.images ?? []) addImg(i, 'jsonld', e.name)
  }
  for (const p of products) addImg(p.image, 'jsonld', p.name)
  for (const l of root.querySelectorAll('link[rel~="apple-touch-icon"], link[rel~="icon"]')) addImg(absolute(l.getAttribute('href'), url), 'icon')
  for (const img of root.querySelectorAll('img')) {
    const srcset = img.getAttribute('srcset') ?? img.getAttribute('data-srcset') ?? ''
    const best = srcset
      .split(',')
      .map((s) => s.trim().split(/\s+/))
      .filter((p) => p[0])
      .map(([u, d]) => ({ u, w: Number((d ?? '').replace(/w$/, '')) || 0 }))
      .sort((a, b) => b.w - a.w)[0]
    const src = best?.u ?? img.getAttribute('data-src') ?? img.getAttribute('data-lazy-src') ?? img.getAttribute('src')
    const alt = clean(img.getAttribute('alt'))
    const isLogo = /logo/i.test(`${alt} ${img.getAttribute('class') ?? ''} ${src ?? ''}`)
    const abs = absolute(src ?? undefined, url)
    // An image that is itself a menu page ("Food menu page 2", /menu/menu-03.jpg) is a document to read, not a photo.
    const menuPage = !!abs && ((/\bmenu\b/i.test(alt) && /\b(page|card|menu\s*\d)/i.test(alt)) || /\/menus?\/[^/]*menu[^/]*\.(jpe?g|png|webp)(\?|$)/i.test(abs))
    if (abs && menuPage) {
      if (!menuDocuments.some((d) => d.url.split('?')[0] === abs.split('?')[0]) && menuDocuments.length < 24) menuDocuments.push({ url: abs, kind: 'image' })
      continue
    }
    addImg(abs, isLogo ? 'logo' : 'content', alt, Number(img.getAttribute('width')) || best?.w || undefined, Number(img.getAttribute('height')) || undefined)
    if (images.length >= 120) break
  }

  const htmlMenu = menuFromHtml(root)
  const title = clean(root.querySelector('title')?.text) || meta('og:title') || host
  // A challenge page (Cloudflare/DataDome/PerimeterX), not a contact form that merely has a reCAPTCHA widget.
  const challengeHtml = /challenges\.cloudflare\.com|cf-chl-|captcha-delivery|px-captcha|_Incapsula_Resource|distil_r_captcha/i.test(raw)
  const widgetOnly = /g-recaptcha|hcaptcha|cf-turnstile/i.test(raw)

  // Readable text (contacts in headers/footers are already collected).
  for (const el of root.querySelectorAll('script, style, noscript, svg, template, iframe, [aria-hidden="true"]')) el.remove()
  const readable = (el: HTMLElement) =>
    decode(el.structuredText)
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
  const whole = root.querySelector('body') ?? root
  const main = root.querySelector('main')
  // Contacts live in headers and footers too, so scan the whole page for them.
  const allText = readable(whole)
  const text = main ? readable(main) : allText
  for (const m of allText.matchAll(LABELLED_PHONE)) {
    const p = normalizePhone(m[1])
    if (p) phones.add(p)
  }
  for (const m of allText.match(EMAIL_RE) ?? []) if (!JUNK_EMAIL.test(m)) emails.add(m.toLowerCase())
  for (const e of entities) {
    for (const p of e.telephone ?? []) phones.add(p)
    for (const m of e.email ?? []) emails.add(m.toLowerCase())
    for (const s of e.sameAs ?? []) {
      try {
        const social = SOCIAL.find(([re]) => re.test(new URL(s).hostname))
        if (social) socials.set(s.replace(/\/$/, ''), { platform: social[1], url: s.replace(/\/$/, '') })
      } catch {
        /* skip */
      }
    }
  }
  const addresses = [...new Set([...entities.map((e) => e.address).filter((a): a is string => !!a), ...root.querySelectorAll('address').map((a) => clean(a.text)).filter((a) => a.length > 8 && a.length < 300), ...textAddresses(allText)])]
  const textHrs = textHours(allText)
  const lower = text.toLowerCase()
  const signals: PageSignals = {
    // Text heuristics only on short pages: a real article may mention these words.
    captcha: (challengeHtml && text.length < 3000) || (widgetOnly && text.length < 300) || (text.length < 1500 && /verify you are (a )?human|are you a robot|unusual traffic|press (and|&) hold|access denied|request blocked|attention required/i.test(lower)),
    loginWall: text.length < 2500 && /(log ?in|sign ?in) to (continue|see|view)|please (log|sign) ?in|create an account to continue/i.test(lower),
    jsShell: text.length < 400 && scripts >= 3
  }

  return {
    url,
    title,
    description: meta('description') ?? meta('og:description'),
    siteName: meta('og:site_name'),
    lang: root.querySelector('html')?.getAttribute('lang') ?? undefined,
    canonical: absolute(root.querySelector('link[rel="canonical"]')?.getAttribute('href'), url) ?? undefined,
    themeColor: meta('theme-color'),
    cssColors: cssColors(raw),
    entities,
    phones: [...phones],
    emails: [...emails],
    whatsapp: [...whatsapp],
    socials: [...socials.values()],
    addresses,
    hours: [...new Set([...entities.flatMap((e) => e.hours ?? []), ...textHrs])],
    // Structured menu data wins; visible price lines fill in when there is none.
    menu: ldMenu.length ? ldMenu : htmlMenu,
    products,
    images: images.filter((i) => !menuDocuments.some((d) => d.url.split('?')[0] === i.url.split('?')[0])),
    menuDocuments,
    links,
    text: text.slice(0, 30_000),
    signals
  }
}
