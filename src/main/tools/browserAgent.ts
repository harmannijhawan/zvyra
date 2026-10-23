/**
 * OWNER: Kiro. A real, visible browser that ZVYRA operates (Playwright driving
 * the installed Microsoft Edge or Google Chrome — no browser download).
 *
 *  - its own profile (userData/browser-profile): never the user's everyday
 *    browser profile, cookies or passwords; the user can sign in there
 *    themselves when a site needs it,
 *  - page structure comes from the DOM: each visible interactive element gets
 *    a ref (e12) the agent uses to click/type, recomputed on every snapshot so
 *    positions are never stale after scrolling, resizing or navigation,
 *  - logins, CAPTCHAs and paywalls are reported, never bypassed; passwords are
 *    never typed by ZVYRA,
 *  - clicks that submit, pay, order, send, publish or delete wait for the
 *    user's approval; downloads of programs/scripts too.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext, Page } from 'playwright-core'

export interface SnapshotElement {
  ref: string
  role: string
  name: string
  href?: string
  value?: string
  type?: string
  inForm?: boolean
}

export interface Snapshot {
  url: string
  title: string
  elements: SnapshotElement[]
  text: string
  signals: { login: boolean; captcha: boolean; paywall: boolean }
  tabs: { index: number; title: string; url: string; active: boolean }[]
}

export interface BrowserDeps {
  profileDir: string
  downloadsDir: string
  /** Asks the user; resolves true when approved. */
  approve(title: string, details: { label: string; value: string }[]): Promise<boolean>
  /** Tests only; the user always sees ZVYRA's browser. */
  headless?: boolean
}

const RISKY = /\b(pay|buy|purchase|order|checkout|place order|submit|send|publish|post|delete|remove|confirm|book|reserve|subscribe|sign up|register|donate|transfer|apply)\b/i
const RISKY_FILE = /\.(exe|msi|bat|cmd|ps1|vbs|js|jar|scr|com|reg|dll|appx|msix)$/i

