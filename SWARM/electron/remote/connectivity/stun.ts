/**
 * Minimal RFC 5389 STUN Binding client over UDP (IPv4 and IPv6). No dependencies.
 *
 * Only Binding requests are sent; nothing here opens a listener that accepts connections.
 */
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

export const STUN_MAGIC_COOKIE = 0x2112a442;
export const STUN_BINDING_REQUEST = 0x0001;
export const STUN_BINDING_SUCCESS = 0x0101;
export const STUN_BINDING_ERROR = 0x0111;
export const STUN_ATTR_MAPPED_ADDRESS = 0x0001;
export const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020;
export const STUN_ATTR_ERROR_CODE = 0x0009;

export interface StunServer {
  host: string;
  port: number;
}

export const DEFAULT_STUN_SERVERS: StunServer[] = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun1.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
];

export interface MappedAddress {
  address: string;
  port: number;
  family: 'IPv4' | 'IPv6';
}

export interface StunAttribute {
  type: number;
  value: Buffer;
}

export interface StunMessage {
  type: number;
  length: number;
  txId: Buffer;
  attributes: StunAttribute[];
}

/** Build a Binding Request (20-byte header, no attributes). */
export function encodeBindingRequest(txId: Buffer = randomBytes(12)): Buffer {
  if (txId.length !== 12) throw new Error('STUN transaction id must be 12 bytes');
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  txId.copy(buf, 8);
  return buf;
}

/** Parse the STUN header + attributes. Returns null if the datagram is not a well-formed STUN message. */
export function parseStunMessage(buf: Buffer): StunMessage | null {
  if (buf.length < 20) return null;
  if ((buf[0] & 0xc0) !== 0) return null; // top two bits must be zero
  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  if (buf.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return null;
  if (length % 4 !== 0 || 20 + length > buf.length) return null;
  const txId = Buffer.from(buf.subarray(8, 20));
  const attributes: StunAttribute[] = [];
  let off = 20;
  const end = 20 + length;
  while (off + 4 <= end) {
    const aType = buf.readUInt16BE(off);
    const aLen = buf.readUInt16BE(off + 2);
    const vStart = off + 4;
    if (vStart + aLen > end) return null;
    attributes.push({ type: aType, value: Buffer.from(buf.subarray(vStart, vStart + aLen)) });
    off = vStart + ((aLen + 3) & ~3);
  }
  return { type, length, txId, attributes };
}

/** Format 16 bytes as a compressed IPv6 literal (RFC 5952 style). */
export function formatIPv6(bytes: Buffer): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(':');
  const head = groups.slice(0, bestStart).map((g) => g.toString(16)).join(':');
  const tail = groups.slice(bestStart + bestLen).map((g) => g.toString(16)).join(':');
  return `${head}::${tail}`;
}

/** Parse the value of a (XOR-)MAPPED-ADDRESS attribute. */
export function parseMappedAddressValue(value: Buffer, xor: boolean, txId: Buffer): MappedAddress | null {
  if (value.length < 4) return null;
  const family = value[1];
  let port = value.readUInt16BE(2);
  if (xor) port ^= STUN_MAGIC_COOKIE >>> 16;
  if (family === 0x01) {
    if (value.length < 8) return null;
    const raw = Buffer.from(value.subarray(4, 8));
    if (xor) {
      const cookie = Buffer.alloc(4);
      cookie.writeUInt32BE(STUN_MAGIC_COOKIE, 0);
      for (let i = 0; i < 4; i++) raw[i] ^= cookie[i];
    }
    return { address: Array.from(raw).join('.'), port, family: 'IPv4' };
  }
  if (family === 0x02) {
    if (value.length < 20) return null;
    const raw = Buffer.from(value.subarray(4, 20));
    if (xor) {
      const mask = Buffer.alloc(16);
      mask.writeUInt32BE(STUN_MAGIC_COOKIE, 0);
      txId.copy(mask, 4);
      for (let i = 0; i < 16; i++) raw[i] ^= mask[i];
    }
    return { address: formatIPv6(raw), port, family: 'IPv6' };
  }
  return null;
}

/**
 * Decode a Binding response. Returns the mapped address (XOR-MAPPED-ADDRESS preferred,
 * MAPPED-ADDRESS as RFC 3489 fallback) or null when the message is not a usable success response.
 */
