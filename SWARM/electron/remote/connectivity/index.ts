/**
 * ConnectivityManager: finds every route by which a phone can reach the bridge directly
 * (LAN IPv4, global IPv6, UPnP / NAT-PMP mapped public IPv4) with no relay and no account.
 *
 * ## How the bridge owner wires it
 * ```ts
 * import { ConnectivityManager } from './connectivity';
 * const connectivity = new ConnectivityManager();
 * await connectivity.start(port);                 // port = the HTTPS bridge port (default 47821)
 * // when building the QR payload, AFTER the LAN addresses:
 * const hosts = await connectivity.getCandidateEndpoints(port);   // 'ip:port' and '[v6]:port' strings
 * // on bridge shutdown AND app quit (before-quit: preventDefault, await, then app.quit()):
 * await connectivity.stop();                      // removes every router mapping it created
 * ```
 * - `start()` never throws; each probe records its own error in `getStatus()`. It takes a few
 *   seconds (UPnP/STUN timeouts), so do not block UI on it.
 * - Nothing here listens for connections. It only sends UDP/HTTP requests to the router and to
 *   public STUN servers, and (unless `mapPorts: false`) asks the router to forward the bridge port.
 * - Mapped endpoints are only returned when the router's external address is publicly routable.
 * - `status.summary` is a diagnostics/log string; do not show it verbatim in the UI.
 * - The Windows Firewall rule is NOT added automatically. See `ensureFirewallRule` in ./ipv6.
 */
import os from 'node:os';
import {
  detectNatMapping,
  getPublicAddress as stunPublicAddress,
  type NatDetection,
  type NatMappingType,
} from './stun';
import * as upnp from './upnp';
import * as natpmp from './natpmp';
import { listGlobalIPv6, preferredIPv6, firewallRuleExists, fromOsInterfaces, type Ipv6Address } from './ipv6';
import { classifyWan, isRfc1918, isSharedAddressSpace, type PublicAddressVerdict } from './wan';

export const DEFAULT_BRIDGE_PORT = 47821;
const LEASE_SECONDS = 3600;

export interface MappingStatus {
  /** a probe was run */
  attempted: boolean;
  /** protocol reachable (diagnostic mode) or mapping created (map mode) */
  ok: boolean;
  /** a port mapping is currently held at the router */
  mapped: boolean;
  gatewayIp: string | null;
  externalIp: string | null;
  externalPort: number | null;
  internalPort: number | null;
  leaseSeconds: number | null;
  error: string | null;
}

export interface ConnectivityStatus {
  running: boolean;
  port: number | null;
  mapPorts: boolean;
  updatedAt: string | null;
  lan: string[];
  ipv6: { addresses: string[]; all: Ipv6Address[]; firewallRuleOk?: boolean };
  upnp: MappingStatus;
  natpmp: MappingStatus;
  stun: { publicIp: string | null; natType: NatMappingType; error: string | null };
  /** whether the router's external IPv4 is publicly routable: a mapping is only advertised for 'yes' / 'unknown' */
  publicAddress: PublicAddressVerdict;
  publicAddressReason: string;
  /** diagnostics/log text only */
  summary: string;
}

export interface ConnectivityDeps {
  lanIPv4(): string[];
  globalIPv6(): Promise<Ipv6Address[]>;
  firewallOk(port: number): Promise<boolean | undefined>;
  stunPublicIp(): Promise<{ ip: string | null; error: string | null }>;
  natDetect(): Promise<NatDetection>;
  upnp: Pick<typeof upnp, 'discoverGateway' | 'getExternalIPAddress' | 'addPortMapping' | 'deletePortMapping' | 'getSpecificPortMapping' | 'renewPortMapping'>;
  natpmp: Pick<typeof natpmp, 'getPublicAddress' | 'addMapping' | 'deleteMapping' | 'getDefaultGateway'>;
  randomPort(): number;
}

export interface ConnectivityOptions {
  /** false = diagnostic mode: probe only, never create a mapping. Default true. */
  mapPorts?: boolean;
  leaseSeconds?: number;
  deps?: Partial<ConnectivityDeps>;
}

const defaultDeps: ConnectivityDeps = {
  lanIPv4: () => collectLanIPv4(),
  globalIPv6: () => listGlobalIPv6(),
  firewallOk: async (port) => (process.platform === 'win32' ? firewallRuleExists(port) : undefined),
  stunPublicIp: async () => {
    const r = await stunPublicAddress({ family: 4 });
    return { ip: r.mapped?.address ?? null, error: r.mapped ? null : r.errors.join('; ') || 'no answer' };
  },
  natDetect: () => detectNatMapping(),
  upnp,
  natpmp,
  randomPort: () => 20000 + Math.floor(Math.random() * 40001),
};

