import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { researchOutcome, type Dossier, type DossierImage, type DossierMenuDocument, type Fact } from '../research/dossier'
import type { MenuItem } from '../research/extract'

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const safeUrl = (s: string) => (/^https?:\/\//i.test(s) ? esc(s) : '')
const local = (s?: string) => (s && /^assets\/(images|menu)\/[a-z0-9_.-]+$/i.test(s) ? esc(s) : '')
const sourced = (f: Fact | null | undefined) => (f?.sources.length ? f.value : '')

type DossierMenu = Dossier['menu'][number]

/** Groups the opening hours into a human line, merging a midnight split (12:00–23:59 + 00:00–01:00). */
function summarizeHours(hours: Fact[]): string {
  const vals = hours.filter((f) => f.sources.length).map((f) => f.value)
  if (!vals.length) return ''
  // "Monday 12:00–23:59" style → collect the time ranges per day.
  const dayRe = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i
  const times = new Set<string>()
  let allDays = true
  for (const v of vals) {
    if (!dayRe.test(v)) allDays = false
    const m = v.match(/(\d{1,2}:\d{2})\s*[–\-to]+\s*(\d{1,2}:\d{2})/)
    if (m) times.add(`${m[1]}–${m[2]}`)
  }
  // The common listing pattern: open 12:00 to just before midnight, every day.
  const has = (t: string) => [...times].some((x) => x.replace(/\s/g, '') === t)
  if (allDays && vals.length >= 6 && (has('12:00–23:59') || (has('12:00–23:59') && has('00:00–01:00')))) {
    return 'Daily · 12:00 PM – 11:59 PM'
  }
  if (allDays && vals.length >= 6 && times.size === 1) return `Daily · ${[...times][0].replace(/:00/g, '')}`
  return ''
}

/** Formats an ISO-ish hours value ("Monday 12:00–23:59") into readable text. */
const niceHour = (v: string) =>
  v
    .replace(/(\d{1,2}):(\d{2})/g, (_m, h: string, mm: string) => {
      const n = Number(h)
      const ampm = n >= 12 ? 'PM' : 'AM'
      const h12 = n % 12 === 0 ? 12 : n % 12
      return `${h12}:${mm} ${ampm}`
    })
    .replace('23:59 PM', '11:59 PM')

function priceLabel(m: Pick<MenuItem, 'price'>) {
  return m.price && m.price.trim() ? m.price : 'Price unclear in scan'
}

/** A premium, restaurant-grade website built only from the saved dossier. */
export function businessSiteHtml(d: Dossier) {
  if (!researchOutcome(d).ok || !sourced(d.name)) throw new Error('Cannot build a business website without a sourced business identity. Retry research or supply source documents.')
  const name = sourced(d.name)
  const description = sourced(d.description)
  const category = sourced(d.category)
  const cuisine = d.cuisine.filter((f) => f.sources.length).map((f) => f.value).slice(0, 8)

  // Photos: real, downloaded, not logos/icons. The widest first for the hero.
  const photos: DossierImage[] = d.images
    .filter((i) => local(i.local) && !['logo', 'icon'].includes(i.role))
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
  const hero = photos[0]
  const gallery = photos.slice(1, 9)

  // Menu, grouped by section, dropping empties. Transcribed and structured items both.
  const menuItems = d.menu.filter((m) => m.sources.length && m.name && m.name.length <= 80)
  const sections = new Map<string, DossierMenu[]>()
  for (const m of menuItems) {
    const sec = (m.section ?? 'Menu').trim() || 'Menu'
    sections.set(sec, [...(sections.get(sec) ?? []), m])
  }
  const sectionList = [...sections.entries()]
  const transcribed = menuItems.some((m) => m.via === 'ocr' || m.via === 'vision')
  const menuPages: DossierMenuDocument[] = (d.menuDocuments ?? []).filter((m) => local(m.local))

  // Contact: a sourced phone becomes a call CTA. A snippet-only number is flagged unverified.
  const phone = d.phones.find((f) => f.sources.length && /\d/.test(f.value))
  const phoneUnverified = phone ? phone.sources.every((s) => s.via === 'snippet') || phone.confidence === 'low' : false
  const site = d.officialWebsite && safeUrl(d.officialWebsite.value)
  const address = d.addresses.filter((f) => f.sources.length).sort((a, b) => b.value.length - a.value.length)[0]
  const directions = address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address.value)}` : ''
  const booking = d.sources.find((s) => s.status === 'ok' && !s.official)?.url
  const rating = d.rating.find((f) => f.sources.length)
  const priceRange = sourced(d.priceRange)
  const hoursLine = summarizeHours(d.hours)
  const hourRows = d.hours.filter((f) => f.sources.length).map((f) => niceHour(f.value))

  const telHref = phone ? `tel:${esc(phone.value.replace(/[^+\d]/g, ''))}` : ''
  const primaryCta = phone
    ? `<a class="btn btn-primary" href="${telHref}">Call to reserve</a>`
    : booking
      ? `<a class="btn btn-primary" href="${safeUrl(booking)}" target="_blank" rel="noopener">Book a table</a>`
      : site
        ? `<a class="btn btn-primary" href="${site}" target="_blank" rel="noopener">Visit website</a>`
        : '<a class="btn btn-primary" href="#visit">Plan your visit</a>'

  const figure = (i: DossierImage, cls = '') =>
    `<figure class="${cls}"><img src="${local(i.local)}" alt="${esc(i.alt || `${name} — photograph`)}" loading="lazy" width="${i.width || 1200}" height="${i.height || 800}"></figure>`

  // schema.org, built only from verified facts.
  const ld: Record<string, unknown> = { '@context': 'https://schema.org', '@type': 'Restaurant', name }
  if (description) ld.description = description
  if (address) ld.address = address.value
  if (cuisine.length) ld.servesCuisine = cuisine
  if (priceRange) ld.priceRange = priceRange
  if (phone && !phoneUnverified) ld.telephone = phone.value
  if (site) ld.url = d.officialWebsite!.value
  if (rating) ld.aggregateRating = { '@type': 'AggregateRating', ratingValue: rating.value.value, reviewCount: rating.value.count, bestRating: rating.value.best }
  if (hero) ld.image = hero.local

  const okSources = d.sources.filter((s) => s.status === 'ok')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}${category ? ` · ${esc(category)}` : ''}</title>
<meta name="description" content="${esc(description || `${name}${address ? ` — ${address.value}` : ''}`)}">
${hero ? `<meta property="og:image" content="${local(hero.local)}">` : ''}
<meta property="og:title" content="${esc(name)}"><meta property="og:type" content="restaurant">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}</script>
<style>
:root{color-scheme:dark;--bg:#13100d;--panel:#1b1713;--ink:#f4ece0;--muted:#b7aa98;--line:#352d24;--brass:#c79a4b;--brass-2:#e3bd74;--serif:"Cormorant Garamond",Georgia,serif;--sans:"Inter",system-ui,sans-serif}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.65;-webkit-font-smoothing:antialiased;overflow-x:hidden}
img{display:block;max-width:100%;height:auto}
a{color:inherit}
h1,h2,h3{font-family:var(--serif);font-weight:500;line-height:1.05;margin:0}
h1{font-size:clamp(2.6rem,7vw,5.4rem);letter-spacing:-.01em}
h2{font-size:clamp(2rem,4.2vw,3.2rem)}
h3{font-size:1.3rem}
.eyebrow{font-family:var(--sans);text-transform:uppercase;letter-spacing:.26em;font-size:.72rem;font-weight:600;color:var(--brass-2)}
.wrap{width:min(1180px,100% - 44px);margin-inline:auto}
.btn{display:inline-flex;align-items:center;gap:10px;padding:14px 26px;border-radius:999px;font-weight:600;font-size:.92rem;text-decoration:none;border:1px solid var(--brass);transition:transform .15s ease,background .15s ease}
.btn:focus-visible{outline:3px solid var(--brass-2);outline-offset:3px}
.btn-primary{background:var(--brass);color:#1a1409}.btn-primary:hover{background:var(--brass-2);transform:translateY(-1px)}
.btn-ghost{background:transparent;color:var(--ink)}.btn-ghost:hover{background:rgba(199,154,75,.14)}
header.site{position:sticky;top:0;z-index:40;background:rgba(19,16,13,.82);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-block:16px}
.logo{font-family:var(--serif);font-size:1.5rem;font-weight:600;letter-spacing:.01em;text-decoration:none;white-space:nowrap}
nav.main{display:flex;gap:24px;align-items:center}
nav.main a{font-size:.86rem;font-weight:500;color:var(--muted);text-decoration:none}nav.main a:hover{color:var(--ink)}
.hero{position:relative;min-height:min(88vh,760px);display:flex;align-items:flex-end;isolation:isolate}
.hero .bg{position:absolute;inset:0;z-index:-2}
.hero .bg img{width:100%;height:100%;object-fit:cover}
.hero::after{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(10,8,6,.35) 0%,rgba(10,8,6,.55) 45%,rgba(10,8,6,.92) 100%)}
.hero .wrap{padding-block:72px 64px;max-width:900px}
.hero h1{margin:16px 0 18px;max-width:14ch}
.hero p.lead{color:#e8dcc9;font-size:clamp(1.05rem,2vw,1.3rem);max-width:54ch;margin:0 0 30px}
.hero .ctas{display:flex;gap:14px;flex-wrap:wrap}
.meta-strip{display:flex;flex-wrap:wrap;gap:10px 28px;margin-top:30px;font-size:.9rem;color:var(--muted)}
.meta-strip b{color:var(--ink);font-weight:600}
section{padding-block:clamp(56px,9vw,104px)}
.section-head{max-width:60ch;margin-bottom:44px}
.section-head h2{margin:12px 0}
.section-head p{color:var(--muted);margin:0}
.about{display:grid;grid-template-columns:1.1fr .9fr;gap:56px;align-items:center}
.about figure{margin:0;border-radius:14px;overflow:hidden;border:1px solid var(--line)}
.about figure img{aspect-ratio:4/5;object-fit:cover;width:100%}
.chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.chip{border:1px solid var(--line);border-radius:999px;padding:7px 15px;font-size:.82rem;color:var(--muted)}
.menu-nav{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:36px}
.menu-nav a{border:1px solid var(--line);border-radius:999px;padding:8px 16px;font-size:.84rem;color:var(--muted);text-decoration:none}
.menu-nav a:hover{border-color:var(--brass);color:var(--ink)}
.menu-section{margin-bottom:52px;scroll-margin-top:90px}
.menu-section h3{font-size:1.7rem;color:var(--brass-2);border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:8px}
.menu-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 56px}
.dish{display:flex;justify-content:space-between;gap:20px;align-items:baseline;padding:16px 0;border-bottom:1px dashed var(--line)}
.dish .d-name{font-weight:500}
.dish .d-desc{color:var(--muted);font-size:.86rem;margin-top:3px}
.dish .d-price{font-family:var(--serif);font-size:1.2rem;color:var(--brass-2);white-space:nowrap}
.dish .d-price.unknown{font-family:var(--sans);font-size:.76rem;color:var(--muted);font-style:italic}
.menu-note{margin-top:8px;color:var(--muted);font-size:.86rem}
.menu-note a{color:var(--brass-2)}
.scan-links{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.scan-links a{font-size:.8rem;border:1px solid var(--line);border-radius:8px;padding:6px 12px;color:var(--muted);text-decoration:none}.scan-links a:hover{color:var(--ink);border-color:var(--brass)}
.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.gallery figure{margin:0;border-radius:12px;overflow:hidden;border:1px solid var(--line)}
.gallery figure img{aspect-ratio:4/3;object-fit:cover;width:100%}
.visit{display:grid;grid-template-columns:1fr 1fr;gap:48px}
.visit .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px}
.visit h3{margin-bottom:14px}
.visit p{margin:6px 0;color:var(--muted)}.visit p b{color:var(--ink);font-weight:600}
.hours-list{list-style:none;padding:0;margin:8px 0 0}
.hours-list li{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--line);font-size:.9rem;color:var(--muted)}
.unverified{font-size:.76rem;color:var(--brass-2);font-style:italic;display:block;margin-top:4px}
footer.site{border-top:1px solid var(--line);padding-block:40px;color:var(--muted);font-size:.82rem;background:var(--panel)}
footer.site a{color:var(--muted)}
footer.site .sources{margin:14px 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:8px 18px}
.credit{margin-top:18px;font-size:.76rem;opacity:.8}
@media(max-width:860px){.about,.visit{grid-template-columns:1fr;gap:28px}.gallery{grid-template-columns:1fr 1fr}.menu-grid{grid-template-columns:1fr}nav.main{display:none}}
@media(max-width:480px){.gallery{grid-template-columns:1fr}.hero .wrap{padding-block:48px 44px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.btn{transition:none}}
</style></head>
<body>
<header class="site"><div class="wrap"><a class="logo" href="#top">${esc(name)}</a><nav class="main" aria-label="Primary">${sectionList.length ? '<a href="#menu">Menu</a>' : ''}${gallery.length ? '<a href="#gallery">Gallery</a>' : ''}<a href="#visit">Visit</a></nav>${phone ? `<a class="btn btn-ghost" href="${telHref}">Reserve</a>` : booking ? `<a class="btn btn-ghost" href="${safeUrl(booking)}" target="_blank" rel="noopener">Reserve</a>` : ''}</div></header>
<main id="top">
<section class="hero">${hero ? `<div class="bg">${`<img src="${local(hero.local)}" alt="${esc(hero.alt || `${name} interior`)}" fetchpriority="high" width="${hero.width || 1600}" height="${hero.height || 900}">`}</div>` : ''}
<div class="wrap"><p class="eyebrow">${esc(category || 'Bar & Kitchen')}${address ? ` · ${esc(address.value.split(',').slice(-3, -1).join(',').trim() || 'New Delhi')}` : ''}</p>
<h1>${esc(name)}</h1>
${description ? `<p class="lead">${esc(description)}</p>` : ''}
<div class="ctas">${primaryCta}${sectionList.length ? '<a class="btn btn-ghost" href="#menu">See the menu</a>' : ''}</div>
<div class="meta-strip">${rating ? `<span><b>${esc(rating.value.value)}${rating.value.best ? `/${esc(rating.value.best)}` : ''}</b> ${rating.value.count ? `· ${esc(rating.value.count.toLocaleString())} reviews` : ''}</span>` : ''}${priceRange ? `<span><b>${esc(priceRange)}</b></span>` : ''}${hoursLine ? `<span>${esc(hoursLine)}</span>` : ''}</div>
</div></section>

${description || category || cuisine.length ? `<section id="about"><div class="wrap about"><div><p class="eyebrow">The place</p><h2>A tailor-made table in ${esc(address ? (address.value.match(/connaught place/i) ? 'Connaught Place' : 'the city') : 'the city')}</h2>${description ? `<p style="color:var(--muted)">${esc(description)}</p>` : '<p style="color:var(--muted)">Details below are drawn from verified public listings for this restaurant.</p>'}${cuisine.length ? `<div class="chips">${cuisine.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}</div>${photos[1] ? figure(photos[1]) : hero ? figure(hero) : ''}</div></section>` : ''}

