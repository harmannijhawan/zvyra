/**
 * OWNER: Kiro. Website QA in a real (hidden, sandboxed) Chromium window.
 *
 * Serves local sites over http://127.0.0.1 (like a real host, so fetch/modules
 * work), then across mobile, tablet and desktop viewports reports: console errors,
 * failed requests, broken images, horizontal overflow, small tap targets,
 * low-contrast text, missing title/description/viewport/lang/h1, images
 * without alt, empty links, unlabeled inputs, placeholder content, and broken
 * internal links. Full-page screenshots are saved so the result can be seen,
 * and an optional visual design review is done by a vision model.
 */
import { app, BrowserWindow, session } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { previewUrl } from './staticServer'
import { generateWithFallback } from '../tools/gemini'
import { researchOutcome, type Dossier } from '../research/dossier'

export interface ViewportReport {
  name: string
  width: number
  height: number
  consoleErrors: string[]
  failedRequests: string[]
  brokenImages: string[]
  overflowX: { amount: number; culprits: string[] } | null
  smallTapTargets: string[]
  lowContrast: string[]
  clippedText: string[]
  readinessIssues: string[]
  screenshot?: string
}

export interface SiteReport {
  ok: boolean
  url: string
  title: string
  textSample: string
  seo: { title: boolean; description: boolean; viewport: boolean; lang: boolean; h1Count: number; ogImage: boolean }
  a11y: { imagesWithoutAlt: number; emptyLinks: number; unlabeledInputs: number; unnamedButtons: number }
  placeholders: string[]
  brokenLinks: string[]
  viewports: ViewportReport[]
  issues: string[]
  review?: { score?: number; issues: { severity: string; area: string; issue: string; fix: string }[]; summary?: string; error?: string }
  /** Kept for callers of the old single-viewport API. */
  consoleErrors: string[]
  failedRequests: string[]
  screenshotJpegBase64?: string
}

const within = <T>(p: Promise<T>, ms: number, why: string) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(why)), ms))])

let wired = false
const failures = new Map<number, string[]>()