const emptyMapping = (): MappingStatus => ({ attempted: false, ok: false, mapped: false, gatewayIp: null, externalIp: null, externalPort: null, internalPort: null, leaseSeconds: null, error: null });

const VIRTUAL_NAME = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|vbox|bluetooth|loopback|pseudo/i;

/** LAN IPv4 addresses, physical adapters first, link-local excluded. */
export function collectLanIPv4(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const real: string[] = [];
  const virtual: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      (VIRTUAL_NAME.test(name) ? virtual : real).push(i.address);
    }
  }
  const rank = (ip: string): number => (isRfc1918(ip) ? 0 : isSharedAddressSpace(ip) ? 1 : 2);
  real.sort((a, b) => rank(a) - rank(b));
  return [...new Set([...real, ...virtual])];
}

export function formatEndpoint(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

interface HeldMapping {
  method: 'upnp' | 'natpmp';
  gateway: upnp.UpnpGateway | string;
  internalPort: number;
  externalPort: number;
  lease: number;
  timer?: NodeJS.Timeout;
}

export class ConnectivityManager {
  private readonly deps: ConnectivityDeps;
  private readonly mapPorts: boolean;
  private readonly lease: number;
  private status: ConnectivityStatus;
  private held: HeldMapping[] = [];
  private generation = 0;
  private bridgePort: number = DEFAULT_BRIDGE_PORT;
  private v6Cache: { at: number; list: Ipv6Address[] } | null = null;

  constructor(opts: ConnectivityOptions = {}) {
    this.deps = { ...defaultDeps, ...opts.deps };
    this.mapPorts = opts.mapPorts ?? true;
    this.lease = opts.leaseSeconds ?? LEASE_SECONDS;
    this.status = this.blankStatus();
  }

  private blankStatus(): ConnectivityStatus {
    return {
      running: false,
      port: null,
      mapPorts: this.mapPorts,
      updatedAt: null,
      lan: [],
      ipv6: { addresses: [], all: [] },
      upnp: emptyMapping(),
      natpmp: emptyMapping(),
      stun: { publicIp: null, natType: 'unknown', error: null },
      publicAddress: 'unknown',
      publicAddressReason: 'not probed yet',
      summary: 'not probed yet',
    };
  }

  /** Run all probes (and mapping, unless mapPorts is false). Never throws. */
  async start(port: number = DEFAULT_BRIDGE_PORT): Promise<void> {
    if (this.status.running) await this.stop();
    const gen = ++this.generation;
    this.bridgePort = port;
    this.status = { ...this.blankStatus(), running: true, port };
    this.v6Cache = null;

    const lan = this.safe(() => this.deps.lanIPv4(), [] as string[]);
    const [v6, fw, stun, nat] = await Promise.all([
      this.deps.globalIPv6().catch(() => [] as Ipv6Address[]),
      this.deps.firewallOk(port).catch(() => undefined),
      this.deps.stunPublicIp().catch((e: Error) => ({ ip: null, error: e.message })),
      this.deps.natDetect().catch((e: Error) => ({ natType: 'unknown' as const, publicIp: null, mappedPorts: [], localPort: null, reason: e.message })),
    ]);
    this.v6Cache = { at: Date.now(), list: v6 };
    if (gen !== this.generation) return;

    this.status.lan = await lan;
    this.status.ipv6 = { addresses: preferredIPv6(v6), all: v6, ...(fw === undefined ? {} : { firewallRuleOk: fw }) };
    this.status.stun = { publicIp: stun.ip ?? nat.publicIp, natType: nat.natType, error: stun.error && !stun.ip ? stun.error : null };

    const [up, pmp] = await Promise.all([this.probeUpnp(port, gen), this.probeNatPmp()]);
    if (gen !== this.generation) return;
    if (this.mapPorts && !up.mapped && pmp.ok) await this.mapNatPmp(pmp, port, gen);
    if (gen !== this.generation) return;
    this.status.upnp = up;
    this.status.natpmp = pmp;
    this.reclassify();
    this.status.updatedAt = new Date().toISOString();
  }

  /** Remove every mapping created by this manager and stop renewals. Await it (with a timeout) on quit. */
  async stop(): Promise<void> {
    this.generation++;
    const held = this.held;
    this.held = [];
    for (const h of held) if (h.timer) clearTimeout(h.timer);
    await Promise.allSettled(held.map((h) => this.release(h)));
    this.status = { ...this.status, running: false, upnp: { ...this.status.upnp, mapped: false }, natpmp: { ...this.status.natpmp, mapped: false } };
  }

  getStatus(): ConnectivityStatus {
    return structuredClone(this.status);
  }

  /**
   * Endpoints for the QR `hosts` list, in priority order: LAN IPv4, global IPv6, mapped public IPv4.
   * `host:port` for IPv4, `[v6]:port` for IPv6. Safe to call before start() (diagnostic probe, no mapping).
   */
  async getCandidateEndpoints(port: number = this.bridgePort): Promise<string[]> {
    if (!this.status.updatedAt && !this.status.running) {
      const diag = new ConnectivityManager({ mapPorts: false, deps: this.deps });
      await diag.start(port);
      this.status = diag.getStatus();
      this.status.running = false;
    }
    const out: string[] = [];
    for (const ip of this.safe(() => this.deps.lanIPv4(), [] as string[])) out.push(formatEndpoint(ip, port));
    for (const v6 of await this.currentIPv6()) out.push(formatEndpoint(v6, port));
    for (const m of [this.status.upnp, this.status.natpmp]) {
      if (m.mapped && m.externalIp && m.externalPort && m.internalPort === port && this.status.publicAddress !== 'no') {
        out.push(formatEndpoint(m.externalIp, m.externalPort));
      }
    }
    return [...new Set(out)];
  }

  /** Check (read-only) that the mappings we hold still exist at the router. */
  async verifyMappings(): Promise<Array<{ method: string; externalPort: number; present: boolean; error?: string }>> {
    const res: Array<{ method: string; externalPort: number; present: boolean; error?: string }> = [];
    for (const h of this.held) {
      if (h.method === 'upnp') {
        try {
          const e = await this.deps.upnp.getSpecificPortMapping(h.gateway as upnp.UpnpGateway, h.externalPort, 'TCP');
          res.push({ method: 'upnp', externalPort: h.externalPort, present: e !== null });
        } catch (e) {
          res.push({ method: 'upnp', externalPort: h.externalPort, present: false, error: (e as Error).message });
        }
      } else {
        res.push({ method: 'natpmp', externalPort: h.externalPort, present: true, error: 'NAT-PMP has no query operation; assumed from the last successful response' });
      }
    }
    return res;
  }

  // ---------- internals ----------

  private safe<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch { return fallback; }
  }

  private v6Refreshing = false;

  /** Cached global IPv6 list; a stale cache is returned immediately and refreshed in the background. */
  private async currentIPv6(): Promise<string[]> {
    if (!this.v6Cache) {
      try {
        this.v6Cache = { at: Date.now(), list: await this.deps.globalIPv6() };
      } catch {
        this.v6Cache = { at: Date.now(), list: [] };
      }
    } else if (Date.now() - this.v6Cache.at > 60_000 && !this.v6Refreshing) {
      this.v6Refreshing = true;
      void this.deps.globalIPv6()
        .then((list) => { this.v6Cache = { at: Date.now(), list }; })
        .catch(() => undefined)
        .finally(() => { this.v6Refreshing = false; });
    }
    return preferredIPv6(this.v6Cache?.list ?? []);
  }

  /** Age in ms of the last completed probe (Infinity if none). */
  statusAgeMs(): number {
    return this.status.updatedAt ? Date.now() - Date.parse(this.status.updatedAt) : Infinity;
  }

  /** Re-read LAN/IPv6/STUN (read-only, no mapping changes) and re-classify. No-op unless running. */
  async refreshDiagnostics(): Promise<void> {
    if (!this.status.running || !this.status.updatedAt) return;
    const gen = this.generation;
    const [v6, stun] = await Promise.all([
      this.deps.globalIPv6().catch(() => null),
      this.deps.stunPublicIp().catch(() => null),
    ]);
    if (gen !== this.generation) return;
    this.status.lan = this.safe(() => this.deps.lanIPv4(), this.status.lan);
    if (v6) {
      this.v6Cache = { at: Date.now(), list: v6 };
      this.status.ipv6 = { ...this.status.ipv6, addresses: preferredIPv6(v6), all: v6 };
    }
    if (stun?.ip) this.status.stun = { ...this.status.stun, publicIp: stun.ip, error: null };
    this.reclassify();
    this.status.updatedAt = new Date().toISOString();
  }
  private pickExternalPorts(port: number): number[] {
    const ports = [port];
    while (ports.length < 4) {
      const p = this.deps.randomPort();
      if (!ports.includes(p)) ports.push(p);
    }
    return ports;
  }

  private async probeUpnp(port: number, gen: number): Promise<MappingStatus> {
    const st = emptyMapping();
    st.attempted = true;
    let gw: upnp.UpnpGateway;
    try {
      gw = await this.deps.upnp.discoverGateway();
    } catch (e) {
      st.error = (e as Error).message;
      return st;
    }
    st.gatewayIp = gw.gatewayIp;
    try {
      st.externalIp = await this.deps.upnp.getExternalIPAddress(gw);
    } catch (e) {
      st.error = (e as Error).message;
      if (!this.mapPorts) return st;
    }
    if (!this.mapPorts) {
      st.ok = st.externalIp !== null;
      return st;
    }
    let lastErr = st.error;
    for (const ext of this.pickExternalPorts(port)) {
      if (gen !== this.generation) return st;
      try {
        const existing = await this.deps.upnp.getSpecificPortMapping(gw, ext).catch(() => null);
        if (existing && (existing.internalClient !== gw.localAddress || existing.internalPort !== port) && existing.description !== 'SWARM') {
          lastErr = `external port ${ext} already mapped to ${existing.internalClient}:${existing.internalPort} by another application`;
          continue;
        }
        const granted = await this.deps.upnp.renewPortMapping(gw, { externalPort: ext, internalPort: port, protocol: 'TCP', description: 'SWARM', leaseSeconds: this.lease });
        if (gen !== this.generation) {
          await this.deps.upnp.deletePortMapping(gw, ext).catch(() => undefined);
          return st;
        }
        const h: HeldMapping = { method: 'upnp', gateway: gw, internalPort: port, externalPort: ext, lease: granted };
        this.held.push(h);
        this.scheduleRenewal(h, gen);
        st.ok = true;
        st.mapped = true;
        st.externalPort = ext;
        st.internalPort = port;
        st.leaseSeconds = granted;
        st.error = null;
        return st;
      } catch (e) {
        lastErr = (e as Error).message;
        const kind = e instanceof upnp.UpnpError ? e.kind : 'network';
        if (kind !== 'soap') break; // router-level refusals may be port specific; transport errors are not
      }
    }
    st.error = lastErr ?? 'mapping failed';
    return st;
  }

  private async probeNatPmp(): Promise<MappingStatus> {
    const st = emptyMapping();
    st.attempted = true;
    const gateway = await this.deps.natpmp.getDefaultGateway();
    if (!gateway) {
      st.error = 'default gateway not found';
      return st;
    }
    st.gatewayIp = gateway;
    try {
      st.externalIp = (await this.deps.natpmp.getPublicAddress(gateway)).publicIp;
      st.ok = true;
    } catch (e) {
      st.error = (e as Error).message;
    }
    return st;
  }

  /** NAT-PMP mapping is only a fallback, used when no UPnP mapping exists. */
  private async mapNatPmp(st: MappingStatus, port: number, gen: number): Promise<void> {
    const gateway = st.gatewayIp as string;
    let lastErr: string | null = null;
    for (const ext of this.pickExternalPorts(port)) {
      if (gen !== this.generation) return;
      try {
        const r = await this.deps.natpmp.addMapping(gateway, { protocol: 'tcp', internalPort: port, externalPort: ext, lifetime: this.lease });
        if (gen !== this.generation) {
          await this.deps.natpmp.deleteMapping(gateway, 'tcp', port).catch(() => undefined);
          return;
        }
        const h: HeldMapping = { method: 'natpmp', gateway, internalPort: port, externalPort: r.externalPort, lease: r.lifetime };
        this.held.push(h);
        this.scheduleRenewal(h, gen);
        st.ok = true;
        st.mapped = true;
        st.externalPort = r.externalPort;
        st.internalPort = port;
        st.leaseSeconds = r.lifetime;
        st.error = null;
        return;
      } catch (e) {
        lastErr = (e as Error).message;
        if (!(e instanceof natpmp.NatPmpError) || e.kind === 'timeout' || e.kind === 'refused') break;
      }
    }
    st.ok = false;
    st.error = lastErr;
  }
  private scheduleRenewal(h: HeldMapping, gen: number): void {
    if (h.lease === 0) return; // permanent lease
    const delay = Math.max(30_000, h.lease * 500);
    h.timer = setTimeout(() => void this.renew(h, gen), delay);
    h.timer.unref();
  }

  private async renew(h: HeldMapping, gen: number): Promise<void> {
    if (gen !== this.generation || !this.held.includes(h)) return;
    const target = h.method === 'upnp' ? this.status.upnp : this.status.natpmp;
    try {
      if (h.method === 'upnp') {
        h.lease = await this.deps.upnp.renewPortMapping(h.gateway as upnp.UpnpGateway, { externalPort: h.externalPort, internalPort: h.internalPort, protocol: 'TCP', description: 'SWARM', leaseSeconds: this.lease });
        try {
          const ip = await this.deps.upnp.getExternalIPAddress(h.gateway as upnp.UpnpGateway);
          if (ip !== target.externalIp) { target.externalIp = ip; this.reclassify(); }
        } catch { /* keep previous */ }
      } else {
        const r = await this.deps.natpmp.addMapping(h.gateway as string, { protocol: 'tcp', internalPort: h.internalPort, externalPort: h.externalPort, lifetime: this.lease });
        h.lease = r.lifetime;
        h.externalPort = r.externalPort;
        target.externalPort = r.externalPort;
        try {
          const ip = (await this.deps.natpmp.getPublicAddress(h.gateway as string)).publicIp;
          if (ip !== target.externalIp) { target.externalIp = ip; this.reclassify(); }
        } catch { /* keep previous */ }
      }
      target.error = null;
      target.mapped = true;
      target.leaseSeconds = h.lease;
      this.scheduleRenewal(h, gen);
    } catch (e) {
      target.error = `renewal failed: ${(e as Error).message}`;
      target.mapped = false;
      if (gen !== this.generation || !this.held.includes(h)) return;
      h.timer = setTimeout(() => void this.renew(h, gen), 60_000);
      h.timer.unref();
    }
  }

  private async release(h: HeldMapping): Promise<void> {
    if (h.method === 'upnp') await this.deps.upnp.deletePortMapping(h.gateway as upnp.UpnpGateway, h.externalPort, 'TCP');
    else await this.deps.natpmp.deleteMapping(h.gateway as string, 'tcp', h.internalPort);
  }

  private reclassify(): void {
    const s = this.status;
    const routerIp = s.upnp.externalIp ?? s.natpmp.externalIp;
    const c = classifyWan({ routerWanIp: routerIp, stunPublicIp: s.stun.publicIp });
    s.publicAddress = c.publicAddress;
    s.publicAddressReason = c.reason;
    s.summary = summarize(s);
  }
}

