/**
 * UPnP Internet Gateway Device client: SSDP discovery + SOAP port mapping. No dependencies.
 *
 * Failures throw {@link UpnpError} with a `kind` so callers can report a clear reason.
 * Only private/link-local gateway URLs are ever contacted (guards against forged SSDP replies).
 */
import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import { isNonPublicIPv4, isLoopbackV4 } from './wan';

export type UpnpErrorKind = 'no_gateway' | 'no_wan_service' | 'timeout' | 'http' | 'soap' | 'parse' | 'unsafe' | 'network';

export class UpnpError extends Error {
  constructor(
    public readonly kind: UpnpErrorKind,
    message: string,
    /** UPnP error code from a SOAP fault (e.g. 718 ConflictInMappingEntry), if any */
    public readonly code?: number,
  ) {
    super(message);
    this.name = 'UpnpError';
  }
}

export const SSDP_ADDRESS = '239.255.255.250';
export const SSDP_PORT = 1900;
export const IGD_SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

// ---------- pure parsing / encoding ----------

export function buildMSearch(st: string, mx = 2): string {
  return ['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', `MX: ${mx}`, `ST: ${st}`, '', ''].join('\r\n');
}

export interface SsdpResponse {
  location: string;
  st?: string;
  usn?: string;
  server?: string;
}

export function parseSsdpResponse(text: string): SsdpResponse | null {
  const lines = text.split(/\r?\n/);
  if (!/^HTTP\/1\.[01]\s+200/i.test(lines[0] ?? '')) return null;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  if (!headers.location) return null;
  return { location: headers.location, st: headers.st, usn: headers.usn, server: headers.server };
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function tagText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>\\s*([\\s\\S]*?)\\s*</(?:[\\w-]+:)?${tag}>`, 'i').exec(xml);
  return m ? decodeXmlEntities(m[1].trim()) : undefined;
}

export interface UpnpService {
  serviceType: string;
  controlUrl: string;
  scpdUrl?: string;
}

export interface DeviceDescription {
  friendlyName?: string;
  manufacturer?: string;
  modelName?: string;
  urlBase?: string;
  services: UpnpService[];
}

export function parseDeviceDescription(xml: string): DeviceDescription {
  const services: UpnpService[] = [];
  const re = /<service>([\s\S]*?)<\/service>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const serviceType = tagText(m[1], 'serviceType');
    const controlUrl = tagText(m[1], 'controlURL');
    if (serviceType && controlUrl) services.push({ serviceType, controlUrl, scpdUrl: tagText(m[1], 'SCPDURL') });
  }
  return {
    friendlyName: tagText(xml, 'friendlyName'),
    manufacturer: tagText(xml, 'manufacturer'),
    modelName: tagText(xml, 'modelName'),
    urlBase: tagText(xml, 'URLBase'),
    services,
  };
}

/** Prefer WANIPConnection (v2 then v1), then WANPPPConnection. */
export function selectWanService(services: UpnpService[]): UpnpService | null {
  const rank = (s: UpnpService): number => {
    const m = /:(WANIPConnection|WANPPPConnection):(\d+)/i.exec(s.serviceType);
    if (!m) return -1;
    const base = m[1].toLowerCase() === 'wanipconnection' ? 100 : 50;
    return base + Number(m[2]);
  };
  const sorted = services.filter((s) => rank(s) >= 0).sort((a, b) => rank(b) - rank(a));
  return sorted[0] ?? null;
}

export function resolveControlUrl(controlUrl: string, location: string, urlBase?: string): string {
  const base = urlBase && /^https?:\/\//i.test(urlBase) ? urlBase : location;
  return new URL(controlUrl, base).toString();
}

export function buildSoapEnvelope(serviceType: string, action: string, args: Array<[string, string | number]> = []): string {
  const body = args.map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`).join('');
  return (
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${escapeXml(serviceType)}">${body}</u:${action}></s:Body></s:Envelope>`
  );
}

/** Collect leaf elements of a SOAP response, e.g. {NewExternalIPAddress: '1.2.3.4'}. */
export function parseSoapResponse(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<(?:[\w-]+:)?(\w+)(?:\s[^>]*)?>([^<]*)<\/(?:[\w-]+:)?\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out[m[1]] = decodeXmlEntities(m[2].trim());
  return out;
}

export function parseSoapFault(xml: string): { code?: number; description?: string } | null {
  if (!/<(?:[\w-]+:)?Fault\b/i.test(xml)) return null;
  const code = tagText(xml, 'errorCode');
  return { code: code ? Number(code) : undefined, description: tagText(xml, 'errorDescription') ?? tagText(xml, 'faultstring') };
}

// ---------- HTTP transport (injectable) ----------

export interface HttpResult {
  status: number;
  body: string;
}