${sectionList.length ? `<section id="menu"><div class="wrap"><div class="section-head"><p class="eyebrow">What to order</p><h2>The menu</h2><p>${transcribed ? 'Transcribed automatically from the restaurant’s menu scans — please confirm current dishes and prices with the restaurant.' : 'Selected items from verified public sources; availability and prices may change.'}</p></div>
${sectionList.length > 1 ? `<div class="menu-nav">${sectionList.map(([sec], i) => `<a href="#sec-${i}">${esc(sec)}</a>`).join('')}</div>` : ''}
${sectionList
    .map(
      ([sec, items], i) =>
        `<div class="menu-section" id="sec-${i}"><h3>${esc(sec)}</h3><div class="menu-grid">${items
          .map((m) => {
            const unknown = !(m.price && m.price.trim())
            return `<div class="dish"><div><div class="d-name">${esc(m.name)}</div>${m.description ? `<div class="d-desc">${esc(m.description)}</div>` : ''}</div><div class="d-price${unknown ? ' unknown' : ''}">${esc(priceLabel(m))}</div></div>`
          })
          .join('')}</div></div>`
    )
    .join('')}
${menuPages.length ? `<p class="menu-note">These items were read from the restaurant’s menu pages.</p><div class="scan-links">${menuPages.map((p, i) => `<a href="${local(p.local)}" target="_blank" rel="noopener">View full menu page ${esc(p.page ?? i + 1)}${p.section ? ` (${esc(p.section)})` : ''}</a>`).join('')}</div>` : ''}
</div></section>` : ''}