/** Diagnostics text. Pure; exported for tests. */
export function summarize(s: ConnectivityStatus): string {
  const parts: string[] = [];
  parts.push(s.lan.length ? `LAN: ${s.lan.join(', ')} works on the same network.` : 'No LAN IPv4 address found.');
  if (s.ipv6.addresses.length) {
    const fw = s.ipv6.firewallRuleOk === false ? ' (inbound firewall rule for the port is missing)' : '';
    parts.push(`IPv6: ${s.ipv6.addresses.length} global address(es) available; direct from mobile data if the router firewall allows inbound${fw}.`);
  } else {
    parts.push('IPv6: no global address.');
  }
  const mapped = [s.upnp, s.natpmp].find((m) => m.mapped);
  if (s.publicAddress === 'no') {
    parts.push(`IPv4 mapping not publicly reachable (${s.publicAddressReason}); mapped port would not accept internet connections, so it is not advertised.`);
  } else if (mapped) {
    parts.push(`IPv4 port mapping active: ${mapped.externalIp}:${mapped.externalPort}${s.publicAddress === 'unknown' ? ' (public reachability unconfirmed)' : ''}.`);
  } else if (s.upnp.ok || s.natpmp.ok) {
    parts.push(`Router answers ${[s.upnp.ok ? 'UPnP' : '', s.natpmp.ok ? 'NAT-PMP' : ''].filter(Boolean).join('+')}; mapping not requested (diagnostic mode).`);
  } else {
    parts.push(`No automatic IPv4 mapping (UPnP: ${s.upnp.error ?? 'n/a'}; NAT-PMP: ${s.natpmp.error ?? 'n/a'}).`);
  }
  if (s.stun.natType === 'symmetric') parts.push('NAT mapping is destination-dependent (symmetric): UDP hole punching would not work.');
  else if (s.stun.natType === 'endpoint-independent') parts.push('NAT mapping is endpoint-independent.');
  return parts.join(' ');
}

