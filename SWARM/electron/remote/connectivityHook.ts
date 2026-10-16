// Optional plug-in point for electron/remote/connectivity/* (Swarm Connectivity module).
// Resolved through the virtual module 'swarm-remote-connectivity' (see scripts/build-main.mjs); absent => bridge runs without it.
// Used exports: getCandidateEndpoints(port?), start({port,fingerprint,pcName}), stop(), getConnectivityStatus(),
// ensureFirewallRuleElevated(port) (only from the explicit "Allow connections from other networks" button).
import { isIP } from 'node:net';
import type { RouteContext, RouteProvider, RouteState, RouteStatus } from './routes';
import { isPrivateV4 } from './routes';

export interface FirewallResult { ok: boolean; already?: boolean; denied?: boolean; error?: string }
export interface ConnMod {
  getCandidateEndpoints?: (port?: number) => Promise<string[]>;
  start?: (ctx: { port: number; fingerprint: string; pcName: string }) => Promise<void> | void;
  stop?: () => Promise<void> | void;
  getConnectivityStatus?: () => unknown;
  ensureFirewallRuleElevated?: (port: number) => Promise<FirewallResult>;
}

interface StatusLike {
  running?: boolean;
  upnp?: { attempted?: boolean; mapped?: boolean; externalIp?: string | null; externalPort?: number | null; error?: string | null };
  natpmp?: { attempted?: boolean; mapped?: boolean; externalIp?: string | null; externalPort?: number | null; error?: string | null };
  ipv6?: { firewallRuleOk?: boolean };
}

let loaded: Promise<ConnMod | null> | null = null;
let loadedMod: ConnMod | null = null;

/** Loads the optional module once. Resolves null when it is absent or broken. */
export function loadConnectivityModule(): Promise<ConnMod | null> {
  return (loaded ??= (async () => {
    try {
      const mod = (await import('swarm-remote-connectivity')) as unknown as ConnMod;
      loadedMod = typeof mod?.getCandidateEndpoints === 'function' ? mod : null;
    } catch { loadedMod = null; }
    return loadedMod;
  })());
}
export const loadedConnectivity = (): ConnMod | null => loadedMod;

export function connectivityStatus(): StatusLike | null {
  try { return (loadedMod?.getConnectivityStatus?.() as StatusLike | null) ?? null; } catch { return null; }
}

/** Windows Firewall inbound rule state for the bridge port, when known. */
export function firewallState(): 'allowed' | 'missing' | 'unknown' {
  const ok = connectivityStatus()?.ipv6?.firewallRuleOk;
  return ok === true ? 'allowed' : ok === false ? 'missing' : 'unknown';
}

/** One explicit, user-initiated UAC prompt. Never throws. */
export async function allowOtherNetworks(port: number): Promise<FirewallResult> {
  const mod = await loadConnectivityModule();
  if (!mod?.ensureFirewallRuleElevated) return { ok: false, error: 'Not available on this system' };
  try { return await mod.ensureFirewallRuleElevated(port); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

const withTimeout = <T,>(p: Promise<T>, ms: number, fb: T): Promise<T> => new Promise((res) => { const t = setTimeout(() => res(fb), ms); p.then((v) => { clearTimeout(t); res(v); }, () => { clearTimeout(t); res(fb); }); });
const hasScheme = (e: string) => !e.startsWith('[') && /^[a-z][a-z0-9+.-]*:(?!\d+$)/i.test(e);
const hostOf = (e: string) => (e.startsWith('[') ? e.slice(1, e.indexOf(']')) : e.replace(/:\d+$/, ''));
const isMappedV4 = (e: string) => !hasScheme(e) && !e.startsWith('[') && isIP(hostOf(e)) === 4 && !isPrivateV4(hostOf(e));

/** State shared by the two route providers backed by the module. */
class Shared {
  cached: string[] = [];
  started = false;
  constructor(public mod: ConnMod, public info: { fingerprint: string; pcName: string }) {}
  async refresh(port: number) {
    const list = await withTimeout(this.mod.getCandidateEndpoints!(port), 3500, this.cached);
    this.cached = Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.length > 0 && s.length < 512) : [];
  }
}

/** "Mapped port": router mapping (UPnP / NAT-PMP) managed by the connectivity module. */
class MappedPortRoute implements RouteProvider {
  readonly id = 'upnp'; readonly label = 'Mapped port'; readonly priority = 30;
  constructor(private sh: Shared) {}
  async start(ctx: RouteContext) {
    try { await this.sh.mod.start?.({ port: ctx.port, fingerprint: this.sh.info.fingerprint, pcName: this.sh.info.pcName }); this.sh.started = true; await this.sh.refresh(ctx.port); } catch { /* status reports it */ }
  }
  async stop() { try { await this.sh.mod.stop?.(); } catch { /* ignore */ } this.sh.started = false; this.sh.cached = []; }
  async endpoints(ctx: RouteContext) { try { await this.sh.refresh(ctx.port); } catch { /* keep cache */ } return this.sh.cached.filter(isMappedV4); }
  status(): RouteStatus {
    const mapped = this.sh.cached.filter(isMappedV4);
    const s = connectivityStatus();
    let state: RouteState; let detail: string;
    if (mapped.length) { state = 'ready'; detail = `Mapped ${mapped[0]}`; }
    else if (!this.sh.started || !s) { state = 'pending'; detail = 'Checking…'; }
    else if (s.upnp?.attempted === false && s.natpmp?.attempted === false) { state = 'off'; detail = 'Not started'; }
    else if (s.upnp?.error || s.natpmp?.error) { state = 'failed'; detail = 'Router did not allow a mapping'; }
    else { state = 'unavailable'; detail = 'Not available'; }
    return { id: this.id, label: this.label, state, endpoints: mapped, detail };
  }
}

/** Any other endpoint kinds the module offers (scheme-prefixed entries such as rtc:...). */
class ExtraRoute implements RouteProvider {
  readonly id = 'connectivity'; readonly label = 'Extra routes'; readonly priority = 50;
  constructor(private sh: Shared) {}
  async start() {}
  async stop() {}
  async endpoints() { return this.sh.cached.filter(hasScheme); }
  status(): RouteStatus {
    const e = this.sh.cached.filter(hasScheme);
    return { id: this.id, label: this.label, state: e.length ? 'ready' : 'off', endpoints: e, detail: e.length ? `${e.length} address${e.length === 1 ? '' : 'es'}` : 'None' };
  }
}

/** Providers backed by the connectivity module, or [] when it is absent. */
export async function loadConnectivityRoutes(info: { fingerprint: string; pcName: string }): Promise<RouteProvider[]> {
  const mod = await loadConnectivityModule();
  if (!mod) return [];
  const sh = new Shared(mod, info);
  return [new MappedPortRoute(sh), new ExtraRoute(sh)];
}