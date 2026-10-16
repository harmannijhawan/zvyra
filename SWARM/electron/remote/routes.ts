// Pluggable route layer. A RouteProvider contributes candidate endpoints for the QR `hosts` list and
// reports its own status for the UI. Built-ins: home network (LAN IPv4), public IPv6, mapped port (UPnP/NAT-PMP),
// manual host. More providers (e.g. electron/remote/connectivity/*) can be added with RouteManager.add().
import os from 'node:os';
import { listGlobalIPv6, preferredIPv6 } from './connectivity/ipv6';
import { isIP } from 'node:net';

export type RouteState = 'ready' | 'pending' | 'unavailable' | 'failed' | 'off';
export interface RouteStatus { id: string; label: string; state: RouteState; endpoints: string[]; detail: string }
export interface RouteContext { port: number }

export interface RouteProvider {
  readonly id: string;
  readonly label: string;
  /** Lower number = earlier in the QR hosts list. */
  readonly priority: number;
  start(ctx: RouteContext): Promise<void>;
  stop(): Promise<void>;
  /** Candidate endpoints (`host:port`, `[v6]:port`, or `scheme:...`). May be async to refresh. */
  endpoints(ctx: RouteContext): Promise<string[]>;
  status(): RouteStatus;
}

export const fmtHost = (host: string, port: number) => (isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`);

export function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
export const isGlobalV6 = (ip: string) => isIP(ip) === 6 && /^[23][0-9a-f]{3}:/i.test(ip);

export function lanAddresses(ifaces = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) for (const i of list ?? []) {
    if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push(i.address);
  }
  const rank = (a: string) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : 2);
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b));
}
export function globalV6Addresses(ifaces = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) for (const i of list ?? []) if (i.family === 'IPv6' && !i.internal && isGlobalV6(i.address)) out.push(i.address);
  return [...new Set(out)].slice(0, 3);
}

/** Classifies the peer address of an accepted connection to tell which route is really in use. */
export function classifyRemoteAddress(addr: string): 'local' | 'lan' | 'ipv6' | 'public' {
  const a = addr.replace(/^::ffff:/i, '');
  if (a === '::1' || a.startsWith('127.')) return 'local';
  if (isIP(a) === 4) return isPrivateV4(a) ? 'lan' : 'public';
  if (isIP(a) === 6) return /^f[cde]/i.test(a) ? 'lan' : isGlobalV6(a) ? 'ipv6' : 'lan';
  return 'public';
}

export class LanRoute implements RouteProvider {
  readonly id = 'lan'; readonly label = 'Home network'; readonly priority = 10;
  async start() {}
  async stop() {}
  async endpoints(ctx: RouteContext) { return lanAddresses().map((a) => fmtHost(a, ctx.port)); }
  status(): RouteStatus {
    const a = lanAddresses();
    return { id: this.id, label: this.label, state: a.length ? 'ready' : 'unavailable', endpoints: a, detail: a.length ? 'Reachable on the same Wi-Fi / network' : 'No network address found' };
  }
}

export class Ipv6Route implements RouteProvider {
  readonly id = 'ipv6'; readonly label = 'Public IPv6'; readonly priority = 20;
  private port = 0;
  private cached: string[] = [];
  private refreshedAt = 0;
  private refresh: Promise<void> | null = null;
  async start(ctx: RouteContext) { this.port = ctx.port; await this.endpoints(ctx); }
  async stop() {}
  async endpoints(ctx: RouteContext) {
    if (!this.refreshedAt || Date.now() - this.refreshedAt > 30_000) {
      this.refresh ??= listGlobalIPv6().then(list => { this.cached = preferredIPv6(list); this.refreshedAt = Date.now(); }).finally(() => { this.refresh = null; });
      if (!this.refreshedAt) await this.refresh;
    }
    return this.cached.map((a) => fmtHost(a, ctx.port));
  }
  status(): RouteStatus {
    const a = this.refreshedAt ? this.cached : globalV6Addresses();
    return { id: this.id, label: this.label, state: a.length ? 'ready' : 'unavailable', endpoints: a.map((x) => fmtHost(x, this.port || 0)), detail: a.length ? 'Public IPv6 address available' : 'Not available' };
  }
}

export class ManualRoute implements RouteProvider {
  readonly id = 'manual'; readonly label = 'Manual'; readonly priority = 40;
  private host = '';
  private port = 0;
  constructor(private getHost: () => string) {}
  private compute(port: number): string[] {
    this.host = this.getHost().trim();
    if (!this.host) return [];
    if (/^https?:\/\//i.test(this.host) || /^[a-z][a-z0-9+.-]*:[^0-9]/i.test(this.host)) return [this.host];
    const bracketed = /^\[.*\](:\d+)?$/.test(this.host);
    if (bracketed) return [/\]:\d+$/.test(this.host) ? this.host : `${this.host}:${port}`];
    if (/^[^:]+:\d+$/.test(this.host)) return [this.host];
    return [fmtHost(this.host, port)];
  }
  async start(ctx: RouteContext) { this.port = ctx.port; }
  async stop() {}
  async endpoints(ctx: RouteContext) { return this.compute(ctx.port); }
  status(): RouteStatus {
    const e = this.compute(this.port || 0);
    return { id: this.id, label: this.label, state: e.length ? 'ready' : 'off', endpoints: e, detail: e.length ? 'Configured address' : 'Not configured' };
  }
}

/** Minimal shape of @runonflux/nat-upnp's Client so tests can inject a fake. */
export interface UpnpClientLike {
  createMapping(o: { public: number; private: number; protocol?: string; ttl?: number; description?: string }): Promise<unknown>;
  removeMapping(o: { public: number; protocol?: string }): Promise<unknown>;
  getPublicIp(): Promise<string>;
  close(): void;
}

const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((res, rej) => { const t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

export class UpnpRoute implements RouteProvider {
  readonly id = 'upnp'; readonly label = 'Mapped port'; readonly priority = 30;
  private state: RouteState = 'off';
  private detail = 'Not started';
  private external: string | null = null;
  private mappedPort: number | null = null;
  private client: UpnpClientLike | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private makeClient: () => Promise<UpnpClientLike> = defaultUpnpClient, private timeoutMs = 6000) {}

  async start(ctx: RouteContext) {
    this.state = 'pending'; this.detail = 'Looking for a router…'; this.external = null;
    void this.map(ctx.port).catch(() => undefined); // never block server start on the router
  }

  private async map(port: number) {
    try {
      const c = this.client ?? (this.client = await this.makeClient());
      const ip = await withTimeout(c.getPublicIp(), this.timeoutMs, 'Router lookup');
      let ext = port;
      try { await withTimeout(c.createMapping({ public: ext, private: port, protocol: 'TCP', ttl: 3600, description: 'SWARM Remote' }), this.timeoutMs, 'Port mapping'); }
      catch { ext = 40000 + Math.floor(Math.random() * 20000); await withTimeout(c.createMapping({ public: ext, private: port, protocol: 'TCP', ttl: 3600, description: 'SWARM Remote' }), this.timeoutMs, 'Port mapping'); }
      if (!this.client) { await c.removeMapping({ public: ext, protocol: 'TCP' }).catch(() => undefined); return; } // stopped meanwhile
      this.mappedPort = ext;
      if (isIP(ip) === 4 && isPrivateV4(ip)) { this.state = 'unavailable'; this.external = null; this.detail = 'Router did not report a public address'; }
      else { this.external = fmtHost(ip, ext); this.state = 'ready'; this.detail = `Mapped ${this.external}`; }
      if (!this.timer) { this.timer = setInterval(() => { void this.map(port).catch(() => undefined); }, 30 * 60_000); this.timer.unref?.(); }
    } catch (e) {
      this.state = 'failed'; this.external = null;
      this.detail = e instanceof Error && /timed out/.test(e.message) ? 'No response from router' : 'Router did not allow a mapping';
    }
  }

  async stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const c = this.client; const p = this.mappedPort;
    this.client = null; this.mappedPort = null; this.external = null; this.state = 'off'; this.detail = 'Not started';
    if (c) {
      try { if (p) await withTimeout(c.removeMapping({ public: p, protocol: 'TCP' }), 3000, 'Unmap'); } catch { /* best effort */ }
      try { c.close(); } catch { /* ignore */ }
    }
  }
  async endpoints() { return this.external ? [this.external] : []; }
  status(): RouteStatus { return { id: this.id, label: this.label, state: this.state, endpoints: this.external ? [this.external] : [], detail: this.detail }; }
}

async function defaultUpnpClient(): Promise<UpnpClientLike> {
  const mod = (await import('@runonflux/nat-upnp')) as unknown as { Client: new (o?: { timeout?: number }) => UpnpClientLike; default?: { Client: new (o?: { timeout?: number }) => UpnpClientLike } };
  const Client = mod.Client ?? mod.default?.Client;
  return new Client({ timeout: 5000 });
}

export class RouteManager {
  private providers: RouteProvider[] = [];
  private ctx: RouteContext = { port: 0 };
  add(p: RouteProvider) { this.providers = [...this.providers.filter((x) => x.id !== p.id), p].sort((a, b) => a.priority - b.priority); return this; }
  list() { return this.providers; }
  async startAll(ctx: RouteContext) {
    this.ctx = ctx;
    await Promise.all(this.providers.map((p) => p.start(ctx).catch(() => undefined)));
  }
  async stopAll() { await Promise.all(this.providers.map((p) => p.stop().catch(() => undefined))); }
  statuses(): RouteStatus[] { return this.providers.map((p) => p.status()); }
  /** Ordered, de-duplicated endpoints for the QR. */
  async collectHosts(): Promise<string[]> {
    const out: string[] = [];
    for (const p of this.providers) {
      try { for (const e of await p.endpoints(this.ctx)) if (e && !out.includes(e)) out.push(e); } catch { /* a broken provider must not break pairing */ }
    }
    return out;
  }
  /** The best route that currently has an endpoint. */
  likely(): string | null { return this.statuses().find((s) => s.state === 'ready' && s.endpoints.length)?.id ?? null; }
}
