import { describe, expect, it } from 'vitest'
import { officialScore, researchBusiness } from '../../src/main/research/business'
import { addressSimilarity, buildDossier } from '../../src/main/research/dossier'
import { extractPage, normalizePhone, parsePrice } from '../../src/main/research/extract'
import { parseRobots, robotsAllow, type FetchedPage } from '../../src/main/research/fetcher'

const OFFICIAL = `<!doctype html><html lang="en"><head>
<title>Spice Garden — North Indian Restaurant, Pune</title>
<meta name="description" content="Family-run North Indian kitchen in Koregaon Park since 2009.">
<meta property="og:image" content="/img/hero-dining.jpg"><meta property="og:image:width" content="1600">
<meta name="theme-color" content="#8a1c1c">
<style>:root{--brand:#8a1c1c;--accent:#e0a526} .btn{background:#8a1c1c;color:#ffffff}</style>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Restaurant","name":"Spice Garden","telephone":"+91 98220 12345",
"address":{"@type":"PostalAddress","streetAddress":"12 Lane 5, Koregaon Park","addressLocality":"Pune","postalCode":"411001","addressCountry":"IN"},
"openingHoursSpecification":[{"dayOfWeek":["Monday","Tuesday"],"opens":"12:00","closes":"23:00"}],"servesCuisine":["North Indian","Mughlai"],
"priceRange":"₹₹","sameAs":["https://www.instagram.com/spicegardenpune/"],"logo":"https://spicegarden.example/logo.png",
"hasMenu":{"@type":"Menu","hasMenuSection":[{"@type":"MenuSection","name":"Starters","hasMenuItem":[
{"@type":"MenuItem","name":"Paneer Tikka","description":"Charred cottage cheese, mint chutney","offers":{"@type":"Offer","price":"320","priceCurrency":"INR"}},
{"@type":"MenuItem","name":"Chicken Seekh Kebab","offers":{"@type":"Offer","price":380,"priceCurrency":"INR"}}]}]}}</script>
<script src="/a.js"></script></head><body>
<header><a href="/menu">Our Menu</a> <a href="/contact">Contact</a> <a href="https://wa.me/919822012345">WhatsApp us</a></header>
<main><h1>Spice Garden</h1><p>Slow-cooked curries and tandoor breads.</p>
<img src="/img/dal.jpg" alt="Dal makhani in a copper bowl" width="900" height="600">
<img src="/pixel.gif" width="1" height="1"></main>
<footer><address>12 Lane 5, Koregaon Park, Pune 411001</address> Call us: 098220 12345 · <a href="mailto:hello@spicegarden.example">hello@spicegarden.example</a></footer>
</body></html>`

const MENU_PAGE = `<html><head><title>Menu – Spice Garden</title></head><body><main>
<h2>Desserts</h2><div class="item"><h4>Kulfi</h4><p>Saffron and pistachio. Fruit toppings additional $1.00</p></div>
<h2>Mains</h2><ul>
<li><span>Dal Makhani</span> <span>₹ 290</span><p>Black lentils, butter, cream</p></li>
<li><span>Butter Chicken</span> <span>₹420</span></li>
<li>Free delivery on orders above ₹ 500</li>
</ul><h2>Breads</h2><table><tr><td>Garlic Naan</td><td>Rs. 90</td></tr></table>
</main></body></html>`

const LISTING = `<html><head><title>Spice Garden, Koregaon Park | FoodListings</title>
<script type="application/ld+json">{"@type":"Restaurant","name":"Spice Garden","telephone":"020 2612 0000","address":"Lane 5, Koregaon Park, Pune","aggregateRating":{"ratingValue":4.3,"reviewCount":1280}}</script>
</head><body><main><p>Spice Garden — North Indian, Mughlai.</p></main></body></html>`

