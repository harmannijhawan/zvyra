import { describe, expect, it } from 'vitest';
import dgram from 'node:dgram';
import {
  encodeBindingRequest, parseStunMessage, decodeBindingResponse, formatIPv6, classifyNatMapping,
  StunSocket, STUN_BINDING_SUCCESS, STUN_MAGIC_COOKIE, type StunResult,
} from '../../electron/remote/connectivity/stun';

const TX = Buffer.from('b7e7a701bc34d686fa87dfae', 'hex'); // RFC 5769 transaction id

function response(attrs: Buffer[], tx: Buffer = TX): Buffer {
  const body = Buffer.concat(attrs);
  const h = Buffer.alloc(20);
  h.writeUInt16BE(STUN_BINDING_SUCCESS, 0);
  h.writeUInt16BE(body.length, 2);
  h.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  tx.copy(h, 8);
  return Buffer.concat([h, body]);
}
const attr = (type: number, value: Buffer): Buffer => {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(value.length, 2);
  const pad = Buffer.alloc((4 - (value.length % 4)) % 4);
  return Buffer.concat([h, value, pad]);
};

describe('STUN encode/decode', () => {
  it('encodes a Binding request header', () => {
    const buf = encodeBindingRequest(TX);
    expect(buf.toString('hex')).toBe('000100002112a442b7e7a701bc34d686fa87dfae');
  });

  it('rejects wrong transaction id length', () => {
    expect(() => encodeBindingRequest(Buffer.alloc(5))).toThrow();
  });

  it('parses RFC 5769 IPv4 XOR-MAPPED-ADDRESS (192.0.2.1:32853)', () => {
    const value = Buffer.from('0001a147e112a643', 'hex');
    const msg = response([attr(0x0020, value)]);
    const d = decodeBindingResponse(msg, TX);
    expect(d?.mapped).toEqual({ address: '192.0.2.1', port: 32853, family: 'IPv4' });
  });

  it('parses IPv6 XOR-MAPPED-ADDRESS (2001:db8:1234:5678:11:2233:4455:6677)', () => {
    const addr = Buffer.from('20010db8123456780011223344556677', 'hex');
    const mask = Buffer.concat([Buffer.from('2112a442', 'hex'), TX]);
    const x = Buffer.from(addr.map((b, i) => b ^ mask[i]));
    expect(x.subarray(0, 4).toString('hex')).toBe('0113a9fa');
    const value = Buffer.concat([Buffer.from('0002a147', 'hex'), x]);
    const d = decodeBindingResponse(response([attr(0x0020, value)]), TX);
    expect(d?.mapped).toEqual({ address: '2001:db8:1234:5678:11:2233:4455:6677', port: 32853, family: 'IPv6' });
  });

  it('falls back to plain MAPPED-ADDRESS and skips unknown attributes with padding', () => {
    const msg = response([attr(0x8022, Buffer.from('abc')), attr(0x0001, Buffer.from('000113c4cb007101', 'hex'))]);
    expect(decodeBindingResponse(msg)?.mapped).toEqual({ address: '203.0.113.1', port: 5060, family: 'IPv4' });
  });

  it('rejects wrong txid, wrong cookie, short and error messages', () => {
    const msg = response([attr(0x0020, Buffer.from('0001a147e112a643', 'hex'))]);
    expect(decodeBindingResponse(msg, Buffer.alloc(12))).toBeNull();
    const bad = Buffer.from(msg);
    bad.writeUInt32BE(0xdeadbeef, 4);
    expect(parseStunMessage(bad)).toBeNull();
    expect(parseStunMessage(Buffer.alloc(10))).toBeNull();
    const err = Buffer.from(msg);
    err.writeUInt16BE(0x0111, 0);
    expect(decodeBindingResponse(err)).toBeNull();
  });

  it('formats IPv6 with zero compression', () => {
    expect(formatIPv6(Buffer.from('20010db8000000000000000000000001', 'hex'))).toBe('2001:db8::1');
    expect(formatIPv6(Buffer.from('00000000000000000000000000000001', 'hex'))).toBe('::1');
    expect(formatIPv6(Buffer.from('24010db8000100020003000400050006', 'hex'))).toBe('2401:db8:1:2:3:4:5:6');
  });
});

const res = (host: string, from: string, ip: string, port: number): StunResult => ({
  server: { host, port: 3478 }, from: { address: from, port: 3478 }, mapped: { address: ip, port, family: 'IPv4' }, rttMs: 5, localPort: 50000,
});

describe('NAT mapping classification', () => {
  it('same mapping from two servers => endpoint-independent', () => {
    const d = classifyNatMapping([res('a', '1.1.1.1', '203.0.113.5', 40000), res('b', '2.2.2.2', '203.0.113.5', 40000)]);
    expect(d.natType).toBe('endpoint-independent');
    expect(d.publicIp).toBe('203.0.113.5');
  });
  it('different ports => symmetric', () => {
    expect(classifyNatMapping([res('a', '1.1.1.1', '203.0.113.5', 40000), res('b', '2.2.2.2', '203.0.113.5', 40001)]).natType).toBe('symmetric');
  });
  it('one or zero distinct servers => unknown', () => {
    expect(classifyNatMapping([res('a', '1.1.1.1', '203.0.113.5', 40000), res('a2', '1.1.1.1', '203.0.113.5', 40000)]).natType).toBe('unknown');
    expect(classifyNatMapping([]).natType).toBe('unknown');
  });
});

describe('StunSocket against a local fake server', () => {
  it('gets the mapped address from a UDP responder on loopback', async () => {
    const server = dgram.createSocket('udp4');
    server.on('message', (msg, rinfo) => {
      const m = parseStunMessage(msg)!;
      const port = Buffer.alloc(2);
      port.writeUInt16BE(rinfo.port ^ 0x2112, 0);
      const ip = Buffer.from(rinfo.address.split('.').map(Number));
      const cookie = Buffer.from('2112a442', 'hex');
      const xip = Buffer.from(Array.from(ip, (b, i) => b ^ cookie[i]));
      const value = Buffer.concat([Buffer.from([0, 1]), port, xip]);
      server.send(response([attr(0x0020, value)], m.txId), rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => server.bind(0, '127.0.0.1', r));
    const sock = await StunSocket.create(4, '127.0.0.1');
    try {
      const r = await sock.request({ host: '127.0.0.1', port: server.address().port }, 2000);
      expect(r.mapped.address).toBe('127.0.0.1');
      expect(r.mapped.port).toBe(sock.localPort);
    } finally {
      sock.close();
      server.close();
    }
  });
  it('times out when nobody answers', async () => {
    const dead = dgram.createSocket('udp4');
    await new Promise<void>((r) => dead.bind(0, '127.0.0.1', r));
    const sock = await StunSocket.create(4, '127.0.0.1');
    try {
      await expect(sock.request({ host: '127.0.0.1', port: dead.address().port }, 150)).rejects.toThrow(/timed out/);
    } finally {
      sock.close();
      dead.close();
    }
  });
});