import { startAccountSync, stopAccountSync, syncAccount } from './account/sync';
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, session, shell, Tray } from 'electron';
import path from 'node:path';
import { initDb, db } from './core/db';
import { bus } from './core/bus';
import { getSettings, onSettings } from './core/settings';
import { callHandler, registerIpc } from './ipc';
import { startRemote, stopRemote } from './remote';
import { discoverAll, healthCheckSample, loadRegistry, setManagedAvailability } from './providers/registry';
import { accountStatus } from './account/sync';
import { cancelAll } from './agents/orchestrator';
import { stopAllChats } from './chat/service';
import { cancelExperiment } from './core/experiments';
import { stopAll } from './tools/process';
import { stopAllStatic } from './tools/staticServer';
import { closeBrowser } from './browser/browser';
import { workspaceRoot } from './projects/projects';
import type { Project, Run, Task } from '../shared/types';
import { markInterruptedRuns } from './core/recovery';

let win: BrowserWindow | null = null;
let webWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Tray mode: closing the window only hides it; Quit (tray menu) is the only way to really exit. */
let isQuitting = false;
const isSmoke = process.argv.includes('--smoke');
const isRemoteSelfTest = process.argv.includes('--remote-self-test');
const isDiagnosticHost = process.argv.includes('--remote-diagnostic-host');

if (!isRemoteSelfTest && !isDiagnosticHost && !app.requestSingleInstanceLock() && !isSmoke && !process.argv.includes('--web-smoke') && !process.argv.includes('--account-sync-only')) app.quit();
function showWindow() {
  if (!win && webWindow && !webWindow.isDestroyed()) { if (webWindow.isMinimized()) webWindow.restore(); webWindow.show(); webWindow.focus(); return; }
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
app.on('second-instance', () => { showWindow(); });
app.setAppUserModelId('ai.swarm.desktop');
if (process.env.SWARM_USER_DATA) app.setPath('userData', process.env.SWARM_USER_DATA);

const resources = () => (app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.join(__dirname, '..', '..', 'resources'));
const appIconPath = () => path.join(resources(), process.platform === 'win32' ? 'icon.ico' : 'icon.png');
/** With an explicit AppUserModelID, Windows takes the taskbar icon from the exe (the Electron atom
 *  when running unpackaged via `electron .`). Pin the taskbar/relaunch icon to our own .ico. */
function applyTaskbarIcon(w: BrowserWindow) {
  if (process.platform === 'win32') w.setAppDetails({ appId: 'ai.swarm.desktop', appIconPath: appIconPath(), appIconIndex: 0 });
}

function createWebWindow() {
  if(webWindow&&!webWindow.isDestroyed()){webWindow.show();webWindow.focus();return;}
  const origin='https://www.swarmgpt.online';
  webWindow=new BrowserWindow({width:1440,height:920,minWidth:680,minHeight:640,title:'SWARM',backgroundColor:'#ffffff',icon:appIconPath(),webPreferences:{partition:'persist:swarm-web',nodeIntegration:false,contextIsolation:true,sandbox:true,webviewTag:false}});
  const current=webWindow;
  applyTaskbarIcon(current);
  current.webContents.setWindowOpenHandler(({url})=>{if(/^https:\/\//.test(url))void shell.openExternal(url);return {action:'deny'};});
  current.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin){event.preventDefault();if(url.startsWith('https://'))void shell.openExternal(url);}});
  current.webContents.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3)void current.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html><body style="font:16px system-ui;padding:60px"><h1>SWARM needs a connection</h1><p>Reconnect, then choose Workspace → Reload web workspace. Local projects remain available under Workspace → Local desktop tools.</p></body></html>'));});
  current.setMenu(Menu.buildFromTemplate([{label:'Workspace',submenu:[{label:'Web workspace',click:()=>void current.loadURL(origin+'/app')},{label:'Local desktop tools',click:()=>{if(win&&!win.isDestroyed()){win.show();win.focus();}else createWindow();}},{label:'Reload web workspace',accelerator:'CmdOrCtrl+R',click:()=>void current.loadURL(origin+'/app')},{type:'separator'},{role:'quit'}]},{role:'editMenu'},{role:'viewMenu'}]));
  current.on('close',event=>{if(!isQuitting&&tray){event.preventDefault();current.hide();}});
  current.on('closed',()=>{webWindow=null;});
  void current.loadURL(origin+'/app');
  if(process.argv.includes('--web-smoke'))current.webContents.once('did-finish-load',()=>{void current.webContents.executeJavaScript('JSON.stringify({url:location.href,title:document.title,nativeBridge:typeof window.swarm})').then(result=>{console.log('SWARM_WEB_SMOKE '+result);app.exit(current.webContents.getURL().startsWith(origin)?0:1);});});
}