export function decodeBindingResponse(buf: Buffer, expectedTxId?: Buffer): { txId: Buffer; mapped: MappedAddress } | null {
  const msg = parseStunMessage(buf);
  if (!msg || msg.type !== STUN_BINDING_SUCCESS) return null;
  if (expectedTxId && !msg.txId.equals(expectedTxId)) return null;
  const xorAttr = msg.attributes.find((a) => a.type === STUN_ATTR_XOR_MAPPED_ADDRESS);
  if (xorAttr) {
    const m = parseMappedAddressValue(xorAttr.value, true, msg.txId);
    if (m) return { txId: msg.txId, mapped: m };
  }
  const plain = msg.attributes.find((a) => a.type === STUN_ATTR_MAPPED_ADDRESS);
  if (plain) {
    const m = parseMappedAddressValue(plain.value, false, msg.txId);
    if (m) return { txId: msg.txId, mapped: m };
  }
  return null;
}

export interface StunResult {
  server: StunServer;
  mapped: MappedAddress;
  /** address the response came from (the server's resolved IP) */
  from: { address: string; port: number };
  rttMs: number;
  /** local UDP port the request was sent from */
  localPort: number;
}

interface Pending {
  server: StunServer;
  sentAt: number;
  resolve: (r: StunResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** One UDP socket that can send Binding requests to several servers (needed for NAT mapping tests). */
export class StunSocket {
  private pending = new Map<string, Pending>();
  private closed = false;

  private constructor(private readonly sock: dgram.Socket) {
    sock.on('message', (msg, rinfo) => {
      const parsed = parseStunMessage(msg);
      if (!parsed) return;
      const key = parsed.txId.toString('hex');
      const p = this.pending.get(key);
      if (!p) return;
      const decoded = decodeBindingResponse(msg, parsed.txId);
      this.pending.delete(key);
      clearTimeout(p.timer);
      if (!decoded) {
        p.reject(new Error(`STUN ${p.server.host}:${p.server.port} returned no mapped address`));
        return;
      }
      p.resolve({
        server: p.server,
        mapped: decoded.mapped,
        from: { address: rinfo.address, port: rinfo.port },
        rttMs: Date.now() - p.sentAt,
        localPort: this.localPort,
      });
    });
    sock.on('error', (err) => this.failAll(err));
  }

  static async create(family: 4 | 6 = 4, bindAddress?: string): Promise<StunSocket> {
    const sock = dgram.createSocket({ type: family === 6 ? 'udp6' : 'udp4', reuseAddr: false });
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      sock.once('error', onErr);
      sock.bind({ port: 0, address: bindAddress }, () => {
        sock.off('error', onErr);
        resolve();
      });
    });
    return new StunSocket(sock);
  }

  get localPort(): number {
    try {
      return this.sock.address().port;
    } catch {
      return 0;
    }
  }