export * from './stun';
export * as upnpClient from './upnp';
export * as natpmpClient from './natpmp';
export * from './ipv6';
export * from './wan';
export * from './reachability';
export * from './firewall';
// ---------------------------------------------------------------------------
// Module-level API used by electron/remote/connectivityHook.ts (singleton manager).
// ---------------------------------------------------------------------------

export interface ConnectivityStartContext {
  port?: number;
  fingerprint?: string;
  pcName?: string;
}

/** start() resolves after at most this long; the probes keep running in the background. */
const START_SOFT_LIMIT_MS = 2000;
/** getCandidateEndpoints() before start() is bounded by this. */
const QUICK_PROBE_LIMIT_MS = 2500;

let singleton: ConnectivityManager | null = null;
let singletonPort: number | null = null;
let startPromise: Promise<void> | null = null;
let backgroundRefresh = false;
let quickCache: { at: number; port: number; list: string[] } | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    t.unref();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

/**
 * Start (idempotent, never throws). Same port while running => no-op; different port => restart.
 * Creates router port mappings unless env SWARM_NO_PORT_MAPPING=1. Resolves within ~2 s even if
 * router discovery is still running; late results are picked up by getCandidateEndpoints().
 */
export async function start(ctx: ConnectivityStartContext = {}): Promise<void> {
  try {
    const port = Number.isInteger(ctx.port) && (ctx.port as number) > 0 && (ctx.port as number) < 65536 ? (ctx.port as number) : DEFAULT_BRIDGE_PORT;
    if (singleton && startPromise && singletonPort === port) {
      return; // already starting/started on this port
    }
    if (singleton) await stop();
    const mgr = new ConnectivityManager({ mapPorts: process.env.SWARM_NO_PORT_MAPPING !== '1' });
    singleton = mgr;
    singletonPort = port;
    quickCache = null;
    startPromise = mgr.start(port).catch(() => undefined);
    await withTimeout(startPromise, START_SOFT_LIMIT_MS, undefined);
  } catch {
    /* never throws */
  }
}

