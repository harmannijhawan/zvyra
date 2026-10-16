/**
 * NAT-PMP (RFC 6886) client: public-address request and TCP/UDP port mappings against the default gateway.
 * PCP (RFC 6887) is intentionally not implemented.
 */
import dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import { ipv4ToInt } from './wan';

export const NATPMP_PORT = 5351;

export type NatPmpErrorKind = 'no_gateway' | 'timeout' | 'protocol' | 'refused' | 'network';

export class NatPmpError extends Error {
  constructor(public readonly kind: NatPmpErrorKind, message: string, public readonly resultCode?: number) {
    super(message);
    this.name = 'NatPmpError';
  }
}

export const NATPMP_RESULT_TEXT: Record<number, string> = {
  0: 'success',
  1: 'unsupported version',
  2: 'not authorized/refused (NAT-PMP disabled on the router)',
  3: 'network failure (router has no upstream connection)',
  4: 'out of resources',
  5: 'unsupported opcode',
};

// ---------- packet encode / decode ----------

export function encodePublicAddressRequest(): Buffer {
  return Buffer.from([0, 0]);
}

export interface PublicAddressResponse {
  resultCode: number;
  epoch: number;
  publicIp: string | null;
}

export function decodePublicAddressResponse(buf: Buffer): PublicAddressResponse {
  if (buf.length < 12) throw new NatPmpError('protocol', `short NAT-PMP address response (${buf.length} bytes)`);
  if (buf[0] !== 0) throw new NatPmpError('protocol', `unexpected NAT-PMP version ${buf[0]}`);
  if (buf[1] !== 128) throw new NatPmpError('protocol', `unexpected opcode ${buf[1]} in address response`);
  const resultCode = buf.readUInt16BE(2);
  const epoch = buf.readUInt32BE(4);
  const publicIp = resultCode === 0 ? `${buf[8]}.${buf[9]}.${buf[10]}.${buf[11]}` : null;
  return { resultCode, epoch, publicIp };
}

export type NatPmpProtocol = 'udp' | 'tcp';

export interface MappingRequest {
  protocol: NatPmpProtocol;
  internalPort: number;
  /** suggested external port; 0 lets the router choose */
  externalPort: number;
  /** seconds; 0 with externalPort 0 deletes the mapping */
  lifetime: number;
}

export function encodeMappingRequest(req: MappingRequest): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt8(0, 0);
  buf.writeUInt8(req.protocol === 'udp' ? 1 : 2, 1);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(req.internalPort, 4);
  buf.writeUInt16BE(req.externalPort, 6);
  buf.writeUInt32BE(req.lifetime, 8);
  return buf;
}

export interface MappingResponse {
  protocol: NatPmpProtocol;
  resultCode: number;
  epoch: number;
  internalPort: number;
  externalPort: number;
  lifetime: number;
}

export function decodeMappingResponse(buf: Buffer): MappingResponse {
  if (buf.length < 16) throw new NatPmpError('protocol', `short NAT-PMP mapping response (${buf.length} bytes)`);
  if (buf[0] !== 0) throw new NatPmpError('protocol', `unexpected NAT-PMP version ${buf[0]}`);
  const op = buf[1];
  if (op !== 129 && op !== 130) throw new NatPmpError('protocol', `unexpected opcode ${op} in mapping response`);
  return {
    protocol: op === 129 ? 'udp' : 'tcp',
    resultCode: buf.readUInt16BE(2),
    epoch: buf.readUInt32BE(4),
    internalPort: buf.readUInt16BE(8),
    externalPort: buf.readUInt16BE(10),
    lifetime: buf.readUInt32BE(12),
  };
}

// ---------- transport ----------

export interface NatPmpTransportOptions {
  /** first retry timeout; doubles each attempt (RFC: 250 ms) */
  initialTimeoutMs?: number;
  attempts?: number;
}

