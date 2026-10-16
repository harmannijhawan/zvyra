import { afterEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ deleted: [] as number[], added: [] as number[] }));

vi.mock('../../electron/remote/connectivity/stun', async (orig) => ({
  ...(await orig<typeof import('../../electron/remote/connectivity/stun')>()),
  getPublicAddress: async () => ({ mapped: { address: '203.0.113.7', port: 1, family: 'IPv4' }, results: [], errors: [] }),
  detectNatMapping: async () => ({ natType: 'endpoint-independent', publicIp: '203.0.113.7', mappedPorts: [], localPort: 1, reason: 'mock' }),
}));
vi.mock('../../electron/remote/connectivity/upnp', async (orig) => {
  const real = await orig<typeof import('../../electron/remote/connectivity/upnp')>();
  const gw = { location: 'http://192.168.1.1/d', controlUrl: 'http://192.168.1.1/c', serviceType: 'urn:x:WANIPConnection:1', localAddress: '192.168.1.20', gatewayIp: '192.168.1.1' };
  return {
    ...real,
    discoverGateway: async () => gw,
    getExternalIPAddress: async () => '203.0.113.7',
    getSpecificPortMapping: async () => null,
    renewPortMapping: async (_g: unknown, r: { externalPort: number }) => { fx.added.push(r.externalPort); return 3600; },
    deletePortMapping: async (_g: unknown, p: number) => { fx.deleted.push(p); },
  };
});
vi.mock('../../electron/remote/connectivity/natpmp', async (orig) => ({
  ...(await orig<typeof import('../../electron/remote/connectivity/natpmp')>()),
  getDefaultGateway: async () => null,
}));
vi.mock('../../electron/remote/connectivity/ipv6', async (orig) => ({
  ...(await orig<typeof import('../../electron/remote/connectivity/ipv6')>()),
  listGlobalIPv6: async () => [{ address: '2401:db8::10', interface: 'x', temporary: false, deprecated: false }],
  firewallRuleExists: async () => true,
}));

import * as mod from '../../electron/remote/connectivity';

afterEach(async () => { await mod.stop(); fx.added.length = 0; fx.deleted.length = 0; });

describe('module-level API (hook contract)', () => {
  it('exports the three functions', () => {
    expect(typeof mod.getCandidateEndpoints).toBe('function');
    expect(typeof mod.start).toBe('function');
    expect(typeof mod.stop).toBe('function');
    expect(typeof mod.ConnectivityManager).toBe('function');
    expect(typeof mod.ensureFirewallRuleElevated).toBe('function');
    expect(typeof mod.removeFirewallRuleElevated).toBe('function');
  });

  it('stop() without start() is a harmless no-op, twice', async () => {
    await expect(mod.stop()).resolves.toBeUndefined();
    await expect(mod.stop()).resolves.toBeUndefined();
  });

  it('getCandidateEndpoints before start(): quick LAN + IPv6 only, no mapping', async () => {
    const t = Date.now();
    const list = await mod.getCandidateEndpoints();
    expect(Date.now() - t).toBeLessThan(2600);
    expect(list.every((s) => typeof s === 'string')).toBe(true);
    expect(list).toContain('[2401:db8::10]:47821');
    expect(fx.added).toEqual([]);
  });

  it('start/get/stop with the hook context; idempotent; mapping removed on stop', async () => {
    await mod.start({ port: 48000, fingerprint: 'ab', pcName: 'PC' });
    await mod.start({ port: 48000, fingerprint: 'ab', pcName: 'PC' }); // idempotent
    await new Promise((r) => setTimeout(r, 50));
    expect(fx.added).toEqual([48000]);
    const list = await mod.getCandidateEndpoints();
    expect(list).toContain('[2401:db8::10]:48000');
    expect(list).toContain('203.0.113.7:48000');
    expect(mod.getConnectivityStatus()?.upnp.mapped).toBe(true);
    await mod.stop();
    await mod.stop(); // idempotent
    expect(fx.deleted).toEqual([48000]);
    expect(mod.getConnectivityStatus()).toBeNull();
  });

  it('restarting with another port removes the old mapping first', async () => {
    await mod.start({ port: 48001 });
    await new Promise((r) => setTimeout(r, 50));
    await mod.start({ port: 48002 });
    await new Promise((r) => setTimeout(r, 50));
    expect(fx.deleted).toEqual([48001]);
    await mod.stop();
    expect(fx.deleted).toEqual([48001, 48002]);
  });

  it('start() with junk input never throws', async () => {
    await expect(mod.start({ port: Number.NaN })).resolves.toBeUndefined();
    await expect(mod.start(undefined as never)).resolves.toBeUndefined();
  });
});