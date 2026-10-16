// Renderer benchmark: serves a built renderer, mocks window.swarm, and measures startup + streaming cost.
// node scripts/perf/renderer-bench.mjs <distDir> <perfDir> [--bootstrap-delay=2500]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const dist = path.resolve(process.argv[2]);
const perf = path.resolve(process.argv[3]);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.ndjson': 'text/plain', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  let f;
  if (p.startsWith('/__perf/')) f = path.join(perf, p.slice(8)); else f = path.join(dist, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', mime[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const settings = JSON.parse(fs.readFileSync(path.join(perf, 'settings.json'), 'utf8'));
const conv = JSON.parse(fs.readFileSync(path.join(perf, 'conv-big.json'), 'utf8'));
const now = Date.now();
const model = (prov, id, name) => ({ id: prov + '::' + id, providerId: prov, modelId: id, displayName: name, capabilities: ['chat', 'coding'], contextLength: 128000, maxOutput: 8192, freeStatus: 'free', health: 'healthy', streaming: true, enabled: true, paramsB: 70, latencyMs: 420, tokensPerSec: 55, calls: 120, successes: 115, failures: 5, consecutiveFailures: 0, lastError: null, lastErrorAt: null, lastSuccessAt: now - 1e5, lastCheckedAt: now - 1e5, rateLimitedUntil: null, discoveredAt: now - 1e8, notes: null });
const models = [model('groq', 'llama', 'Llama 70B'), model('ollama', 'llama3', 'Llama 3 8B')];
const providers = [{ id: 'groq', name: 'Groq', kind: 'cloud', requiresKey: true, needsAccountId: false, configured: true, enabled: true, keyHint: '3f9a', keySource: 'settings', baseUrl: 'https://x', health: 'healthy', modelCount: 5, freeModelCount: 3, lastDiscoveryAt: now, lastError: null, latencyMs: 300, signupUrl: 'https://x', freeNotes: '' }];
const convs = [{ ...conv, turns: [] }, ...Array.from({ length: 40 }, (_, i) => ({ id: 'c' + i, title: 'Older chat ' + i, updatedAt: now - (i + 1) * 3e6, turns: [] }))];
const data = { settings, models, providers, conv, convs, now };

const browser = await chromium.launch({ headless: true });
async function newPage(bootDelay, search = false) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((d) => {
    window.__calls = {}; window.__handlers = {}; window.__commits = 0;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, isDisabled: false, renderers: new Map(), inject() { return 1; }, onCommitFiberRoot() { window.__commits++; }, onPostCommitFiberRoot() {}, onCommitFiberUnmount() {}, checkDCE() {} };
    const h = {
      'app:bootstrap': () => ({ firstRun: false, version: '1.0.0', platform: 'win32', paths: { data: 'C:/d', workspace: 'C:/w' }, ollama: { installed: true, running: true, url: 'http://localhost:11434', version: '0.5' }, lastProjectId: null }),
      'settings:get': () => d.settings, 'projects:list': () => [], 'models:list': () => ({ models: d.models, providers: d.providers }),
      'notifications:list': () => [], 'approvals:list': () => [], 'runs:active': () => [], 'chat:list': () => d.convs, 'chat:get': () => d.conv, 'chat:search': () => [], 'runs:list': () => [],
      'app:setTitleBar': () => true, 'ollama:status': () => ({ running: true, version: '0.5' }), 'models:rank': () => [], 'app:dataStats': () => ({ events: 1, runs: 1, cache: 1, usage: 1, sources: 1, dbBytes: 1000, dbPath: 'C:/d/db' }),
    };
    const delays = { 'app:bootstrap': d.bootDelay, 'ollama:status': d.bootDelay };
    window.swarm = {
      platform: 'win32',
      on: (ch, fn) => { (window.__handlers[ch] ??= []).push(fn); return () => { window.__handlers[ch] = window.__handlers[ch].filter((x) => x !== fn); }; },
      invoke: async (ch) => { window.__calls[ch] = (window.__calls[ch] ?? 0) + 1; if (delays[ch]) await new Promise((r) => setTimeout(r, delays[ch])); const f = h[ch]; return f ? f() : null; },
    };
    localStorage.setItem('swarm:chat', 'chat_big');
  }, { ...data, bootDelay });
  return { ctx, page, errors };
}
async function metrics(client) { const { metrics } = await client.send('Performance.getMetrics'); return Object.fromEntries(metrics.map((m) => [m.name, m.value])); }