/** Send a request to gateway:5351 and return the first datagram coming from the gateway that `accept` takes. */
export function natpmpExchange(gateway: string, request: Buffer, accept: (resp: Buffer) => boolean, opts: NatPmpTransportOptions = {}): Promise<Buffer> {
  const attempts = opts.attempts ?? 3;
  const initial = opts.initialTimeoutMs ?? 250;
  return new Promise<Buffer>((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let attempt = 0;
    const end = (err: Error | null, data?: Buffer): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { sock.close(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(data as Buffer);
    };
    const send = (): void => {
      if (attempt >= attempts) return end(new NatPmpError('timeout', `no NAT-PMP answer from ${gateway}:${NATPMP_PORT} (router does not support NAT-PMP or it is disabled)`));
      const wait = initial * 2 ** attempt;
      attempt++;
      sock.send(request, NATPMP_PORT, gateway, (err) => {
        if (err) end(new NatPmpError('network', `send to ${gateway} failed: ${err.message}`));
      });
      timer = setTimeout(send, wait);
    };
    sock.on('error', (e) => end(new NatPmpError('network', e.message)));
    sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== gateway || rinfo.port !== NATPMP_PORT) return;
      try {
        if (accept(msg)) end(null, msg);
      } catch (e) {
        end(e as Error);
      }
    });
    sock.bind({ port: 0, address: '0.0.0.0' }, send);
  });
}

function checkResult(code: number, what: string): void {
  if (code !== 0) throw new NatPmpError(code === 2 ? 'refused' : 'protocol', `NAT-PMP ${what}: ${NATPMP_RESULT_TEXT[code] ?? `result code ${code}`}`, code);
}

export async function getPublicAddress(gateway: string, opts?: NatPmpTransportOptions): Promise<{ publicIp: string; epoch: number }> {
  const raw = await natpmpExchange(gateway, encodePublicAddressRequest(), (b) => b.length >= 2 && b[1] === 128, opts);
  const r = decodePublicAddressResponse(raw);
  checkResult(r.resultCode, 'public address request');
  return { publicIp: r.publicIp as string, epoch: r.epoch };
}

export async function addMapping(gateway: string, req: MappingRequest, opts?: NatPmpTransportOptions): Promise<MappingResponse> {
  const wantOp = req.protocol === 'udp' ? 129 : 130;
  const raw = await natpmpExchange(
    gateway,
    encodeMappingRequest(req),
    (b) => b.length >= 12 && b[1] === wantOp && b.readUInt16BE(8) === req.internalPort,
    opts,
  );
  const r = decodeMappingResponse(raw);
  checkResult(r.resultCode, 'mapping request');
  return r;
}

export async function deleteMapping(gateway: string, protocol: NatPmpProtocol, internalPort: number, opts?: NatPmpTransportOptions): Promise<void> {
  await addMapping(gateway, { protocol, internalPort, externalPort: 0, lifetime: 0 }, opts);
}

// ---------- default gateway discovery ----------

export interface Route {
  gateway: string;
  iface: string;
  metric: number;
}

/** Parse the IPv4 table of `route print -4` and return the best (lowest metric) default route. */
export function parseRoutePrint(text: string): Route | null {
  const routes: Route[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    if (ipv4ToInt(m[1]) === null || m[1] === '0.0.0.0') continue; // "On-link" etc.
    routes.push({ gateway: m[1], iface: m[2], metric: Number(m[3]) });
  }
  routes.sort((a, b) => a.metric - b.metric);
  return routes[0] ?? null;
}

/** Parse `ip route` output (non-Windows fallback). */
export function parseIpRoute(text: string): Route | null {
  const m = /^default via (\d+\.\d+\.\d+\.\d+)(?: dev (\S+))?/m.exec(text);
  return m ? { gateway: m[1], iface: m[2] ?? '', metric: 0 } : null;
}

export type CommandRunner = (file: string, args: string[], timeoutMs?: number) => Promise<string>;

export const defaultRunner: CommandRunner = (file, args, timeoutMs = 8000) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout));
    });
  });

/** Default IPv4 gateway of this machine. `runner` is injectable for tests. Returns null when unknown. */
export async function getDefaultGateway(runner: CommandRunner = defaultRunner, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  try {
    if (platform === 'win32') {
      const out = await runner('route', ['print', '-4']);
      return parseRoutePrint(out)?.gateway ?? null;
    }
    const out = await runner('ip', ['route', 'show', 'default']);
    return parseIpRoute(out)?.gateway ?? null;
  } catch {
    return null;
  }
}