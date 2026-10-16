// Explicit diagnostic mode: real production services, isolated persistence and test pairing.
import { app, BrowserWindow } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb } from '../core/db';
import { updateSettings } from '../core/settings';
import { bus } from '../core/bus';
import { loadRegistry } from '../providers/registry';
import { registerIpc, callHandler } from '../ipc';
import { loadOrCreateCert } from './cert';
import { DeviceStore } from './devices';
import { PairingManager } from './pairing';
import { RemoteServer } from './server';
import { Gateway } from './gateway';
import { Ipv6Route, LanRoute, RouteManager } from './routes';
import { getChat, newChat, sendChat, stopAllChats } from '../chat/service';

export async function diagnosticHost() {
  const sourceFile = process.env.SWARM_DIAGNOSTIC_SOURCE_DB ?? path.join(app.getPath('userData'), 'swarm.db');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v3-diagnostic-'));
  const database = initDb(path.join(directory, 'swarm.db'));
  if (fs.existsSync(sourceFile)) {
    const source = new DatabaseSync(sourceFile, { readOnly: true });
    try {
      const settings = source.prepare('SELECT value FROM kv WHERE key = ?').get('settings') as {value:string} | undefined;
      if (settings) database.kvSet('settings', settings.value);
      for (const row of source.prepare('SELECT id, value FROM secrets').all()) database.prepare('INSERT INTO secrets(id,value) VALUES(?,?)').run(row.id, row.value);
      for (const row of source.prepare('SELECT id, provider_id, data FROM models').all()) database.prepare('INSERT INTO models(id,provider_id,data) VALUES(?,?,?)').run(row.id, row.provider_id, row.data);
    } finally { source.close(); }
  }
  updateSettings({ workspace: { root: path.join(directory, 'workspace') }, remote: { enabled: false }, computer: { native: true }, behavior: { notifications: false } });
  loadRegistry(); registerIpc(() => null);
  const tls = await loadOrCreateCert(path.join(directory, 'tls.json'));
  const pairing = new PairingManager();
  const routes = new RouteManager().add(new LanRoute()).add(new Ipv6Route());
  const server = new RemoteServer({ tls, port: 0, pcName: 'SWARM V3 diagnostic', devices: new DeviceStore(path.join(directory, 'devices.json')), pairing,
    gateway: new Gateway(callHandler, { pcName: 'SWARM V3 diagnostic', appVersion: app.getVersion() }), confirmPair: async () => true,
    getHosts: async () => routes.collectHosts(), diagnostics: () => ({ routes: routes.statuses(), isolated: true }) });
  await server.start(); await routes.startAll({ port: server.port });
  for (const channel of ['chat:turn', 'run:chat:updated', 'approvals:changed', 'computer:activity', 'workspace:event', 'notification']) bus.on(channel, payload => server.publishApp(channel, payload));
  bus.on('event', event => { if (event.type !== 'AGENT_STREAM') server.publishEvent(event); });
  const pairingFile = path.join(process.cwd(), '_perf', 'v3-diagnostic-pairing.json');
  const writePairing = async () => {
    const {token} = pairing.generate();
    fs.writeFileSync(pairingFile, JSON.stringify({ v: 1, hosts: [`localhost:${server.port}`, ...(await routes.collectHosts())], fp: tls.fingerprint, tok: token, name: 'SWARM V3 diagnostic' }));
  };
  await writePairing();
  const refresh = setInterval(() => { void writePairing(); }, 90000);
  const target = new BrowserWindow({ width: 640, height: 420, title: 'SWARM V3 diagnostic window', webPreferences: { sandbox: true } });
  await target.loadURL('data:text/html,' + encodeURIComponent('<h2>SWARM V3 diagnostic window</h2><p>Connection verification code: ORCHID 428</p><textarea autofocus style="width:90%;height:160px" placeholder="Native input test"></textarea>'));
  target.setAlwaysOnTop(true); target.show(); target.focus();
  console.log('V3_DIAGNOSTIC_READY', JSON.stringify({ directory, pairingFile, hosts: await routes.collectHosts(), port: server.port }));
  const report: Record<string, unknown> = { directory, started: Date.now() };
  const ask = async (id: string, text: string) => {
    sendChat({ id, text });
    const deadline = Date.now() + 240000;
    while (getChat(id).turns.at(-1)?.status === 'streaming') {
      if (Date.now() > deadline) { stopAllChats(); throw new Error('Real model check timed out'); }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return getChat(id).turns.at(-1)!;
  };
  if (!process.argv.includes('--no-model-check')) void (async () => {
    try {
      const chat = newChat();
      const greeting = await ask(chat.id, 'Hey, what are you doing?');
      report.greeting = { status: greeting.status, text: greeting.text, model: greeting.model, error: greeting.error };
      const inspection = await ask(chat.id, 'Please check the visible SWARM V3 diagnostic window on my PC. Use a screenshot and tell me the connection verification code you see. Do not interact with other windows.');
      report.inspection = { status: inspection.status, text: inspection.text, model: inspection.model, error: inspection.error, activities: inspection.activities?.map(({preview,...activity}) => activity) };
    } catch (error) { report.error = String(error); }
    fs.writeFileSync(path.join(process.cwd(), '_perf', 'v3-real-model-report.json'), JSON.stringify(report, null, 2));
    console.log('V3_REAL_MODEL_CHECK', JSON.stringify(report));
  })();
  app.once('before-quit', () => { clearInterval(refresh); stopAllChats(); void server.stop(); void routes.stopAll(); try { fs.unlinkSync(pairingFile); } catch {} });
}
