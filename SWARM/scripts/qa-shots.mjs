// UI QA helper: launches the built app with Playwright's Electron driver and captures screenshots.
// Usage: node scripts/qa-shots.mjs [--fresh] [--dark] [--keep-open=ms]
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.swarm-test', 'shots');
const userData = path.join(root, '.swarm-test', 'userdata');
const fresh = process.argv.includes('--fresh');
if (fresh) fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const electronPath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SWARM_USER_DATA: userData } });
const win = await app.firstWindow();
win.on('console', (m) => { if (m.type() === 'error') console.log('[renderer error]', m.text()); });
win.on('pageerror', (e) => console.log('[pageerror]', e.message));
await win.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
const shot = async (name) => { await win.waitForTimeout(700); await win.screenshot({ path: path.join(outDir, `${name}.png`) }); console.log('shot', name); };

await win.waitForTimeout(1500);
const first = await win.evaluate(() => window.swarm.invoke('app:bootstrap'));
if (first.firstRun) {
  await shot('01-onboarding-intro');
  await win.waitForTimeout(1500);
  await shot('02-onboarding-setup');
  const cont = win.getByRole('button', { name: 'Continue' });
  if (await cont.count()) {
    await cont.click();
    await win.getByRole('button', { name: 'Start building' }).waitFor({ state: 'visible' });
    await win.waitForFunction(() => !document.querySelector('button[disabled]')?.textContent?.includes('Start building'), null, { timeout: 180000 }).catch(() => undefined);
    await shot('03-onboarding-done');
    await win.getByRole('button', { name: 'Start building' }).click();
  }
}
await win.waitForTimeout(1200);
if (process.argv.includes('--dark')) await win.evaluate(() => window.swarm.invoke('settings:update', { appearance: { theme: 'dark' } }));
else await win.evaluate(() => window.swarm.invoke('settings:update', { appearance: { theme: 'light' } }));
await win.getByRole('button', { name: 'Home' }).first().click();
await shot('10-home');
await win.getByRole('button', { name: 'Models' }).first().click();
await shot('11-models');
await win.getByRole('button', { name: 'Settings' }).first().click();
await shot('12-settings');
await win.getByRole('button', { name: 'Providers' }).first().click();
await shot('13-settings-providers');
await win.getByRole('button', { name: 'Agents' }).first().click();
await shot('14-agents');
const demo = win.getByText('Delhi Sneaker Store').first();
if (await demo.count()) { await demo.click(); await shot('15-build-demo'); }
await win.keyboard.press('Control+K');
await shot('16-palette');
await win.keyboard.press('Escape');
const keep = Number((process.argv.find((a) => a.startsWith('--keep-open=')) ?? '=0').split('=')[1]);
if (keep) await win.waitForTimeout(keep);
await app.close();