describe('page extraction', () => {
  const x = extractPage(OFFICIAL, 'https://spicegarden.example/')
  it('reads business facts from JSON-LD', () => {
    expect(x.entities[0]).toMatchObject({ type: 'Restaurant', name: 'Spice Garden', priceRange: '₹₹', cuisine: ['North Indian', 'Mughlai'] })
    expect(x.entities[0].address).toBe('12 Lane 5, Koregaon Park, Pune, 411001, IN')
    expect(x.hours).toEqual(['Monday, Tuesday 12:00–23:00'])
  })
  it('reads the structured menu with prices and sections', () => {
    expect(x.menu).toHaveLength(2)
    expect(x.menu[0]).toMatchObject({ name: 'Paneer Tikka', amount: 320, currency: 'INR', section: 'Starters', via: 'jsonld' })
    expect(x.menu[1]).toMatchObject({ name: 'Chicken Seekh Kebab', amount: 380 })
  })
  it('collects contacts from links, labelled text and JSON-LD, normalised', () => {
    expect(x.phones).toContain('+919822012345')
    expect(x.phones).toContain('09822012345')
    expect(x.whatsapp).toEqual(['+919822012345'])
    expect(x.emails).toEqual(['hello@spicegarden.example'])
    expect(x.socials[0]).toMatchObject({ platform: 'instagram' })
  })
  it('keeps real images with alt text and drops tracking pixels', () => {
    expect(x.images.find((i) => i.role === 'og')?.url).toBe('https://spicegarden.example/img/hero-dining.jpg')
    expect(x.images.find((i) => i.url.endsWith('dal.jpg'))).toMatchObject({ alt: 'Dal makhani in a copper bowl', width: 900 })
    expect(x.images.some((i) => i.url.endsWith('pixel.gif'))).toBe(false)
  })
  it('captures brand colours declared by the site', () => {
    expect(x.themeColor).toBe('#8a1c1c')
    expect(x.cssColors[0]).toBe('#8a1c1c')
    expect(x.cssColors).not.toContain('#ffffff')
  })
  it('finds internal menu/contact links', () => {
    expect(x.links.map((l) => l.url)).toEqual(expect.arrayContaining(['https://spicegarden.example/menu', 'https://spicegarden.example/contact']))
  })
  it('reads visible menu lines and ignores promotions', () => {
    const m = extractPage(MENU_PAGE, 'https://spicegarden.example/menu').menu
    expect(m.map((i) => [i.name, i.amount, i.section])).toEqual([
      ['Dal Makhani', 290, 'Mains'],
      ['Butter Chicken', 420, 'Mains'],
      ['Garlic Naan', 90, 'Breads']
    ])
    expect(m[0].description).toBe('Black lentils, butter, cream')
    expect(m.every((i) => i.via === 'html')).toBe(true)
  })
  it('flags CAPTCHA and app-shell pages instead of pretending to read them', () => {
    expect(extractPage('<html><body><div class="g-recaptcha"></div>Verify you are human</body></html>', 'https://x.example/').signals.captcha).toBe(true)
    expect(extractPage('<html><body><div id="root"></div><script></script><script></script><script></script></body></html>', 'https://x.example/').signals.jsShell).toBe(true)
  })
})

describe('visible address and hours lines', () => {
  it('reads addresses and opening hours written as plain text', async () => {
    const { textAddresses, textHours } = await import('../../src/main/research/extract')
    const text = 'Visit us\nAddress: 205 E Houston St, New York, NY 10002\nMon - Thu 8am - 10:45pm\nFri 8am – 2:45am\nOpen daily from 8:00 to 23:00\nCall 212 254 2246 for catering'
    expect(textAddresses(text)).toEqual(['205 E Houston St, New York, NY 10002'])
    expect(textAddresses('Find us\n205 E. Houston Street\nNew York, NY 10002\nTickets $5')).toEqual(['205 E. Houston Street, New York, NY 10002'])
    const hours = textHours(text)
    expect(hours.slice(0, 2)).toEqual(['Mon - Thu 8am - 10:45pm', 'Fri 8am – 2:45am'])
    expect(hours.some((h) => /212/.test(h))).toBe(false)
  })
  it('does not treat a contact form with a reCAPTCHA widget as a block page', () => {
    const html = `<html><body><main><h1>Contact</h1><p>${'Write to us about catering, events and shipping. '.repeat(8)}</p><form><div class="g-recaptcha"></div></form></main></body></html>`
    expect(extractPage(html, 'https://x.example/contact').signals.captcha).toBe(false)
  })
})

