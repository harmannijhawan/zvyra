import { _electron as electron } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const label = process.argv[2] ?? 'after';
const dir = path.join(root, '.swarm-test', `factory-${label}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, 'swarm.db'));
db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
const settings = { providers: { useEnvKeys: false, enabled: Object.fromEntries(['nvidia','openrouter','groq','google','cloudflare','huggingface','cerebras','mistral','ollama'].map(x => [x, false])) }, routing: { healthCheckOnStartup: false, discoveryIntervalMin: 0 }, workspace: { root: path.join(dir, 'projects') } };
for (const [k,v] of Object.entries({ onboarded: '1', settings: JSON.stringify(settings) })) db.prepare('INSERT INTO kv VALUES (?,?)').run(k,v);
db.close();
const start = performance.now();
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root, '--smoke'], env: { ...process.env, SWARM_USER_DATA: dir } });
const win = await app.firstWindow();
const errors = []; win.on('pageerror', e => errors.push(e.message));
try {
  await win.locator('#chat-input').waitFor();
  const startupMs = performance.now() - start;
  const measurements = [];
  for (const [width, height] of [[1280,720],[1440,900],[1920,1080],[2560,1440]]) {
    await win.setViewportSize({ width, height });
    for (const mode of ['Chat','Build']) {
      const t = performance.now();
      await win.getByRole('button', { name: mode, exact: true }).click();
      await win.locator(mode === 'Chat' ? '#chat-input' : '#composer-input').waitFor();
      measurements.push({ mode, width, height, switchMs: performance.now() - t, overflow: await win.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
      await win.screenshot({ path: path.join(dir, `${mode}-${width}.png`) });
    }
  }
  await win.keyboard.press('Control+k');
  await win.screenshot({ path: path.join(dir, 'palette.png') });
  await win.keyboard.press('Escape');
  const metrics = await app.evaluate(({app}) => app.getAppMetrics().map(p => ({ type: p.type, cpu: p.cpu.percentCPUUsage, memoryKB: p.memory.workingSetSize })));
  const report = { label, startupMs, measurements, metrics, errors, provider: 'disabled; no model latency measurement' };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report,null,2));
  console.log(JSON.stringify({ dir, ...report }));
  if(errors.length || measurements.some(m => m.overflow)) process.exitCode = 1;
} finally { await app.close(); }