// ---- startup ----
async function startup(bootDelay) {
  const { ctx, page, errors } = await newPage(bootDelay);
  const client = await ctx.newCDPSession(page); await client.send('Performance.enable');
  const bytes = { js: 0, css: 0, other: 0 };
  page.on('response', async (r) => { try { const b = (await r.body()).length; const u = r.url(); if (u.endsWith('.js')) bytes.js += b; else if (u.endsWith('.css')) bytes.css += b; else bytes.other += b; } catch {} });
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'commit' });
  await page.waitForSelector('.chat-workspace', { timeout: 30000 });
  const shellMs = Date.now() - t0;
  await page.waitForSelector('article.chat-message', { timeout: 30000 });
  const chatMs = Date.now() - t0;
  const m = await metrics(client);
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { domContentLoadedMs: Math.round(n.domContentLoadedEventEnd), loadMs: Math.round(n.loadEventEnd) }; });
  await ctx.close();
  return { bootstrapMockMs: bootDelay, appShellVisibleMs: shellMs, firstConversationRenderedMs: chatMs, ...nav, scriptMsAtReady: Math.round(m.ScriptDuration * 1000), jsKBLoaded: Math.round(bytes.js / 1024), cssKBLoaded: Math.round(bytes.css / 1024), jsHeapMB: Math.round(m.JSHeapUsedSize / 1048576), pageErrors: errors.length };
}

// ---- streaming ----
async function streaming(label) {
  const replayFile = path.join(perf, `replay-${label}.ndjson`);
  const { ctx, page, errors } = await newPage(50);
  const client = await ctx.newCDPSession(page); await client.send('Performance.enable');
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'commit' });
  await page.waitForSelector('article.chat-message', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('article.chat-message').length >= 150, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.fill('input[aria-label="Search chats"]', 'older');
  await page.waitForTimeout(500);
  const m0 = await metrics(client);
  const result = await page.evaluate(async ({ url, interval }) => {
    const text = await (await fetch(url)).text();
    const payloads = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const calls0 = { ...window.__calls }; const commits0 = window.__commits;
    let mutations = 0, added = 0; const mo = new MutationObserver((rs) => { mutations += rs.length; for (const r of rs) added += r.addedNodes.length; }); mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    const longTasks = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch {}
    const frames = []; let last = performance.now(); let raf = true; const loop = (t) => { frames.push(t - last); last = t; if (raf) requestAnimationFrame(loop); }; requestAnimationFrame(loop);
    const dispatchMs = [];
    const start = performance.now();
    for (const p of payloads) {
      const a = performance.now();
      for (const fn of window.__handlers['chat:updated'] ?? []) fn(p);
      dispatchMs.push(performance.now() - a);
      await new Promise((r) => setTimeout(r, interval));
    }
    await new Promise((r) => setTimeout(r, 500));
    raf = false; mo.disconnect();
    const wall = performance.now() - start;
    const s = (a) => [...a].sort((x, y) => x - y);
    const p95 = (a) => s(a)[Math.min(a.length - 1, Math.floor(a.length * 0.95))] ?? 0;
    const f = frames.slice(2);
    return { updates: payloads.length, wallMs: wall, dispatchAvgMs: dispatchMs.reduce((x, y) => x + y, 0) / dispatchMs.length, dispatchP95Ms: p95(dispatchMs), dispatchMaxMs: Math.max(...dispatchMs), commits: window.__commits - commits0, domMutationRecords: mutations, domNodesAdded: added, longTasks: longTasks.length, longTaskTotalMs: longTasks.reduce((x, y) => x + y, 0), longTaskMaxMs: Math.max(0, ...longTasks), frameP95Ms: p95(f), frameMaxMs: Math.max(...f), framesOver33ms: f.filter((x) => x > 33).length, searchIpcDuring: (window.__calls['chat:search'] ?? 0) - (calls0['chat:search'] ?? 0), listIpcDuring: (window.__calls['chat:list'] ?? 0) - (calls0['chat:list'] ?? 0), finalTurns: document.querySelectorAll('article.chat-message').length, lastTurnChars: [...document.querySelectorAll('article.chat-message')].at(-1)?.textContent?.length ?? 0 };
  }, { url: `http://localhost:${port}/__perf/replay-${label}.ndjson`, interval: 35 });
  const m1 = await metrics(client);
  const d = (k) => m1[k] - m0[k];
  await ctx.close();
  const r = (v) => Math.round(v * 100) / 100;
  return { ...Object.fromEntries(Object.entries(result).map(([k, v]) => [k, typeof v === 'number' ? r(v) : v])), cdpTaskMs: r(d('TaskDuration') * 1000), cdpScriptMs: r(d('ScriptDuration') * 1000), cdpLayoutMs: r(d('LayoutDuration') * 1000), cdpStyleMs: r(d('RecalcStyleDuration') * 1000), layoutCount: d('LayoutCount'), styleRecalcCount: d('RecalcStyleCount'), heapMB: Math.round(m1.JSHeapUsedSize / 1048576), pageErrors: errors.length };
}

const out = {};
out.startupBootstrap60ms = await startup(60);
out.startupBootstrap2500ms = await startup(2500);
out.streamBig = await streaming('big');
await browser.close(); server.close();
console.log('RENDERER ' + JSON.stringify(out));
