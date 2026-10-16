// Remote bridge lifecycle + IPC for the "Set up your phone" screen. main.ts calls startRemote() / stopRemote().
import { app } from 'electron';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { bus } from '../core/bus';
import { getSettings, updateSettings } from '../core/settings';
import { errMsg, redact, truncate } from '../core/util';
import type { SwarmEvent } from '../../shared/types';
import { loadOrCreateCert, type TlsIdentity } from './cert';
import { allowOtherNetworks, firewallState, loadConnectivityModule, loadConnectivityRoutes, loadedConnectivity, connectivityStatus } from './connectivityHook';
import { DeviceStore, type PublicDevice } from './devices';
import { Gateway, type Invoke } from './gateway';
import { PairingManager } from './pairing';
import { DEFAULT_PORT, PROTOCOL_VERSION, randomB64Url } from './protocol';
import { Ipv6Route, LanRoute, ManualRoute, RouteManager, UpnpRoute, type RouteStatus } from './routes';
import { RemoteServer, type PairRequestInfo } from './server';
import type { AllowNetworksResult, PairingCode, RemoteState } from './state';

export interface RemoteDeps { invoke: Invoke; send: (channel: string, payload: unknown) => void }
interface PendingPair { id: string; deviceName: string; code: string; expiresAt: number; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }

export type { RemoteState };

let deps: RemoteDeps | null = null;
let devicesStore: DeviceStore | null = null;
const pairing = new PairingManager();
let server: RemoteServer | null = null;
let routes: RouteManager | null = null;
let tls: TlsIdentity | null = null;
let lastError: string | null = null;
let pending: PendingPair | null = null;
let activity: { route: string; at: number } | null = null;
let offBus: (() => void) | null = null;
let busy: Promise<unknown> = Promise.resolve();
/** Set once the user's firewall action succeeded (the module's own probe only refreshes periodically). */
let fwAllowed = false;

const dir = () => path.join(app.getPath('userData'), 'remote');
const pcName = () => os.hostname() || 'SWARM PC';
const devices = () => (devicesStore ??= new DeviceStore(path.join(dir(), 'devices.json')));
const serial = <T,>(fn: () => Promise<T>): Promise<T> => { const p = busy.then(fn, fn); busy = p.catch(() => undefined); return p; };
const notify = () => { try { deps?.send('remote:changed', getRemoteState()); } catch { /* window may be gone */ } };

export function getRemoteState(): RemoteState {
  const s = getSettings().remote;
  const likely = routes?.likely() ?? null;
  const recent = activity && Date.now() - activity.at < 5 * 60_000 ? activity.route : null;
  return {
    enabled: s.enabled, running: !!server, port: server?.port || s.port, pcName: pcName(), fingerprint: tls?.fingerprint ?? null, error: lastError,
    manualHost: s.manualHost,
    routes: (routes?.statuses() ?? []).map((r) => ({ ...r, likely: r.id === likely, inUse: r.id === recent })),
    devices: devices().list(),
    pairing: pairing.status(),
    otherNetworks: { available: !!loadedConnectivity(), firewall: fwAllowed ? 'allowed' : firewallState() },
    pendingPair: pending ? { id: pending.id, deviceName: pending.deviceName, code: pending.code, expiresAt: pending.expiresAt } : null,
  };
}

function confirmPair(info: PairRequestInfo): Promise<boolean> {
  if (pending) { clearTimeout(pending.timer); pending.resolve(false); pending = null; }
  return new Promise<boolean>((resolve) => {
    const id = randomB64Url(8);
    const timer = setTimeout(() => { if (pending?.id === id) { pending = null; resolve(false); notify(); } }, 60_000);
    pending = { id, deviceName: info.deviceName, code: info.code, expiresAt: Date.now() + 60_000, resolve, timer };
    notify();
  });
}

export function resolvePendingPair(id: string, accept: boolean): RemoteState {
  if (pending && pending.id === id) { clearTimeout(pending.timer); const p = pending; pending = null; p.resolve(accept); }
  notify();
  return getRemoteState();
}

function sanitiseEvent(e: SwarmEvent) {
  const agentState = e.type === 'AGENT_STATUS' ? e.data?.agent : undefined;
  const rawTask = e.type.startsWith('TASK_') ? e.data?.task as import('../../shared/types').Task | undefined : undefined;
  const task = rawTask ? { id: rawTask.id, title: rawTask.title, role: rawTask.role, kind: rawTask.kind, status: rawTask.status, startedAt: rawTask.startedAt, endedAt: rawTask.endedAt, filesTouched: rawTask.filesTouched } : undefined;
  return { id: e.id, ts: e.ts, type: e.type, level: e.level, projectId: e.projectId, runId: e.runId, agent: e.agent, message: truncate(redact(String(e.message ?? '')), 500), agentState, task };
}

