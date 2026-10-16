// End-to-end check: drives the real UI to start a run and watches it to completion.
// Usage: node scripts/e2e-run.mjs "<objective>" [--no-web] [--minutes=25] [--tag=name]
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const objective = process.argv[2];
const noWeb = process.argv.includes('--no-web');
const minutes = Number((process.argv.find((a) => a.startsWith('--minutes=')) ?? '=25').split('=')[1]);
const tag = (process.argv.find((a) => a.startsWith('--tag=')) ?? '=run').split('=')[1];
const outDir = path.join(root, '.swarm-test', 'shots', tag);
fs.mkdirSync(outDir, { recursive: true });
const userData = path.join(root, '.swarm-test', 'userdata');

const app = await electron.launch({ executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], env: { ...process.env, SWARM_USER_DATA: userData, SWARM_DEBUG_CANCEL: '1' } });
const win = await app.firstWindow();
app.process().stdout?.on('data', (d) => process.stdout.write('[main] ' + d));
app.process().stderr?.on('data', (d) => { const s = String(d); if (!/DevTools|GPU|gpu_|Autofill/.test(s)) process.stdout.write('[main:err] ' + s.slice(0, 400)); });
win.on('pageerror', (e) => console.log('[pageerror]', e.message));
win.on('console', (m) => { if (m.type() === 'error') console.log('[renderer error]', m.text().slice(0, 300)); });
await win.waitForTimeout(2500);
await win.getByRole('button', { name: 'Home' }).first().click();
await win.fill('#composer-input', objective);
if (noWeb) await win.getByRole('button', { name: 'Web', exact: true }).click();
await win.focus('#composer-input');
await win.keyboard.press('Enter');
await win.waitForTimeout(3000);
await win.screenshot({ path: path.join(outDir, 'start.png') });
let runs = await win.evaluate(() => window.swarm.invoke('runs:active'));
if (!runs.length) runs = (await win.evaluate(() => window.swarm.invoke('runs:list'))).filter((r) => Date.now() - r.startedAt < 60000);
if (!runs.length) { console.log('No run started'); await app.close(); process.exit(1); }
const runId = runs[0].id;
console.log('run', runId);
const started = Date.now();
let n = 0, lastEventCount = 0;
for (;;) {
  await win.waitForTimeout(15000);
  const snap = await win.evaluate((id) => window.swarm.invoke('runs:snapshot', id), runId);
  const events = await win.evaluate((id) => window.swarm.invoke('runs:events', { runId: id, limit: 5000 }), runId);
  const fresh = events.slice(lastEventCount).filter((e) => e.level !== 'debug' || /MODEL_ERROR|MODEL_FALLBACK/.test(e.type));
  lastEventCount = events.length;
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n[${mins}m] status=${snap.run.status} tasks=${snap.tasks.map((t) => `${t.role}:${t.status}`).join(' ')}`);
  for (const e of fresh.slice(-25)) console.log(`  ${e.type} ${e.agent ?? ''} ${e.message.slice(0, 200)}`);
  if (n++ % 4 === 0) await win.screenshot({ path: path.join(outDir, `t${String(n).padStart(2, '0')}.png`) });
  if (snap.run.status !== 'running' || Date.now() - started > minutes * 60000) {
    await win.screenshot({ path: path.join(outDir, 'final.png') });
    console.log('\nFINAL', snap.run.status, 'repairCycles', snap.run.repairCycles, 'preview', snap.run.previewUrl);
    for (const g of snap.run.gates) console.log(`  gate ${g.label}: ${g.status} — ${g.detail ?? ''}`);
    console.log('summary:', snap.run.summary);
    console.log('project dir:', (await win.evaluate((pid) => window.swarm.invoke('projects:get', pid), snap.run.projectId)).path);
    if (snap.run.status === 'running') await win.evaluate((id) => window.swarm.invoke('runs:cancel', id), runId);
    break;
  }
}
await win.waitForTimeout(1500);
await app.close();