/** Stop (idempotent, never throws): cancels renewals and removes every router mapping created. */
export async function stop(): Promise<void> {
  const mgr = singleton;
  singleton = null;
  singletonPort = null;
  startPromise = null;
  quickCache = null;
  if (!mgr) return;
  try {
    await mgr.stop();
  } catch {
    /* mapping removal is best effort; leases expire on their own */
  }
}

/** Current diagnostics for logs / a settings screen (null before start()). */
export function getConnectivityStatus(): ConnectivityStatus | null {
  return singleton ? singleton.getStatus() : null;
}

/**
 * QR host entries. Returns immediately from the cache after start() (refreshing in the background
 * when older than ~60 s). If start() was never called, a read-only quick probe (LAN + IPv6, no
 * mapping, no router discovery) bounded to 2.5 s is used.
 */
export async function getCandidateEndpoints(port?: number): Promise<string[]> {
  try {
    if (singleton) {
      const mgr = singleton;
      if (mgr.statusAgeMs() > 60_000 && !backgroundRefresh) {
        backgroundRefresh = true;
        void mgr.refreshDiagnostics().catch(() => undefined).finally(() => { backgroundRefresh = false; });
      }
      return await mgr.getCandidateEndpoints(port ?? singletonPort ?? DEFAULT_BRIDGE_PORT);
    }
    const p = port ?? DEFAULT_BRIDGE_PORT;
    if (quickCache && quickCache.port === p && Date.now() - quickCache.at < 60_000) return quickCache.list;
    // Full answer (PowerShell flags temporary IPv6 addresses; a cold PowerShell can take > 2 s).
    const full = (async () => {
      const out: string[] = [];
      for (const ip of collectLanIPv4()) out.push(formatEndpoint(ip, p));
      for (const v6 of preferredIPv6(await listGlobalIPv6())) out.push(formatEndpoint(v6, p));
      quickCache = { at: Date.now(), port: p, list: out };
      return out;
    })();
    const list = await withTimeout(full, QUICK_PROBE_LIMIT_MS - 300, null);
    if (list) return list;
    // Too slow: answer from the OS API now (the full result lands in quickCache for the next call).
    const out = collectLanIPv4().map((ip) => formatEndpoint(ip, p));
    for (const v6 of fromOsInterfaces()) out.push(formatEndpoint(v6.address, p));
    return out;
  } catch {
    return [];
  }
}