export interface UpnpHttp {
  get(url: string, timeoutMs: number): Promise<HttpResult>;
  post(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<HttpResult>;
}

function nodeHttpRequest(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { return reject(new UpnpError('parse', `invalid URL ${url}`)); }
    if (u.protocol !== 'http:') return reject(new UpnpError('unsafe', `refusing non-http URL ${url}`));
    const req = http.request(
      { method, hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers: { ...headers, ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}) }, timeout: timeoutMs, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 512 * 1024) { req.destroy(new UpnpError('http', 'response too large')); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => reject(new UpnpError('network', e.message)));
      },
    );
    req.on('timeout', () => req.destroy(new UpnpError('timeout', `request to ${u.host} timed out after ${timeoutMs} ms`)));
    req.on('error', (e) => reject(e instanceof UpnpError ? e : new UpnpError('network', `${u.host}: ${e.message}`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const defaultUpnpHttp: UpnpHttp = {
  get: (url, t) => nodeHttpRequest('GET', url, { 'User-Agent': 'SWARM/1.0 UPnP/1.1' }, undefined, t),
  post: (url, headers, body, t) => nodeHttpRequest('POST', url, { 'User-Agent': 'SWARM/1.0 UPnP/1.1', ...headers }, body, t),
};

// ---------- SSDP discovery ----------

export interface SsdpHit extends SsdpResponse {
  /** local IPv4 address of the interface that received the answer */
  localAddress: string;
  remoteAddress: string;
}

export function localIPv4Addresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push(i.address);
    }
  }
  return out;
}

/** Send M-SEARCH from every local IPv4 interface and collect answers. */
export function ssdpSearch(opts: { timeoutMs?: number; localAddresses?: string[]; targets?: string[] } = {}): Promise<SsdpHit[]> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const addrs = opts.localAddresses ?? localIPv4Addresses();
  const targets = opts.targets ?? IGD_SEARCH_TARGETS;
  if (addrs.length === 0) return Promise.resolve([]);
  return new Promise<SsdpHit[]>((resolve) => {
    const hits: SsdpHit[] = [];
    const socks: dgram.Socket[] = [];
    let finished = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(overall);
      if (grace) clearTimeout(grace);
      for (const s of socks) { try { s.close(); } catch { /* ignore */ } }
      resolve(hits);
    };
    const overall = setTimeout(finish, timeoutMs);
    for (const local of addrs) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      socks.push(s);
      s.on('error', () => { try { s.close(); } catch { /* ignore */ } });
      s.on('message', (msg, rinfo) => {
        const r = parseSsdpResponse(msg.toString('utf8'));
        if (!r) return;
        if (!hits.some((h) => h.location === r.location && h.localAddress === local)) hits.push({ ...r, localAddress: local, remoteAddress: rinfo.address });
        if (!grace) grace = setTimeout(finish, 500); // give other interfaces/targets a moment, then stop early
      });
      s.bind({ address: local, port: 0 }, () => {
        try { s.setMulticastInterface(local); s.setMulticastTTL(2); } catch { /* best effort */ }
        for (const st of targets) {
          s.send(Buffer.from(buildMSearch(st)), SSDP_PORT, SSDP_ADDRESS, () => { /* ignore send errors */ });
        }
      });
    }
  });
}

// ---------- gateway ----------

export interface UpnpGateway {
  location: string;
  controlUrl: string;
  serviceType: string;
  localAddress: string;
  gatewayIp: string;
  friendlyName?: string;
  modelName?: string;
  server?: string;
}

function assertLanUrl(url: string): void {
  const host = new URL(url).hostname;
  if (!(/^\d+\.\d+\.\d+\.\d+$/.test(host)) || !isNonPublicIPv4(host) || isLoopbackV4(host)) {
    throw new UpnpError('unsafe', `refusing to contact non-LAN UPnP URL host "${host}"`);
  }
}

export interface DiscoverOptions {
  timeoutMs?: number;
  http?: UpnpHttp;
  search?: (o: { timeoutMs: number }) => Promise<SsdpHit[]>;
}

/** Discover the first usable IGD. Throws UpnpError('no_gateway'|'no_wan_service'|...). */
export async function discoverGateway(opts: DiscoverOptions = {}): Promise<UpnpGateway> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const httpc = opts.http ?? defaultUpnpHttp;
  const hits = await (opts.search ?? ssdpSearch)({ timeoutMs });
  if (hits.length === 0) throw new UpnpError('no_gateway', 'no UPnP gateway answered the SSDP search (UPnP disabled on the router, or multicast blocked)');
  let lastErr: UpnpError | null = null;
  const seen = new Set<string>();
  for (const hit of hits) {
    if (seen.has(hit.location)) continue;
    seen.add(hit.location);
    try {
      assertLanUrl(hit.location);
      const res = await httpc.get(hit.location, 4000);
      if (res.status !== 200) throw new UpnpError('http', `device description HTTP ${res.status} from ${hit.location}`);
      const desc = parseDeviceDescription(res.body);
      const svc = selectWanService(desc.services);
      if (!svc) throw new UpnpError('no_wan_service', `device at ${hit.location} has no WANIPConnection/WANPPPConnection service`);
      const controlUrl = resolveControlUrl(svc.controlUrl, hit.location, desc.urlBase);
      assertLanUrl(controlUrl);
      return {
        location: hit.location,
        controlUrl,
        serviceType: svc.serviceType,
        localAddress: hit.localAddress,
        gatewayIp: new URL(hit.location).hostname,
        friendlyName: desc.friendlyName,
        modelName: desc.modelName,
        server: hit.server,
      };
    } catch (e) {
      lastErr = e instanceof UpnpError ? e : new UpnpError('network', (e as Error).message);
    }
  }
  throw lastErr ?? new UpnpError('no_gateway', 'no usable UPnP gateway found');
}