const SNAPSHOT_JS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > -200 && r.top < innerHeight * 3 };
  const name = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 100);
  let n = 0;
  document.querySelectorAll('[data-zvyra-ref]').forEach((e) => e.removeAttribute('data-zvyra-ref'));
  const out = [];
  for (const el of document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [contenteditable=true], summary')) {
    if (!vis(el) || out.length >= 150) continue;
    const ref = 'e' + (++n);
    el.setAttribute('data-zvyra-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') : tag);
    out.push({ ref, role, name: name(el), href: tag === 'a' ? el.href : undefined, value: (tag === 'input' || tag === 'textarea') && el.type !== 'password' ? String(el.value || '').slice(0, 80) : undefined, type: el.type || undefined, inForm: !!el.closest('form') });
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000);
  const lower = text.toLowerCase();
  return {
    elements: out, text,
    signals: {
      login: !!document.querySelector('input[type=password]') || /(sign|log) ?in to (continue|view)/.test(lower),
      captcha: !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, #challenge-form') || /verify you are (a )?human|are you a robot/.test(lower),
      paywall: /subscribe to (continue|read)|you've reached your (free )?article limit/.test(lower)
    }
  };
})()`

export class BrowserAgent {
  private ctx: BrowserContext | null = null
  private page: Page | null = null
  private snap: Snapshot | null = null

  constructor(private readonly deps: BrowserDeps) {}

  private async ensure(): Promise<Page> {
    if (this.ctx && this.page && !this.page.isClosed()) return this.page
    const { chromium } = await import('playwright-core')
    await mkdir(this.deps.profileDir, { recursive: true })
    const opts = { headless: !!this.deps.headless, viewport: null, acceptDownloads: true, args: ['--no-first-run', '--no-default-browser-check'] }
    let ctx: BrowserContext | null = null
    let lastErr: unknown
    for (const channel of ['msedge', 'chrome']) {
      try {
        ctx = await chromium.launchPersistentContext(this.deps.profileDir, { ...opts, channel })
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (!ctx) throw new Error(`Could not start Microsoft Edge or Google Chrome: ${(lastErr as Error)?.message?.split('\n')[0] ?? lastErr}`)
    this.ctx = ctx
    ctx.on('close', () => {
      this.ctx = null
      this.page = null
    })
    ctx.on('page', (p) => this.watchDownloads(p))
    this.page = ctx.pages()[0] ?? (await ctx.newPage())
    for (const p of ctx.pages()) this.watchDownloads(p)
    return this.page
  }

  private watchDownloads(p: Page) {
    p.on('download', async (d) => {
      const file = d.suggestedFilename()
      if (RISKY_FILE.test(file) && !(await this.deps.approve(`Download program/script “${file}”`, [{ label: 'From', value: d.url() }]))) {
        await d.cancel().catch(() => undefined)
        return
      }
      await mkdir(this.deps.downloadsDir, { recursive: true })
      await d.saveAs(join(this.deps.downloadsDir, file)).catch(() => undefined)
    })
  }

  async goto(url: string) {
    const p = await this.ensure()
    const u = /^https?:\/\//i.test(url) ? url : `https://${url}`
    const res = await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await p.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => undefined)
    return { status: res?.status() ?? 0, ...(await this.snapshot()) }
  }

  async snapshot(): Promise<Snapshot> {
    const p = await this.ensure()
    const r = (await p.evaluate(SNAPSHOT_JS)) as Pick<Snapshot, 'elements' | 'text' | 'signals'>
    const pages = this.ctx!.pages()
    this.snap = {
      url: p.url(),
      title: await p.title(),
      ...r,
      tabs: await Promise.all(pages.map(async (x, i) => ({ index: i, title: await x.title().catch(() => ''), url: x.url(), active: x === p })))
    }
    return this.snap
  }

  private element(ref: string) {
    const el = this.snap?.elements.find((e) => e.ref === ref)
    if (!el) throw new Error(`Unknown element ${ref}. Take a new snapshot first (the page may have changed).`)
    return el
  }

  async click(ref: string) {
    const p = await this.ensure()
    const el = this.element(ref)
    const risky = RISKY.test(el.name) || (el.type === 'submit' && el.inForm)
    if (risky && !(await this.deps.approve(`Click “${el.name || el.role}” on ${new URL(p.url()).hostname}`, [{ label: 'Page', value: p.url() }, { label: 'Element', value: `${el.role}: ${el.name}` }]))) {
      return { clicked: false, note: 'Not approved, nothing was clicked.' }
    }
    const before = p.url()
    await p.locator(`[data-zvyra-ref="${ref}"]`).click({ timeout: 8000 })
    await p.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined)
    await p.waitForTimeout(500)
    const after = await this.snapshot()
    return { clicked: true, navigated: after.url !== before, ...after }
  }

  async type(ref: string, text: string, submit = false) {
    const p = await this.ensure()
    const el = this.element(ref)
    if (el.type === 'password') throw new Error('ZVYRA does not type passwords. Ask the user to sign in themselves in the ZVYRA browser window.')
    const loc = p.locator(`[data-zvyra-ref="${ref}"]`)
    await loc.fill(text, { timeout: 8000 })
    const value = await loc.inputValue().catch(() => null)
    if (submit) {
      const isSearch = el.type === 'search' || /search|query|\bq\b/i.test(el.name)
      if (!isSearch && el.inForm && !(await this.deps.approve(`Submit the form on ${new URL(p.url()).hostname}`, [{ label: 'Field', value: el.name }, { label: 'Text', value: text.slice(0, 300) }]))) {
        return { typed: true, submitted: false, verified: value === text, note: 'Typed, but submitting was not approved.' }
      }
      await loc.press('Enter')
      await p.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined)
      await p.waitForTimeout(500)
    }
    return { typed: true, submitted: submit, verified: value === null ? null : value === text, ...(submit ? await this.snapshot() : {}) }
  }

  async scroll(direction: 'down' | 'up' = 'down') {
    const p = await this.ensure()
    await p.mouse.wheel(0, direction === 'down' ? 800 : -800)
    await p.waitForTimeout(400)
    return this.snapshot()
  }

  async back() {
    const p = await this.ensure()
    await p.goBack({ timeout: 10_000 }).catch(() => undefined)
    return this.snapshot()
  }

  async newTab(url?: string) {
    await this.ensure()
    this.page = await this.ctx!.newPage()
    this.watchDownloads(this.page)
    return url ? this.goto(url) : this.snapshot()
  }

  async switchTab(index: number) {
    await this.ensure()
    const p = this.ctx!.pages()[index]
    if (!p) throw new Error(`No tab ${index}`)
    this.page = p
    await p.bringToFront()
    return this.snapshot()
  }

  async closeTab() {
    const p = await this.ensure()
    await p.close()
    this.page = this.ctx?.pages()[0] ?? null
    return this.page ? this.snapshot() : { closed: true }
  }

  async screenshot(): Promise<Buffer> {
    const p = await this.ensure()
    return p.screenshot({ type: 'jpeg', quality: 70 })
  }

  async close() {
    await this.ctx?.close().catch(() => undefined)
    this.ctx = null
    this.page = null
  }
}
