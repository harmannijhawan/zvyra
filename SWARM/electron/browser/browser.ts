// Browser automation via Playwright driving an installed Chromium-based browser
// (Microsoft Edge by default on Windows, so no browser download is needed).
import fs from 'node:fs/promises';
import { timeOperation } from '../core/performance';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { AgentRole, Screenshot } from '../../shared/types';
import { db } from '../core/db';
import { emit, type EventScope } from '../core/bus';
import { getSettings } from '../core/settings';
import { CancelledError, uid } from '../core/util';

let browserPromise: Promise<Browser> | null = null;

async function launch(): Promise<Browser> {
  const s = getSettings().browser;
  const { chromium } = await import('playwright-core');
  const opts: Parameters<typeof chromium.launch>[0] = { headless: s.headless, args: ['--disable-extensions', '--no-first-run', '--no-default-browser-check'] };
  if (s.channel === 'custom' && s.executablePath) opts.executablePath = s.executablePath;
  else opts.channel = s.channel;
  try { return await chromium.launch(opts); }
  catch (e) {
    // Fall back to the other common channel before giving up.
    if (s.channel !== 'custom') {
      const alt = s.channel === 'msedge' ? 'chrome' : 'msedge';
      try { return await chromium.launch({ ...opts, channel: alt }); } catch { /* ignore */ }
    }
    throw new Error(`Could not launch a browser (${(e as Error).message.split('\n')[0]}). Install Microsoft Edge or Chrome, or set a custom executable in Settings › Browser.`);
  }
}

export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const endStartup = timeOperation('browser');
    browserPromise = launch().finally(endStartup);
    browserPromise.then((b) => b.on('disconnected', () => { browserPromise = null; })).catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  try { (await browserPromise).close(); } catch { /* ignore */ }
  browserPromise = null;
}

export interface ConsoleEntry { type: string; text: string; url?: string }

export class BrowserSession {
  context!: BrowserContext;
  page!: Page;
  consoleErrors: ConsoleEntry[] = [];
  pageErrors: string[] = [];
  failedRequests: { url: string; status: number | string }[] = [];
  private closed = false;
  private shotCount = 0;

  constructor(private scope: EventScope & { projectId: string }, private projectRoot: string, private signal?: AbortSignal) {}

  async open(viewport: [number, number]) {
    if (!getSettings().computer.browser) throw new Error('Browser automation is disabled in Settings › Computer Use');
    const browser = await getBrowser();
    this.context = await browser.newContext({ viewport: { width: viewport[0], height: viewport[1] }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(getSettings().browser.navigationTimeoutSec * 1000);
    this.page.on('console', (m) => { if (m.type() === 'error') this.consoleErrors.push({ type: m.type(), text: m.text().slice(0, 500), url: m.location()?.url }); });
    this.page.on('pageerror', (e) => this.pageErrors.push(String(e.message ?? e).slice(0, 500)));
    this.page.on('requestfailed', (r) => this.failedRequests.push({ url: r.url(), status: r.failure()?.errorText ?? 'failed' }));
    this.page.on('response', (r) => { if (r.status() >= 400) this.failedRequests.push({ url: r.url(), status: r.status() }); });
    this.signal?.addEventListener('abort', () => { this.close().catch(() => undefined); }, { once: true });
    emit('BROWSER_OPENED', `Browser opened (${viewport[0]}×${viewport[1]})`, this.scope, 'info');
    return this;
  }

  private check() { if (this.signal?.aborted || this.closed) throw new CancelledError(); }

  async goto(url: string) {
    this.check();
    emit('BROWSER_ACTION', `Navigate → ${url}`, this.scope, 'info', { action: 'goto', url });
    const res = await this.page.goto(url, { waitUntil: 'load' });
    await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    return res?.status() ?? 0;
  }

  async setViewport(name: string, size: [number, number]) {
    this.check();
    await this.page.setViewportSize({ width: size[0], height: size[1] });
    emit('BROWSER_ACTION', `Viewport → ${name} ${size[0]}×${size[1]}`, this.scope, 'debug', { action: 'viewport', name });
    await this.page.waitForTimeout(250);
  }

  async click(selector: string) {
    this.check();
    emit('BROWSER_ACTION', `Click ${selector}`, this.scope, 'info', { action: 'click', selector });
    await this.page.click(selector, { timeout: 8000 });
  }

  async type(selector: string, text: string) {
    this.check();
    emit('BROWSER_ACTION', `Type into ${selector}`, this.scope, 'info', { action: 'type', selector });
    await this.page.fill(selector, text, { timeout: 8000 });
  }

  async screenshot(viewport: string, fullPage = false): Promise<Screenshot & { base64: string }> {
    this.check();
    const buf = await this.page.screenshot({ fullPage, type: 'png' });
    const dir = path.join(this.projectRoot, '.swarm', 'screenshots', this.scope.runId ?? 'manual');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${String(++this.shotCount).padStart(2, '0')}-${viewport}.png`);
    const size = this.page.viewportSize() ?? { width: 0, height: 0 };
    const shot: Screenshot = { id: uid('ss_'), projectId: this.scope.projectId, runId: this.scope.runId ?? null, url: this.page.url(), viewport, width: size.width, height: size.height, path: file, ts: Date.now() };
    if (getSettings().privacy.storeScreenshots) {
      await fs.writeFile(file, buf);
      db().put('screenshots', shot.id, shot, { project_id: shot.projectId, run_id: shot.runId, ts: shot.ts });
    }
    emit('SCREENSHOT_CAPTURED', `Screenshot captured (${viewport})`, this.scope, 'info', { screenshotId: shot.id, path: file, viewport });
    return { ...shot, base64: buf.toString('base64') };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.context?.close(); } catch { /* ignore */ }
    emit('BROWSER_CLOSED', 'Browser session closed', this.scope, 'debug');
  }
}

export function openSession(scope: EventScope & { projectId: string; agent?: AgentRole | null }, projectRoot: string, viewport: [number, number], signal?: AbortSignal) {
  return new BrowserSession(scope, projectRoot, signal).open(viewport);
}