function createWindow() {
  const s = getSettings();
  const dark = s.appearance.theme === 'dark' || (s.appearance.theme === 'system' && nativeTheme.shouldUseDarkColors);
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 680, minHeight: 640,
    show: false,
    title: 'SWARM',
    icon: appIconPath(),
    backgroundColor: dark ? '#0d0d0f' : '#fbfbfa',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'win32' ? { color: dark ? '#0d0d0f' : '#fbfbfa', symbolColor: dark ? '#e8e8ea' : '#2a2a2e', height: 40 } : undefined,
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: false,
      devTools: true,
    },
  });
  applyTaskbarIcon(win);
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && getSettings().computer.openExternal) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
  // Guest <webview> (browser preview) hardening.
  win.webContents.on('will-attach-webview', (_e, prefs, params) => {
    delete (prefs as Record<string, unknown>).preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    if (!/^https?:\/\//.test(params.src ?? '') && params.src !== 'about:blank') params.src = 'about:blank';
  });
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!isQuitting && tray && !isSmoke) { e.preventDefault(); win?.hide(); }
  });
  win.on('closed', () => { win = null; });
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(appIconPath());
    if (img.isEmpty()) return;
    tray = new Tray(process.platform === 'win32' ? img : img.resize({ width: 18, height: 18 }));
    tray.setToolTip('SWARM');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open SWARM', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
      { label: 'Open web workspace', click: () => createWebWindow() },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => showWindow());
    tray.on('double-click', () => showWindow());
  } catch (e) { console.error('tray failed', e); tray = null; }
}

function retention() {
  const s = getSettings();
  const d = db();
  d.prepare('DELETE FROM events WHERE ts < ?').run(Date.now() - s.logs.retentionDays * 86400_000);
  d.prepare('DELETE FROM cache WHERE ts < ?').run(Date.now() - 30 * 86400_000);
  const cutoff = Date.now() - s.memory.retentionDays * 86400_000;
  d.prepare('DELETE FROM usage WHERE ts < ?').run(cutoff);
  d.prepare('DELETE FROM notifications WHERE ts < ?').run(cutoff);
}

/** Runs that were active when SWARM last exited are marked as interrupted (never left "running"). */
function recoverInterrupted() {
  const d = db();
  markInterruptedRuns(d);
  for (const p of d.list<Project>('projects', "json_extract(data, '$.status') = 'running'")) d.put('projects', p.id, { ...p, status: 'idle' }, { updated_at: p.updatedAt });
}

let discoveryTimer: NodeJS.Timeout | null = null;
function scheduleDiscovery() {
  if (discoveryTimer) clearInterval(discoveryTimer);
  const mins = getSettings().routing.discoveryIntervalMin;
  if (mins > 0) discoveryTimer = setInterval(() => { void discoverAll(); }, mins * 60_000);
}

app.whenReady().then(async () => {
  if (isDiagnosticHost) {
    const { diagnosticHost } = await import('./remote/diagnosticHost');
    await diagnosticHost();
    return;
  }
  if (isRemoteSelfTest) {
    const { remoteSelfTest } = await import('./remote/selfTest');
    app.exit(await remoteSelfTest() ? 0 : 1);
    return;
  }
  initDb(path.join(app.getPath('userData'), 'swarm.db'));
  if(process.argv.includes('--account-sync-only')) {
    try {await startAccountSync();const status=await syncAccount();console.log(JSON.stringify({account:status.account,connected:status.connected,lastSync:status.lastSync,error:status.error,chats:db().list('conversations').length}));stopAccountSync();db().close();app.exit(status.error?1:0);}catch{app.exit(1);}return;
  }
  const s = getSettings();
  bus.debug = s.logs.level === 'debug';
  bus.persist = s.privacy.storeLogs;
  try { retention(); } catch (e) { console.error('retention failed', e); }
  recoverInterrupted();
  workspaceRoot();
  // SWARM account models are routable only while signed in; local provider keys work without an account.
  setManagedAvailability(() => accountStatus().connected);
  loadRegistry();
  bus.attach(
    (events) => win?.webContents.send('events', events),
    (channel, payload) => win?.webContents.send(channel, payload),
  );
  registerIpc(() => win);
  void startAccountSync().catch(() => console.error('Account connection could not start.'));
  startRemote({ invoke: callHandler, send: (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); } });
  // Content Security Policy for the app renderer (guest webviews are separate).
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    if (details.url.startsWith('file://')) {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; img-src 'self' data: blob: https://img.clerk.com https://images.clerk.dev; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'"] } });
    } else cb({ responseHeaders: details.responseHeaders });
  });
  createTray();
  // The desktop IDE is the local workspace. The hosted web workspace stays one click away (tray / Workspace menu).
  if(process.argv.includes('--web-smoke'))createWebWindow();else createWindow();
  onSettings(() => scheduleDiscovery());
  scheduleDiscovery();
  // Model discovery + health checks run in the background; the UI is usable immediately.
  if (!isSmoke) {
    void discoverAll().then(() => { if (getSettings().routing.healthCheckOnStartup) return healthCheckSample(4); });
  }
});

let cleaned = false;
async function cleanup() {
  if (isRemoteSelfTest) return;
  if (cleaned) return;
  cleaned = true;
  stopAccountSync();
  await stopRemote().catch(() => undefined); // closes the bridge and removes router port mappings
  cancelExperiment();
  cancelAll();
  stopAllChats();
  stopAll();
  stopAllStatic();
  await (await import('./runtime/manager')).runtimeManager.dispose();
  await closeBrowser();
  bus.flush();
  db().close();
}

app.on('before-quit', (e) => {
  isQuitting = true;
  tray?.destroy(); tray = null;
  if (cleaned) return;
  e.preventDefault();
  void cleanup().finally(() => app.exit(0));
});
// Tray mode: the app keeps running (agents, remote bridge) without a window. Quit from the tray menu.
app.on('window-all-closed', () => { if (isSmoke || !tray) app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); else showWindow(); });