describe('parsing helpers', () => {
  it('parses prices in common formats', () => {
    expect(parsePrice('Masala Dosa ₹ 1,250.50')).toMatchObject({ amount: 1250.5, currency: 'INR' })
    expect(parsePrice('Latte $4.75')).toMatchObject({ amount: 4.75, currency: 'USD' })
    expect(parsePrice('Thali 250/-')).toMatchObject({ amount: 250, currency: 'INR' })
    expect(parsePrice('Open 12 to 11')).toBeNull()
  })
  it('normalises phones and rejects junk', () => {
    expect(normalizePhone('tel:+91-98220-12345')).toBe('+919822012345')
    expect(normalizePhone('0000000000')).toBeNull()
    expect(normalizePhone('12')).toBeNull()
  })
  it('honours robots.txt groups and longest match', () => {
    const g = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/menu\n\nUser-agent: zvyra-research\nDisallow: /')
    expect(robotsAllow(g, 'zvyra-research', '/menu')).toBe(false)
    expect(robotsAllow(parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/menu'), 'zvyra-research', '/private/menu')).toBe(true)
    expect(robotsAllow(parseRobots('User-agent: *\nDisallow: /private'), 'zvyra-research', '/private/x')).toBe(false)
  })
})

describe('dossier', () => {
  const t = '2026-10-18T10:00:00.000Z'
  const d = buildDossier(
    { name: 'Spice Garden', location: 'Pune' },
    [
      { extract: extractPage(OFFICIAL, 'https://spicegarden.example/'), retrievedAt: t, official: true },
      { extract: extractPage(MENU_PAGE, 'https://spicegarden.example/menu'), retrievedAt: t, official: true },
      { extract: extractPage(LISTING, 'https://foodlistings.example/pune/spice-garden'), retrievedAt: t, official: false }
    ],
    [],
    [],
    t
  )
  it('keeps the source and retrieval time on every fact', () => {
    expect(d.name).toMatchObject({ value: 'Spice Garden', confidence: 'high' })
    expect(d.name!.sources.map((s) => s.url)).toEqual(expect.arrayContaining(['https://spicegarden.example/', 'https://foodlistings.example/pune/spice-garden']))
    for (const m of d.menu) expect(m.sources[0]).toMatchObject({ retrievedAt: t })
  })
  it('merges the same phone written two ways and reports a third-party number as a conflict', () => {
    const official = d.phones.find((p) => p.value.endsWith('9822012345'))!
    expect(official.sources.length).toBeGreaterThanOrEqual(1)
    expect(d.phones.filter((p) => p.value.endsWith('9822012345'))).toHaveLength(1)
    expect(d.conflicts.find((c) => c.field === 'phone')?.values.map((v) => v.value)).toEqual(expect.arrayContaining(['02026120000']))
  })
  it('combines menus and rates confidence by how the item was read', () => {
    expect(d.menu.find((m) => m.name === 'Paneer Tikka')?.confidence).toBe('high')
    expect(d.menu.find((m) => m.name === 'Garlic Naan')?.confidence).toBe('low')
  })
  it('only reports ratings with their source, and lists what is unavailable', () => {
    expect(d.rating[0]).toMatchObject({ value: { value: 4.3, count: 1280 }, confidence: 'medium' })
    expect(d.unavailable).toEqual([])
    const empty = buildDossier({ name: 'Nobody' }, [], [], [], t)
    expect(empty.unavailable).toEqual(expect.arrayContaining(['phone', 'address', 'menu or products', 'images']))
    expect(empty.name).toBeNull()
  })
  it('attaches rights notes to images (official vs third-party)', () => {
    expect(d.images[0].official).toBe(true)
    expect(d.images[0].rights).toMatch(/business's own website/)
  })
  it('treats near-identical addresses as one place', () => {
    expect(addressSimilarity('12 Lane 5, Koregaon Park, Pune 411001', '12 Lane 5, Koregaon Park, Pune, 411001, IN')).toBeGreaterThan(0.75)
  })
})

describe('official site detection', () => {
  it('prefers the business domain over listing sites', () => {
    expect(officialScore('Spice Garden', { url: 'https://spicegarden.example/', title: 'Spice Garden' })).toBeGreaterThan(0.6)
    expect(officialScore('Spice Garden', { url: 'https://www.zomato.com/pune/spice-garden', title: 'Spice Garden, Pune - Zomato' })).toBe(0)
  })
  it('accepts a platform as its own official site ("research Swiggy")', () => {
    expect(officialScore('Swiggy', { url: 'https://www.swiggy.com/', title: 'Swiggy' })).toBeGreaterThan(0.6)
  })
})

describe('research flow (offline, injected search and fetch)', () => {
  const pages: Record<string, string> = {
    'https://spicegarden.example/': OFFICIAL,
    'https://spicegarden.example/menu': MENU_PAGE,
    'https://spicegarden.example/contact': '<html><head><title>Contact</title></head><body><main>Call: +91 98220 12345</main></body></html>'
  }
  const fetchStub = async (url: string): Promise<FetchedPage> => {
    const key = url.replace(/\/$/, '') || url
    const html = pages[url] ?? pages[`${key}/`] ?? pages[key]
    const base = { url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: '2026-10-18T10:00:00.000Z', html: '' }
    if (url.includes('zomato')) return { ...base, status: 403, blocked: 'blocked', note: 'HTTP 403' }
    return html ? { ...base, html } : { ...base, status: 404, blocked: 'error', note: 'HTTP 404' }
  }
  it('finds the official site, follows its menu page, records blocked listings', async () => {
    const r = await researchBusiness(
      { name: 'Spice Garden', location: 'Pune' },
      {
        search: async () => [
          { title: 'Spice Garden, Pune - Zomato', url: 'https://www.zomato.com/pune/spice-garden', snippet: '' },
          { title: 'Spice Garden — North Indian Restaurant', url: 'https://spicegarden.example/', snippet: '' }
        ],
        fetch: fetchStub as never,
        robots: async () => true
      }
    )
    expect(r.dossier.officialWebsite?.value).toBe('https://spicegarden.example')
    expect(r.dossier.menu.map((m) => m.name)).toEqual(expect.arrayContaining(['Paneer Tikka', 'Dal Makhani', 'Garlic Naan']))
    expect(r.dossier.sources.find((s) => s.url.includes('zomato'))?.status).toBe('blocked')
    expect(r.summary.menu.count).toBeGreaterThanOrEqual(5)
  })
})
