import { describe, expect, it } from 'vitest';
import {
  encodePublicAddressRequest, decodePublicAddressResponse, encodeMappingRequest, decodeMappingResponse, parseRoutePrint, parseIpRoute, getDefaultGateway, NatPmpError,
} from '../../electron/remote/connectivity/natpmp';

const ROUTE_PRINT = `===========================================================================
Interface List
 12...aa bb cc dd ee ff ......Realtek PCIe GbE Family Controller
===========================================================================

IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.168.29.1    192.168.29.50     35
          0.0.0.0          0.0.0.0      10.8.0.1        10.8.0.2         100
        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331
===========================================================================
Persistent Routes:
  None
`;

describe('NAT-PMP packets', () => {
  it('encodes the public address request', () => {
    expect([...encodePublicAddressRequest()]).toEqual([0, 0]);
  });
  it('decodes a public address response', () => {
    const buf = Buffer.from('00 80 00 00 00 00 01 00 c0 00 02 07'.replace(/ /g, ''), 'hex');
    expect(decodePublicAddressResponse(buf)).toEqual({ resultCode: 0, epoch: 256, publicIp: '192.0.2.7' });
  });
  it('decodes error result codes without an IP', () => {
    const buf = Buffer.from('008000030000000000000000', 'hex');
    expect(decodePublicAddressResponse(buf)).toEqual({ resultCode: 3, epoch: 0, publicIp: null });
  });
  it('rejects short / wrong-version packets', () => {
    expect(() => decodePublicAddressResponse(Buffer.alloc(4))).toThrow(NatPmpError);
    expect(() => decodePublicAddressResponse(Buffer.from('018000000000000000000000', 'hex'))).toThrow(/version/);
  });
  it('encodes a TCP mapping request (RFC 6886 layout)', () => {
    const b = encodeMappingRequest({ protocol: 'tcp', internalPort: 47821, externalPort: 47821, lifetime: 3600 });
    expect(b.toString('hex')).toBe('0002' + '0000' + 'bacd' + 'bacd' + '00000e10');
  });
  it('encodes UDP opcode 1 and deletion (lifetime 0, external 0)', () => {
    expect(encodeMappingRequest({ protocol: 'udp', internalPort: 5, externalPort: 0, lifetime: 0 }).toString('hex')).toBe('000100000005000000000000');
  });
  it('decodes a mapping response', () => {
    const b = Buffer.from('0082' + '0000' + '00000064' + 'bacd' + '9c40' + '00000e10', 'hex');
    expect(decodeMappingResponse(b)).toEqual({ protocol: 'tcp', resultCode: 0, epoch: 100, internalPort: 47821, externalPort: 40000, lifetime: 3600 });
    expect(() => decodeMappingResponse(Buffer.from('0080' + '00'.repeat(14), 'hex'))).toThrow(/opcode/);
  });
});

describe('default gateway', () => {
  it('parses route print and picks the lowest metric', () => {
    expect(parseRoutePrint(ROUTE_PRINT)).toEqual({ gateway: '192.168.29.1', iface: '192.168.29.50', metric: 35 });
  });
  it('ignores on-link default routes and empty output', () => {
    expect(parseRoutePrint('0.0.0.0 0.0.0.0 On-link 10.0.0.2 20')).toBeNull();
    expect(parseRoutePrint('')).toBeNull();
  });
  it('parses ip route', () => {
    expect(parseIpRoute('default via 10.0.0.1 dev eth0 proto dhcp')?.gateway).toBe('10.0.0.1');
  });
  it('uses an injected runner; returns null on failure', async () => {
    expect(await getDefaultGateway(async () => ROUTE_PRINT, 'win32')).toBe('192.168.29.1');
    expect(await getDefaultGateway(async () => { throw new Error('boom'); }, 'win32')).toBeNull();
  });
});