async function doEnable() {
  if (server) return;
  lastError = null;
  try {
    const s = getSettings().remote;
    tls = await loadOrCreateCert(path.join(dir(), 'tls.json'));
    const gateway = new Gateway(deps!.invoke, { pcName: pcName(), appVersion: app.getVersion() });
    const srv = new RemoteServer({
      tls, port: s.port, pcName: pcName(), devices: devices(), pairing, gateway, confirmPair,
      getHosts: async () => (await routes?.collectHosts()) ?? [],
      diagnostics: () => ({ firewall: firewallState(), connectivity: connectivityStatus(), routes: routes?.statuses() ?? [] }),
      onActivity: ({ via }) => {
        const r = routes; if (!r) return;
        const st = new Map(r.statuses().map((x) => [x.id, x.state]));
        const route = via === 'public' ? (st.get('upnp') === 'ready' ? 'upnp' : st.get('manual') === 'ready' ? 'manual' : st.get('connectivity') === 'ready' ? 'connectivity' : 'manual') : via === 'local' ? '' : via;
        if (route) { activity = { route, at: Date.now() }; notify(); }
      },
    });
    const port = await srv.start();
    server = srv;
    const rm = new RouteManager().add(new LanRoute()).add(new Ipv6Route()).add(new ManualRoute(() => getSettings().remote.manualHost));
    // The connectivity module (when present) owns router mapping; otherwise the built-in UPnP route does. Never both.
    const ext = await loadConnectivityRoutes({ fingerprint: tls.fingerprint, pcName: pcName() });
    if (ext.length) ext.forEach((r) => rm.add(r)); else rm.add(new UpnpRoute());
    routes = rm;
    await rm.startAll({ port });
    offBus = (() => {
      const fn = (e: SwarmEvent) => { if (e.type === 'AGENT_STREAM') return; if (e.level !== 'debug' || e.type === 'AGENT_STATUS' || e.type.startsWith('TASK_')) srv.publishEvent(sanitiseEvent(e)); };
      bus.on('event', fn);
      const channels = ['chat:turn', 'run:chat:updated', 'approvals:changed', 'computer:activity', 'workspace:event', 'notification'];
      const listeners = channels.map(channel => { const listener = (payload: unknown) => srv.publishApp(channel, payload); bus.on(channel, listener); return listener; });
      return () => { bus.off('event', fn); channels.forEach((channel, i) => bus.off(channel, listeners[i])); };
    })();
  } catch (e) {
    lastError = e instanceof Error && (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${getSettings().remote.port} is already in use` : errMsg(e);
    await doDisable();
    updateSettings({ remote: { enabled: false } });
  }
}

async function doDisable() {
  offBus?.(); offBus = null;
  pairing.cancel();
  if (pending) { clearTimeout(pending.timer); pending.resolve(false); pending = null; }
  const r = routes; routes = null;
  const s = server; server = null;
  activity = null;
  await r?.stopAll().catch(() => undefined); // unmaps UPnP
  await s?.stop().catch(() => undefined);
}

export function startRemote(d: RemoteDeps) {
  deps = d;
  if (getSettings().remote.enabled) void serial(doEnable).then(notify);
}

/** Stops the bridge and removes router port mappings. Safe to call repeatedly. */
export async function stopRemote() {
  await serial(doDisable);
}

export async function setRemoteEnabled(on: boolean): Promise<RemoteState> {
  updateSettings({ remote: { enabled: on } });
  await serial(on ? doEnable : doDisable);
  notify();
  return getRemoteState();
}

export async function generatePairing(): Promise<PairingCode> {
  if (!server || !tls) throw new Error('Phone connection is turned off');
  const { token, expiresAt } = pairing.generate();
  const hosts = (await routes?.collectHosts()) ?? [];
  const payload = JSON.stringify({ v: PROTOCOL_VERSION, hosts, fp: tls.fingerprint, tok: token, name: pcName() });
  const dataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
  notify();
  return { dataUrl, payload, expiresAt, hosts };
}

type Handle = (channel: string, fn: (...args: never[]) => unknown) => void;
export function registerRemoteIpc(handle: Handle) {
  handle('remote:state', async () => { await loadConnectivityModule(); return getRemoteState(); });
  // Explicit user action only (one UAC prompt). Deliberately NOT in the remote gateway allow-list.
  handle('remote:allowOtherNetworks', async (): Promise<AllowNetworksResult> => {
    await loadConnectivityModule();
    const r = await allowOtherNetworks(getSettings().remote.port);
    if (r.ok) fwAllowed = true;
    notify();
    return { ...r, state: getRemoteState() };
  });
  handle('remote:enable', (on: boolean) => setRemoteEnabled(!!on));
  handle('remote:generatePairing', () => generatePairing());
  handle('remote:listDevices', () => devices().list());
  handle('remote:revokeDevice', (id: string) => { devices().revoke(String(id)); notify(); return getRemoteState(); });
  handle('remote:confirmPair', (id: string, accept: boolean) => resolvePendingPair(String(id), !!accept));
  handle('remote:setManualHost', (host: string) => {
    const h = String(host ?? '').trim().slice(0, 253);
    if (h && !/^[A-Za-z0-9_.:\[\]\/-]+$/.test(h)) throw new Error('Invalid address');
    updateSettings({ remote: { manualHost: h } }); notify(); return getRemoteState();
  });
  handle('remote:setPort', async (port: number) => {
    const p = Math.floor(Number(port));
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Port must be 1024-65535');
    updateSettings({ remote: { port: p } });
    if (server) { await serial(doDisable); await serial(doEnable); }
    notify(); return getRemoteState();
  });
}

export { DEFAULT_PORT };