// ---------- SOAP actions ----------

export async function soapCall(gw: UpnpGateway, action: string, args: Array<[string, string | number]> = [], http_: UpnpHttp = defaultUpnpHttp, timeoutMs = 5000): Promise<Record<string, string>> {
  assertLanUrl(gw.controlUrl);
  const body = buildSoapEnvelope(gw.serviceType, action, args);
  const res = await http_.post(
    gw.controlUrl,
    { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${gw.serviceType}#${action}"` },
    body,
    timeoutMs,
  );
  if (res.status >= 200 && res.status < 300) return parseSoapResponse(res.body);
  const fault = parseSoapFault(res.body);
  if (fault) throw new UpnpError('soap', `${action} failed: UPnP error ${fault.code ?? '?'}${fault.description ? ` (${fault.description})` : ''}`, fault.code);
  throw new UpnpError('http', `${action} failed: HTTP ${res.status}`);
}

export async function getExternalIPAddress(gw: UpnpGateway, http_?: UpnpHttp): Promise<string> {
  const r = await soapCall(gw, 'GetExternalIPAddress', [], http_);
  const ip = r.NewExternalIPAddress;
  if (!ip) throw new UpnpError('parse', 'GetExternalIPAddress returned no address (router not connected?)');
  return ip;
}

export interface PortMappingRequest {
  externalPort: number;
  internalPort: number;
  protocol?: 'TCP' | 'UDP';
  description?: string;
  leaseSeconds?: number;
}

export async function addPortMapping(gw: UpnpGateway, req: PortMappingRequest, http_?: UpnpHttp): Promise<void> {
  await soapCall(
    gw,
    'AddPortMapping',
    [
      ['NewRemoteHost', ''],
      ['NewExternalPort', req.externalPort],
      ['NewProtocol', req.protocol ?? 'TCP'],
      ['NewInternalPort', req.internalPort],
      ['NewInternalClient', gw.localAddress],
      ['NewEnabled', 1],
      ['NewPortMappingDescription', req.description ?? 'SWARM'],
      ['NewLeaseDuration', req.leaseSeconds ?? 3600],
    ],
    http_,
  );
}

export async function deletePortMapping(gw: UpnpGateway, externalPort: number, protocol: 'TCP' | 'UDP' = 'TCP', http_?: UpnpHttp): Promise<void> {
  await soapCall(gw, 'DeletePortMapping', [['NewRemoteHost', ''], ['NewExternalPort', externalPort], ['NewProtocol', protocol]], http_);
}

export interface ExistingMapping {
  internalClient: string;
  internalPort: number;
  enabled: boolean;
  description: string;
  leaseSeconds: number;
}

/** Returns null when no mapping exists for that external port (UPnP error 714). */
export async function getSpecificPortMapping(gw: UpnpGateway, externalPort: number, protocol: 'TCP' | 'UDP' = 'TCP', http_?: UpnpHttp): Promise<ExistingMapping | null> {
  try {
    const r = await soapCall(gw, 'GetSpecificPortMappingEntry', [['NewRemoteHost', ''], ['NewExternalPort', externalPort], ['NewProtocol', protocol]], http_);
    return {
      internalClient: r.NewInternalClient ?? '',
      internalPort: Number(r.NewInternalPort ?? 0),
      enabled: (r.NewEnabled ?? '1') === '1',
      description: r.NewPortMappingDescription ?? '',
      leaseSeconds: Number(r.NewLeaseDuration ?? 0),
    };
  } catch (e) {
    if (e instanceof UpnpError && e.kind === 'soap' && (e.code === 714 || e.code === 713)) return null;
    throw e;
  }
}

/**
 * Renew = AddPortMapping again with the same parameters. Falls back to a permanent lease (0)
 * if the router answers 725 OnlyPermanentLeasesSupported. Returns the lease actually granted.
 */
export async function renewPortMapping(gw: UpnpGateway, req: PortMappingRequest, http_?: UpnpHttp): Promise<number> {
  try {
    await addPortMapping(gw, req, http_);
    return req.leaseSeconds ?? 3600;
  } catch (e) {
    if (e instanceof UpnpError && e.code === 725) {
      await addPortMapping(gw, { ...req, leaseSeconds: 0 }, http_);
      return 0;
    }
    throw e;
  }
}