const AUDIT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' };
  const sel = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const W = window.innerWidth;
  const clipped = [];
  const clipping = /^(hidden|clip|auto|scroll)$/;
  for (const el of document.body.querySelectorAll('*')) {
    if (!vis(el) || clipped.length >= 20) continue;
    const nodes = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim());
    if (!nodes.length) continue;
    let left = 0, right = W, top = -Infinity, bottom = Infinity;
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p), r = p.getBoundingClientRect();
      if (clipping.test(s.overflowX)) { left = Math.max(left, r.left + p.clientLeft); right = Math.min(right, r.left + p.clientLeft + p.clientWidth); }
      if (clipping.test(s.overflowY)) { top = Math.max(top, r.top + p.clientTop); bottom = Math.min(bottom, r.top + p.clientTop + p.clientHeight); }
    }
    let cut = false;
    for (const n of nodes) { const range = document.createRange(); range.selectNodeContents(n); for (const r of range.getClientRects()) if (r.width > 0 && (r.left < left - 2 || r.right > right + 2 || r.top < top - 2 || r.bottom > bottom + 2)) cut = true; }
    if (cut) clipped.push(sel(el) + ' "' + el.textContent.trim().slice(0, 60) + '"');
  }
  const sw = document.documentElement.scrollWidth;
  let overflow = null;
  const leftEdge = [...document.body.querySelectorAll('*')].filter(el => vis(el) && el.getBoundingClientRect().left < -1 && el.getBoundingClientRect().right > 0);
  if (sw > W + 1 || leftEdge.length) {
    const c = [];
    for (const el of document.body.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.right > W + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed') { c.push(sel(el) + ' (' + Math.round(r.right - W) + 'px)'); if (c.length >= 6) break } }
    for (const el of leftEdge.slice(0, 6)) c.push(sel(el) + ' (left edge ' + Math.round(el.getBoundingClientRect().left) + 'px)');
    overflow = { amount: Math.max(sw - W, ...leftEdge.map(el => -el.getBoundingClientRect().left)), culprits: c };
  }
  const imgs = [...document.images];
  const broken = imgs.filter((i) => (!i.complete || i.naturalWidth === 0) && (i.currentSrc || i.src)).map((i) => i.currentSrc || i.src).slice(0, 20);
  const small = [];
  if (W < 600) for (const el of document.querySelectorAll('a[href], button, input, select, [role=button]')) { if (!vis(el)) continue; const r = el.getBoundingClientRect(); if ((r.width < 24 || r.height < 24) && (el.textContent || '').trim().length < 40) { small.push(sel(el) + ' ' + Math.round(r.width) + '×' + Math.round(r.height)); if (small.length >= 8) break } }
  const rgb = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } };
  const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b) };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage && s.backgroundImage !== 'none') return null; const c = rgb(s.backgroundColor); if (c && c.a > 0.9) return c } return { r: 255, g: 255, b: 255, a: 1 } };
  // Text drawn over photos/video/gradients can't be measured from CSS colours: skip it (the visual review covers it).
  const media = [...document.querySelectorAll('img, video, picture, canvas, *')].filter((x) => /^(IMG|VIDEO|PICTURE|CANVAS)$/.test(x.tagName) || (getComputedStyle(x).backgroundImage || 'none') !== 'none').slice(0, 300).map((x) => x.getBoundingClientRect()).filter((r) => r.width > 40 && r.height > 40);
  const low = [];
  for (const el of document.querySelectorAll('h1, h2, h3, p, li, a, button, label, span')) {
    if (low.length >= 8) break;
    if (!vis(el) || !(el.childNodes[0] && el.childNodes[0].nodeType === 3 && el.textContent.trim().length > 2)) continue;
    const rr = el.getBoundingClientRect(); const cx = rr.left + rr.width / 2, cy = rr.top + rr.height / 2;
    if (media.some((m) => cx >= m.left && cx <= m.right && cy >= m.top && cy <= m.bottom)) continue;
    const s = getComputedStyle(el); const fg = rgb(s.color); const bg = bgOf(el); if (!fg || !bg) continue;
    const a = L(fg), b = L(bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.6 && Number(s.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) low.push(sel(el) + ' "' + el.textContent.trim().slice(0, 30) + '" ' + ratio.toFixed(1) + ':1');
  }
  const meta = (n) => document.querySelector('meta[name="' + n + '"], meta[property="' + n + '"]');
  const text = (document.body && document.body.innerText) || '';
  const ph = [];
  const re = /lorem ipsum|\\bTODO\\b|placeholder text|your (business|company|brand) name|example\\.com|123[- ]?456[- ]?7890|xxx-xxx/ig;
  let m; while ((m = re.exec(text)) && ph.length < 6) ph.push(m[0]);
  for (const i of imgs) if (/picsum\\.photos|via\\.placeholder|placehold\\.(co|it)|dummyimage|source\\.unsplash\\.com|placekitten/.test(i.src)) { ph.push('placeholder image ' + i.src.slice(0, 80)); if (ph.length >= 10) break }
  const links = [...new Set([...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => h.startsWith(location.origin)).map((h) => h.split('#')[0]))].slice(0, 30);
  const brokenAnchors = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin || u.pathname !== location.pathname || u.search !== location.search || !u.hash || u.hash.startsWith('#:~:text=')) continue;
    let id; try { id = decodeURIComponent(u.hash.slice(1).split(':~:text=')[0]); } catch { brokenAnchors.push(a.href); continue; }
    if (id.toLowerCase() !== 'top' && !document.getElementById(id) && ![...document.getElementsByName(id)].some(el => el.tagName === 'A')) brokenAnchors.push(a.href);
  }
  return {
    title: document.title, text: text.replace(/\\s+/g, ' ').slice(0, 1500),
    seo: { title: !!document.title.trim(), description: !!(meta('description') && meta('description').content.trim()), viewport: !!meta('viewport'), lang: !!document.documentElement.lang, h1Count: document.querySelectorAll('h1').length, ogImage: !!meta('og:image') },
    a11y: {
      imagesWithoutAlt: imgs.filter((i) => !i.hasAttribute('alt')).length,
      emptyLinks: [...document.querySelectorAll('a')].filter((a) => !a.getAttribute('href') || a.getAttribute('href') === '#' ).length,
      unlabeledInputs: [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select')].filter((i) => !(i.labels && i.labels.length) && !i.getAttribute('aria-label') && !i.getAttribute('aria-labelledby') && !i.getAttribute('title')).length,
      unnamedButtons: [...document.querySelectorAll('button, [role=button]')].filter((b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')).length
    },
    overflow, broken, small, low, clipped, brokenAnchors, ph, links, height: Math.min(Math.max(document.documentElement.scrollHeight, window.innerHeight), 7000)
  };
})()`

interface Audit {
  title: string
  text: string
  seo: SiteReport['seo']
  a11y: SiteReport['a11y']
  overflow: ViewportReport['overflowX']
  broken: string[]
  small: string[]
  low: string[]
  clipped: string[]
  brokenAnchors: string[]
  ph: string[]
  links: string[]
  height: number
}

function qaDir() {
  const dir = join(app.getPath('userData'), 'qa', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  return dir
}

async function runViewport(url: string, name: string, width: number, height: number, outDir: string): Promise<{ report: ViewportReport; audit: Audit; jpeg: Buffer }> {
  const ses = session.fromPartition('zvyra-site-check')
  if (!wired) {
    wired = true
    ses.webRequest.onErrorOccurred((d) => {
      const list = failures.get(d.webContentsId ?? -1)
      if (list && !d.url.startsWith('data:') && !/ERR_ABORTED|ERR_CACHE_MISS/.test(d.error)) list.push(`${d.error} ${d.url}`)
    })
    ses.webRequest.onCompleted((d) => {
      const list = failures.get(d.webContentsId ?? -1)
      if (list && d.statusCode >= 400) list.push(`HTTP ${d.statusCode} ${d.url}`)
    })
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  }
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: { partition: 'zvyra-site-check', sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  const id = win.webContents.id
  failures.set(id, [])
  const consoleErrors: string[] = []
  win.webContents.on('console-message', (...args: unknown[]) => {
    const e = args[0] as { level?: string | number; message?: string }
    const level = e?.level ?? args[1]
    const message = e?.message ?? (args[2] as string)
    if (level === 'error' || level === 3) consoleErrors.push(String(message).slice(0, 300))
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    if (width < 600) win.webContents.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')
    // A fresh session's first navigation can fail transiently (ERR_FAILED): retry once.
    const load = () => within(win.loadURL(url), 25_000, 'Page took longer than 25 s to load')
    await load().catch(async (err: Error) => {
      if (!/ERR_FAILED|ERR_NETWORK_CHANGED/.test(err.message)) throw err
      await new Promise((r) => setTimeout(r, 800))
      await load()
    })
    // Scroll through once so lazy images load, then measure.
    await within(win.webContents.executeJavaScript(`new Promise(async (d) => { for (let i = 0; i < 10; i++) { scrollBy(0, innerHeight); await new Promise(r => setTimeout(r, 120)) } scrollTo(0, 0); setTimeout(() => d(1), 600) })`, true), 15_000, 'The page did not respond while scrolling')
    const readinessIssues = await within(win.webContents.executeJavaScript(`(async () => {
      const deadline = (promise, label) => Promise.race([promise.then(() => null, () => label + ' failed'), new Promise(r => setTimeout(() => r(label + ' timed out'), 5000))]);
      const fonts = deadline(document.fonts.ready, 'font readiness');
      const images = deadline(Promise.all([...document.images].map(async i => {
        i.loading = 'eager';
        if (!i.complete) await new Promise(r => { i.addEventListener('load', r, {once:true}); i.addEventListener('error', r, {once:true}); });
        if (i.naturalWidth && i.decode) await i.decode().catch(() => {});
      })), 'image readiness');
      return (await Promise.all([fonts, images])).filter(Boolean);
    })()`, true), 7000, 'Page did not respond while waiting for media') as string[]
    const audit = (await within(win.webContents.executeJavaScript(AUDIT, true), 20_000, 'The page did not respond to the audit')) as Audit
    // Full-page screenshot without resizing the viewport (resizing would stretch 100vh sections).
    const jpeg = await fullPage(win, width, audit.height)
    const file = join(outDir, `${name}.jpg`)
    if (jpeg.length) writeFileSync(file, jpeg)
    return {
      audit,
      jpeg,
      report: {
        name,
        width,
        height,
        consoleErrors: [...new Set(consoleErrors)].slice(0, 20),
        failedRequests: [...new Set(failures.get(id) ?? [])].slice(0, 20),
        brokenImages: audit.broken,
        overflowX: audit.overflow,
        smallTapTargets: audit.small,
        lowContrast: audit.low,
        clippedText: audit.clipped,
        readinessIssues,
        screenshot: jpeg.length ? file : undefined
      }
    }
  } finally {
    failures.delete(id)
    win.destroy()
  }
}

async function fullPage(win: BrowserWindow, width: number, pageHeight: number): Promise<Buffer> {
  const dbg = win.webContents.debugger
  try {
    dbg.attach('1.3')
    // Hidden windows can stall the compositor: never wait on a capture forever.
    const r = (await Promise.race([
      dbg.sendCommand('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 72,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: Math.min(pageHeight, 7000), scale: width > 1280 ? 1280 / width : 1 }
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), 15_000))
    ])) as { data: string }
    return Buffer.from(r.data, 'base64')
  } catch {
    const img = await Promise.race([win.webContents.capturePage(), new Promise<null>((r) => setTimeout(() => r(null), 10_000))])
    if (!img) return Buffer.alloc(0)
    return (img.getSize().width > 1280 ? img.resize({ width: 1280 }) : img).toJPEG(78)
  } finally {
    try {
      dbg.detach()
    } catch {
      /* not attached */
    }
  }
}

async function crawlLinks(links: string[]): Promise<string[]> {
  const bad: string[] = []
  await Promise.all(
    links.slice(0, 30).map(async (l) => {
      try {
        const r = await fetch(l, { method: 'GET', signal: AbortSignal.timeout(8000) })
        if (r.status >= 400) bad.push(`HTTP ${r.status} ${l}`)
        await r.body?.cancel()
      } catch (err) {
        bad.push(`${err instanceof Error ? err.message : String(err)} ${l}`)
      }
    })
  )
  return bad
}

async function visualReview(key: string, shots: { name: string; jpeg: Buffer }[], brief?: string): Promise<SiteReport['review']> {
  try {
    const { res } = await generateWithFallback(
      key,
      {
        contents: [
          {
            role: 'user',
            parts: [
              ...shots.flatMap((s) => [{ text: `[${s.name} full-page screenshot]` }, { inlineData: { mimeType: 'image/jpeg', data: s.jpeg.toString('base64') } }]),
              {
                text: [
                  'You are a senior web designer reviewing a client website before delivery. Judge only what is visible.',
                  brief ? `Intended direction: ${brief}` : '',
                  'Check: visual hierarchy, typography (sizes, pairing, line length), spacing rhythm, alignment, colour and contrast, imagery quality and cropping, hero strength, clarity of the main call to action, consistency of components, mobile layout problems, anything that looks generic, broken or unfinished.',
                  'Return JSON only: {"score": 1-10, "summary": "one sentence", "issues": [{"severity":"high|medium|low","area":"hero|nav|typography|spacing|color|imagery|cta|mobile|footer|other","issue":"what is wrong, specific","fix":"concrete CSS/HTML change"}]} with at most 10 issues, most important first.'
                ]
                  .filter(Boolean)
                  .join('\n')
              }
            ]
          }
        ],
        config: { temperature: 0.2, maxOutputTokens: 2000, responseMimeType: 'application/json' }
      },
      { timeoutMs: 60_000 }
    )
    const j = JSON.parse((res.text ?? '{}').replace(/^```(?:json)?\s*|\s*```$/g, '')) as { score?: number; summary?: string; issues?: { severity: string; area: string; issue: string; fix: string }[] }
    if (!Array.isArray(j.issues) || j.issues.some(i => !i || typeof i.severity !== 'string' || typeof i.area !== 'string' || typeof i.issue !== 'string' || typeof i.fix !== 'string')) throw new Error('Visual review returned an invalid issue list')
    return { score: j.score, summary: j.summary, issues: (j.issues ?? []).slice(0, 10) }
  } catch (err) {
    return { issues: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** Accepts an http(s) URL, an .html file or a site folder. */
export async function checkSite(entry: string, opts: { review?: { key: string | null; brief?: string }; desktop?: [number, number] } = {}): Promise<SiteReport> {
  let url = entry
  let researchIssue: string | undefined
  if (!/^https?:/i.test(entry)) {
    if (!existsSync(entry)) throw new Error(`Nothing exists at “${entry}”.`)
    const isDir = statSync(entry).isDirectory()
    const root = isDir ? entry : dirname(entry)
    const dossierPath = join(root, 'research', 'dossier.json')
    if (existsSync(dossierPath)) {
      try {
        const outcome = researchOutcome(JSON.parse(readFileSync(dossierPath, 'utf8')) as Dossier)
        if (!outcome.ok) researchIssue = 'Business content is unverified: the research dossier contains no usable business evidence.'
      } catch { researchIssue = 'The project research dossier could not be validated.' }
    }
    try {
      url = await previewUrl(root, isDir ? undefined : entry)
    } catch {
      url = pathToFileURL(isDir ? join(entry, 'index.html') : entry).href
    }
  }
  const outDir = qaDir()
  const [dw, dh] = opts.desktop ?? [1440, 900]
  const sizes: [string, number, number][] = [
    ['desktop', 1440, 900], ['mobile', 390, 844], ['mobile-small', 360, 800], ['tablet', 768, 1024], ['laptop', 1024, 768]
  ]
  if (dw !== 1440 || dh !== 900) sizes.push(['desktop-custom', dw, dh])
  const results: Awaited<ReturnType<typeof runViewport>>[] = []
  for (const [name, width, height] of sizes) results.push(await runViewport(url, name, width, height, outDir))
  const desktop = results[0]
  const a = desktop.audit
  const brokenLinks = [...new Set([...(await crawlLinks(a.links)), ...results.flatMap(r => r.audit.brokenAnchors.map(h => `missing anchor ${h}`))])]
  const viewports = results.map(r => r.report)
  const issues: string[] = []
  if (researchIssue) issues.push(researchIssue)
  for (const v of viewports) {
    if (!v.screenshot || !existsSync(v.screenshot) || statSync(v.screenshot).size === 0) issues.push(`[${v.name}] screenshot missing or empty`)
    for (const r of v.readinessIssues) issues.push(`[${v.name}] ${r}`)
    for (const t of v.clippedText) issues.push(`[${v.name}] clipped text: ${t}`)
    for (const e of v.consoleErrors) issues.push(`[${v.name}] console error: ${e}`)
    for (const f of v.failedRequests) issues.push(`[${v.name}] failed request: ${f}`)
    for (const b of v.brokenImages) issues.push(`[${v.name}] broken image: ${b}`)
    if (v.overflowX) issues.push(`[${v.name}] page scrolls sideways by ${v.overflowX.amount}px (${v.overflowX.culprits.join(', ')})`)
    if (v.smallTapTargets.length) issues.push(`[${v.name}] tap targets under 24px: ${v.smallTapTargets.slice(0, 4).join('; ')}`)
    if (v.lowContrast.length) issues.push(`[${v.name}] low-contrast text: ${v.lowContrast.slice(0, 4).join('; ')}`)
  }
  if (!a.seo.title) issues.push('missing <title>')
  if (!a.seo.description) issues.push('missing meta description')
  if (!a.seo.viewport) issues.push('missing viewport meta tag (mobile layout will break)')
  if (!a.seo.lang) issues.push('missing <html lang>')
  if (a.seo.h1Count !== 1) issues.push(`${a.seo.h1Count} <h1> elements (use exactly one)`)
  if (a.a11y.imagesWithoutAlt) issues.push(`${a.a11y.imagesWithoutAlt} image(s) without alt text`)
  if (a.a11y.emptyLinks) issues.push(`${a.a11y.emptyLinks} link(s) with no destination (href="#" or empty)`)
  if (a.a11y.unlabeledInputs) issues.push(`${a.a11y.unlabeledInputs} form field(s) without a label`)
  if (a.a11y.unnamedButtons) issues.push(`${a.a11y.unnamedButtons} button(s) without an accessible name`)
  for (const p of a.ph) issues.push(`placeholder content: ${p}`)
  for (const b of brokenLinks) issues.push(`broken internal link: ${b}`)
  const review = opts.review?.key
    ? results.every(r => r.jpeg.length)
      ? await visualReview(opts.review.key, results.map(r => ({ name: r.report.name, jpeg: r.jpeg })), opts.review.brief)
      : { issues: [], error: 'Visual review cannot run because a viewport screenshot is missing' }
    : undefined
  if (review?.error) issues.push(`visual review failed: ${review.error}`)
  for (const issue of review?.issues ?? []) if (/^(high|critical|error)$/i.test(issue.severity)) issues.push(`visual review [${issue.area}]: ${issue.issue}; fix: ${issue.fix}`)
  const report: SiteReport = {
    ok: issues.length === 0,
    url,
    title: a.title,
    textSample: a.text,
    seo: a.seo,
    a11y: a.a11y,
    placeholders: a.ph,
    brokenLinks,
    viewports,
    issues,
    review,
    consoleErrors: [...new Set(viewports.flatMap((v) => v.consoleErrors))],
    failedRequests: [...new Set(viewports.flatMap((v) => v.failedRequests))],
    screenshotJpegBase64: desktop.jpeg.toString('base64')
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ ...report, screenshotJpegBase64: undefined }, null, 2))
  return report
}