${gallery.length ? `<section id="gallery"><div class="wrap"><div class="section-head"><p class="eyebrow">Inside</p><h2>Gallery</h2></div><div class="gallery">${gallery.map((i) => figure(i)).join('')}</div></div></section>` : ''}

<section id="visit"><div class="wrap"><div class="section-head"><p class="eyebrow">Plan your visit</p><h2>Find us</h2></div><div class="visit">
<div class="card"><h3>Location</h3>${address ? `<p><b>${esc(address.value)}</b></p>${directions ? `<p><a class="btn btn-ghost" style="margin-top:12px" href="${directions}" target="_blank" rel="noopener">Get directions</a></p>` : ''}` : '<p>Address not verified in the available sources.</p>'}
${phone ? `<p style="margin-top:18px"><b>Reservations</b></p><p><a href="${telHref}">${esc(phone.value)}</a>${phoneUnverified ? '<span class="unverified">Number from a listing (unverified)</span>' : ''}</p>` : ''}
${site ? `<p style="margin-top:12px"><a href="${site}" target="_blank" rel="noopener">Official website ↗</a></p>` : ''}</div>
<div class="card"><h3>Hours</h3>${hoursLine ? `<p><b>${esc(hoursLine)}</b></p>` : ''}${hourRows.length ? `<ul class="hours-list">${hourRows.map((h) => { const parts = h.split(/\s(?=\d)/); return `<li><span>${esc(parts[0])}</span><span>${esc(parts.slice(1).join(' '))}</span></li>` }).join('')}</ul>` : '<p>Opening hours not verified.</p>'}${booking ? `<p style="margin-top:18px"><a class="btn btn-primary" href="${safeUrl(booking)}" target="_blank" rel="noopener">Book a table</a></p>` : ''}</div>
</div></div></section>
</main>
<footer class="site"><div class="wrap"><p><b>${esc(name)}</b> — website concept built from verified public sources on ${esc(d.createdAt.slice(0, 10))}.</p>
${okSources.length ? `<ul class="sources">${okSources.slice(0, 8).map((s) => `<li><a href="${safeUrl(s.url)}" target="_blank" rel="noopener">${esc(s.title || new URL(s.url).hostname)}</a> · ${s.official ? 'first-party' : 'listing'}</li>`).join('')}</ul>` : ''}
${d.unavailable.length ? `<p class="credit">Not independently verified: ${esc(d.unavailable.join(', '))}.</p>` : ''}
<p class="credit">Photographs belong to the restaurant or the listing platform and require permission before publishing.</p></div></footer>
</body></html>`
}

export async function buildBusinessSite(dossierPath: string, projectDir: string) {
  const d = JSON.parse(await readFile(dossierPath, 'utf8')) as Dossier
  const html = businessSiteHtml(d)
  // Verify that dossier-local assets belong to this output and exist before integrating them.
  for (const i of d.images) if (i.local && /^assets\/images\/[a-z0-9_.-]+$/i.test(i.local)) await access(join(projectDir, i.local))
  await mkdir(projectDir, { recursive: true })
  const path = join(projectDir, 'index.html')
  let backup: string | undefined
  try {
    await access(path)
    backup = `${path}.${Date.now()}.bak`
    await copyFile(path, backup)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  await writeFile(path, html, 'utf8')
  return { path, backup, research: researchOutcome(d) }
}
