import { _electron as electron } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const reuse = process.argv[2];
const uiOnly = process.argv.includes('--ui-only');
const folder = reuse ? path.resolve(reuse) : path.join(root, '.swarm-test', 'control-room-' + Date.now());
fs.mkdirSync(folder, { recursive: true });
if (!reuse) {
const db = new DatabaseSync(path.join(folder, 'swarm.db'));
db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
const settings = { providers: { enabled: Object.fromEntries(['openrouter','groq','google','cloudflare','huggingface','cerebras','mistral','ollama','nvidia'].map(id => [id, id === 'nvidia'])) }, workspace: { root: path.join(folder, 'projects') }, routing: { healthCheckOnStartup: false, discoveryIntervalMin: 0, firstTokenTimeoutSec: 20, requestTimeoutSec: 90 }, research: { defaultOn: false }, appearance: { theme: 'light', accent: 'blue' }, behavior: { autonomy: 'autonomous' }, execution: { packageManager: 'npm' } };
for (const [key, value] of Object.entries({ onboarded: '1', settings: JSON.stringify(settings) })) db.prepare('INSERT INTO kv VALUES (?,?)').run(key,value);
db.close();
}
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root, '--smoke'], env: { ...process.env, SWARM_USER_DATA: folder } });
const win = await app.firstWindow();
const nativeWindow = await app.browserWindow(win);
const resize = async (width, height) => { await nativeWindow.evaluate((w, size) => { w.unmaximize(); w.setContentSize(size.width, size.height); }, { width, height }); await win.waitForTimeout(500); console.log('WINDOW', await win.evaluate(() => ({ width: innerWidth, height: innerHeight }))); };
const report = { folder, errors: [], checks: [] };
const inv = (channel, ...args) => win.evaluate(({ channel, args }) => window.swarm.invoke(channel, ...args), { channel, args });
win.on('pageerror', e => { report.errors.push(e.message); console.log('UI ERROR', e.message); });
const save = () => fs.writeFileSync(path.join(folder, uiOnly ? 'report-ui.json' : 'report.json'), JSON.stringify(report, null, 2));
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); console.log('PASS', name); save(); };
const shot = async name => { await win.screenshot({ path: path.join(folder, name + '.png') }); console.log('SCREENSHOT', path.join(folder, name + '.png')); };
async function until(fn, timeout = 300000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 700)); } throw Error('Timed out waiting for execution'); }
async function splitReset() { const splitter = win.getByRole('separator', { name: 'Resize agent panel' }); await splitter.focus(); for (let i = 0; i < 6; i++) await win.keyboard.press('ArrowRight'); await splitter.blur(); }
let runId;
async function manager(text) {
  await win.getByRole('button', { name: /^Manager:/ }).click();
  await win.getByPlaceholder('Message Manager…', { exact: false }).fill(text);
  await win.getByRole('button', { name: 'Send', exact: true }).click();
  const reply = await until(async () => { const turns = await inv('run:chat:history', runId + ':manager'); const last = turns.at(-1); return last?.senderType === 'manager' && last.status !== 'streaming' && turns.at(-2)?.text === text ? last : null; });
  check('Manager replied to: ' + text, reply.status === 'complete');
  return reply;
}
try {
  await win.locator('#chat-input').waitFor();
  await resize(1536, 1024);
  await inv('models:discover', 'nvidia');
  console.log('Provider discovery complete');
  await win.getByRole('button', { name: 'Build', exact: true }).click();
  if (!reuse) {
  await win.getByRole('textbox', { name: 'What do you want to build?' }).fill('Build a simple static web application for a photography portfolio with a gallery and contact section. Use plain HTML, CSS and JavaScript, no dependencies. Include an accessible navigation and a working contact form validation.');
  await win.getByRole('button', { name: 'Run', exact: true }).click();
  }
  const project = await until(async () => (await inv('projects:list')).find(p => p.lastRunId));
  runId = project.lastRunId; report.runId = runId;
  console.log('REAL RUN', runId);
  if (reuse) { await win.getByRole('button', { name: 'Projects', exact: true }).first().click(); await win.getByRole('button', { name: 'Open in Build', exact: true }).click(); await win.getByRole('button', { name: 'Resume', exact: true }).click(); }
  await until(async () => (await inv('runs:snapshot', runId)).tasks.length >= 5);
  await shot('01-running');
  if (!uiOnly) {
  const before = await inv('runs:snapshot', runId);
  const first = await manager('Remove the gallery and add a settings page.');
  const versions = await inv('run:chat:graphVersions', runId);
  check('Graph version persisted', versions.length > 0 && first.events?.some(e => e.kind === 'graph_updated'));
  const after = await inv('runs:snapshot', runId);
  check('Same run gained executable tasks', after.run.id === before.run.id && after.tasks.length > before.tasks.length);
  for (const role of ['designer', 'coder', 'tester']) check(role + ' received requirement', after.messages.some(m => m.to === role && m.content.includes('Remove the gallery')));
  check('Unaffected completed planning preserved', before.tasks.filter(t => t.status === 'completed' && ['plan','decompose','research'].includes(t.kind)).every(t => after.tasks.find(a => a.id === t.id)?.status === 'completed'));
  await win.getByRole('button', { name: /^Manager:/ }).click();
  await shot('02-manager-change');
  await manager('Actually make the settings page minimal and add dark mode.');
  check('Second graph version in same run', (await inv('run:chat:graphVersions', runId)).length > versions.length);
  }
  await manager("What's happening?");
  await manager('Pause');
  check('Run paused', (await inv('runs:snapshot', runId)).run.status === 'paused');
  await shot('03-manager');
  for (const role of ['Designer','Coder']) {
    await win.getByRole('button', { name: new RegExp('^' + role + ':') }).click();
    check(role + ' shows real messages', await win.getByText(/Requirement update v/).count() > 0);
    await win.getByPlaceholder('Message ' + role + '…', { exact: true }).fill('What are you working on?');
    await win.getByRole('button', { name: 'Send', exact: true }).click();
    await until(async () => { const h = await inv('run:chat:history', runId + ':' + role.toLowerCase()); return h.at(-1)?.senderType === 'agent' && h.at(-1)?.status === 'complete'; });
    await shot('04-' + role.toLowerCase());
    await win.locator('.agent-panel-tabs').getByRole('tab', { name: 'Tasks', exact: true }).click();
    check(role + ' task panel populated', await win.locator('.agent-panel-detail article').count() > 0);
  }
  const openWidth = (await win.locator('.build-graph-surface').boundingBox()).width;
  await win.getByRole('button', { name: 'Close agent panel' }).click();
  check('Graph expands on close', (await win.locator('.build-graph-surface').boundingBox()).width > openWidth + 300);
  await shot('05-expanded');
  await win.getByRole('button', { name: 'Manager', exact: true }).click();
  await splitReset();
  const panelWidth = (await win.locator('.build-agent-panel').boundingBox()).width;
  const split = win.getByRole('separator', { name: 'Resize agent panel' });
  const splitBox = await split.boundingBox();
  await win.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y + 150);
  await win.mouse.down(); await win.mouse.move(splitBox.x - 30, splitBox.y + 150, { steps: 5 }); await win.mouse.up();
  await split.focus(); await win.keyboard.press('ArrowLeft');
  await split.blur();
  check('Panel resizes', (await win.locator('.build-agent-panel').boundingBox()).width > panelWidth);
  await shot('06-resized');
  await resize(1000, 760);
  await win.getByRole('tab', { name: 'Graph', exact: true }).click();
  await shot('07-medium');
  await resize(720, 800);
  await win.getByRole('tab', { name: 'Manager', exact: true }).click();
  await shot('08-narrow-chat');
  await win.getByRole('button', { name: 'Close agent panel' }).click();
  await shot('09-narrow-graph');
  check('No page overflow', await win.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await resize(1536, 1024);
  await win.getByRole('button', { name: /^Manager:/ }).click();
  await manager('Resume');
  check('Same run resumed', (await inv('runs:snapshot', runId)).run.status === 'running');
  await shot('10-final-live');
  await manager('Pause');
  check('No renderer errors', report.errors.length === 0);
  report.snapshot = await inv('runs:snapshot', runId);
} catch (e) { report.failure = String(e); console.log('FAIL', String(e)); await shot('failure').catch(() => {}); process.exitCode = 1; }
finally { save(); if (runId) await inv('runs:pause', runId).catch(() => {}); console.log('REPORT', path.join(folder, uiOnly ? 'report-ui.json' : 'report.json')); if (process.argv.includes('--keep-open') && !report.failure) { console.log('QA COMPLETE — app left open with the test run paused.'); await new Promise(() => {}); } await app.close(); }