  private failAll(err: Error): void {
    for (const [k, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(k);
    }
  }

  request(server: StunServer, timeoutMs = 2500): Promise<StunResult> {
    return new Promise<StunResult>((resolve, reject) => {
      if (this.closed) return reject(new Error('STUN socket closed'));
      const txId = randomBytes(12);
      const key = txId.toString('hex');
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`STUN ${server.host}:${server.port} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(key, { server, sentAt: Date.now(), resolve, reject, timer });
      this.sock.send(encodeBindingRequest(txId), server.port, server.host, (err) => {
        if (err) {
          const p = this.pending.get(key);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(key);
          }
          reject(new Error(`STUN send to ${server.host}:${server.port} failed: ${err.message}`));
        }
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('STUN socket closed'));
    try { this.sock.close(); } catch { /* already closed */ }
  }
}

export interface StunQueryOptions {
  servers?: StunServer[];
  family?: 4 | 6;
  timeoutMs?: number;
}

export interface StunQueryOutcome {
  results: StunResult[];
  errors: string[];
}

/** Query all servers in parallel from one socket. Never throws; failures are listed in `errors`. */
export async function queryStunServers(opts: StunQueryOptions = {}): Promise<StunQueryOutcome> {
  const servers = opts.servers ?? DEFAULT_STUN_SERVERS;
  let sock: StunSocket;
  try {
    sock = await StunSocket.create(opts.family ?? 4);
  } catch (e) {
    return { results: [], errors: [`cannot open UDP socket: ${(e as Error).message}`] };
  }
  try {
    const settled = await Promise.allSettled(servers.map((s) => sock.request(s, opts.timeoutMs ?? 2500)));
    const results: StunResult[] = [];
    const errors: string[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') results.push(s.value);
      else errors.push((s.reason as Error).message);
    }
    return { results, errors };
  } finally {
    sock.close();
  }
}

/** Convenience: the public address as seen by the first server (consensus = most frequent address). */
export async function getPublicAddress(opts: StunQueryOptions = {}): Promise<{ mapped: MappedAddress | null; results: StunResult[]; errors: string[] }> {
  const { results, errors } = await queryStunServers(opts);
  if (results.length === 0) return { mapped: null, results, errors };
  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.mapped.address, (counts.get(r.mapped.address) ?? 0) + 1);
  let best = results[0];
  let bestCount = 0;
  for (const r of results) {
    const c = counts.get(r.mapped.address) ?? 0;
    if (c > bestCount) { best = r; bestCount = c; }
  }
  return { mapped: best.mapped, results, errors };
}

export type NatMappingType = 'endpoint-independent' | 'symmetric' | 'unknown';

export interface NatDetection {
  natType: NatMappingType;
  publicIp: string | null;
  /** mapped public ports observed per server (same local socket) */
  mappedPorts: Array<{ server: string; ip: string; port: number }>;
  localPort: number | null;
  reason: string;
}

/** Pure classification of results gathered from ONE local socket against different servers. */
export function classifyNatMapping(results: StunResult[], localPort: number | null = null): NatDetection {
  // Only responses from distinct server endpoints are comparable.
  const distinct = new Map<string, StunResult>();
  for (const r of results) {
    const k = `${r.from.address}:${r.from.port}`;
    if (!distinct.has(k)) distinct.set(k, r);
  }
  const list = [...distinct.values()];
  const mappedPorts = list.map((r) => ({ server: `${r.server.host}:${r.server.port}`, ip: r.mapped.address, port: r.mapped.port }));
  const publicIp = list[0]?.mapped.address ?? null;
  if (list.length < 2) {
    return { natType: 'unknown', publicIp, mappedPorts, localPort, reason: list.length === 0 ? 'no STUN server answered' : 'only one STUN server answered, cannot compare mappings' };
  }
  const ports = new Set(list.map((r) => r.mapped.port));
  const ips = new Set(list.map((r) => r.mapped.address));
  if (ports.size === 1 && ips.size === 1) {
    return { natType: 'endpoint-independent', publicIp, mappedPorts, localPort, reason: `same mapping (${publicIp}:${list[0].mapped.port}) seen by ${list.length} different servers` };
  }
  return { natType: 'symmetric', publicIp, mappedPorts, localPort, reason: `mapping differs per destination (${list.map((r) => `${r.mapped.address}:${r.mapped.port}`).join(', ')})` };
}

/**
 * Send Binding requests from the SAME local UDP socket to different STUN servers and compare the
 * mapped endpoints: identical => endpoint-independent (cone-like), different => symmetric.
 */
export async function detectNatMapping(opts: { servers?: StunServer[]; timeoutMs?: number } = {}): Promise<NatDetection> {
  let sock: StunSocket;
  try {
    sock = await StunSocket.create(4);
  } catch (e) {
    return { natType: 'unknown', publicIp: null, mappedPorts: [], localPort: null, reason: `cannot open UDP socket: ${(e as Error).message}` };
  }
  try {
    const servers = opts.servers ?? DEFAULT_STUN_SERVERS;
    const settled = await Promise.allSettled(servers.map((s) => sock.request(s, opts.timeoutMs ?? 2500)));
    const results = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    const det = classifyNatMapping(results, sock.localPort);
    if (results.length === 0) {
      const errs = settled.flatMap((s) => (s.status === 'rejected' ? [(s.reason as Error).message] : []));
      det.reason = `no STUN server answered (${errs.join('; ')})`;
    }
    return det;
  } finally {
    sock.close();
  }
}