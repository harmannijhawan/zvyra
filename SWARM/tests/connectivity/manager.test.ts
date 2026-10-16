import { describe, expect, it, vi } from 'vitest';
import { ConnectivityManager, collectLanIPv4, formatEndpoint, type ConnectivityDeps } from '../../electron/remote/connectivity';
import { UpnpError, type UpnpGateway } from '../../electron/remote/connectivity/upnp';
import { NatPmpError } from '../../electron/remote/connectivity/natpmp';

const GW: UpnpGateway = { location: 'http://192.168.1.1/d.xml', controlUrl: 'http://192.168.1.1/c', serviceType: 'urn:x:WANIPConnection:1', localAddress: '192.168.1.20', gatewayIp: '192.168.1.1' };

function makeDeps(over: { routerIp?: string; stunIp?: string; upnpFail?: boolean; pmpIp?: string | null; pmpMap?: boolean; upnpConflictPorts?: number[] } = {}) {
  const added: number[] = [];
  const deleted: Array<[string, number]> = [];
  const deps: ConnectivityDeps = {
    lanIPv4: () => ['192.168.1.20'],
    globalIPv6: async () => [{ address: '2401:db8::10', interface: 'Wi-Fi', temporary: false, deprecated: false }, { address: '2401:db8::abcd', interface: 'Wi-Fi', temporary: true, deprecated: false }],
    firewallOk: async () => false,
    stunPublicIp: async () => ({ ip: over.stunIp ?? '203.0.113.7', error: null }),
    natDetect: async () => ({ natType: 'endpoint-independent', publicIp: over.stunIp ?? '203.0.113.7', mappedPorts: [], localPort: 1, reason: 'x' }),
    upnp: {
      discoverGateway: async () => { if (over.upnpFail) throw new UpnpError('no_gateway', 'none'); return GW; },
      getExternalIPAddress: async () => over.routerIp ?? '203.0.113.7',
      getSpecificPortMapping: async () => null,
      renewPortMapping: async (_g, r) => {
        if (over.upnpConflictPorts?.includes(r.externalPort)) throw new UpnpError('soap', 'conflict', 718);
        added.push(r.externalPort);
        return r.leaseSeconds ?? 3600;
      },
      addPortMapping: async () => undefined,
      deletePortMapping: async (_g, p) => { deleted.push(['upnp', p]); },
    },
    natpmp: {
      getDefaultGateway: async () => '192.168.1.1',
      getPublicAddress: async () => { if (over.pmpIp === null) throw new NatPmpError('timeout', 'no answer'); return { publicIp: over.pmpIp ?? '203.0.113.7', epoch: 1 }; },
      addMapping: async (_g, r) => { added.push(r.externalPort); return { protocol: 'tcp', resultCode: 0, epoch: 1, internalPort: r.internalPort, externalPort: r.externalPort, lifetime: r.lifetime }; },
      deleteMapping: async (_g, _p, ip) => { deleted.push(['natpmp', ip]); },
    },
    randomPort: (() => { let n = 30000; return () => n++; })(),
  };
  return { deps, added, deleted };
}

describe('candidate formatting', () => {
  it('formats v4 and v6', () => {
    expect(formatEndpoint('192.168.1.2', 47821)).toBe('192.168.1.2:47821');
    expect(formatEndpoint('2401:db8::1', 47821)).toBe('[2401:db8::1]:47821');
  });
  it('collectLanIPv4 skips loopback/link-local and puts virtual adapters last', () => {
    const mk = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null }) as never;
    expect(collectLanIPv4({ 'vEthernet (WSL)': [mk('172.20.0.1')], Wi: [mk('192.168.1.2'), mk('169.254.3.3')], lo: [mk('127.0.0.1', true)] })).toEqual(['192.168.1.2', '172.20.0.1']);
  });
});

describe('ConnectivityManager', () => {
  it('maps via UPnP, lists LAN -> IPv6 -> mapped, avoids temporary v6, and deletes on stop', async () => {
    const { deps, added, deleted } = makeDeps();
    const m = new ConnectivityManager({ deps });
    await m.start(47821);
    const s = m.getStatus();
    expect(s.upnp).toMatchObject({ ok: true, mapped: true, externalIp: '203.0.113.7', externalPort: 47821, error: null });
    expect(s.natpmp.mapped).toBe(false);
    expect(s.publicAddress).toBe('yes');
    expect(s.ipv6.firewallRuleOk).toBe(false);
    expect(s.summary).toContain('203.0.113.7:47821');
    expect(await m.getCandidateEndpoints(47821)).toEqual(['192.168.1.20:47821', '[2401:db8::10]:47821', '203.0.113.7:47821']);
    expect(added).toEqual([47821]);
    await m.stop();
    expect(deleted).toEqual([['upnp', 47821]]);
    expect(m.getStatus().running).toBe(false);
    expect(m.getStatus().upnp.mapped).toBe(false);
  });

  it('does not advertise a mapped endpoint when the router WAN address is non-public', async () => {
    const { deps } = makeDeps({ routerIp: '100.72.3.9' });
    const m = new ConnectivityManager({ deps });
    await m.start(47821);
    expect(m.getStatus().publicAddress).toBe('no');
    expect(await m.getCandidateEndpoints()).toEqual(['192.168.1.20:47821', '[2401:db8::10]:47821']);
    expect(m.getStatus().summary).toMatch(/not publicly reachable/);
    await m.stop();
  });

  it('falls back to a random external port on conflict (718)', async () => {
    const { deps, added } = makeDeps({ upnpConflictPorts: [47821] });
    const m = new ConnectivityManager({ deps });
    await m.start(47821);
    expect(added).toEqual([30000]);
    expect(await m.getCandidateEndpoints()).toContain('203.0.113.7:30000');
    await m.stop();
  });

  it('falls back to NAT-PMP when UPnP is unavailable and deletes it on stop', async () => {
    const { deps, deleted } = makeDeps({ upnpFail: true });
    const m = new ConnectivityManager({ deps });
    await m.start(47821);
    const s = m.getStatus();
    expect(s.upnp).toMatchObject({ ok: false, mapped: false, error: 'none' });
    expect(s.natpmp).toMatchObject({ ok: true, mapped: true, externalPort: 47821 });
    await m.stop();
    expect(deleted).toEqual([['natpmp', 47821]]);
  });

  it('diagnostic mode (mapPorts:false) never creates a mapping', async () => {
    const { deps, added } = makeDeps();
    const m = new ConnectivityManager({ deps, mapPorts: false });
    await m.start(47821);
    expect(added).toEqual([]);
    const s = m.getStatus();
    expect(s.upnp).toMatchObject({ ok: true, mapped: false, externalIp: '203.0.113.7' });
    expect(await m.getCandidateEndpoints()).toEqual(['192.168.1.20:47821', '[2401:db8::10]:47821']);
    await m.stop();
  });

  it('reports errors when nothing works, and still returns LAN endpoints', async () => {
    const { deps } = makeDeps({ upnpFail: true, pmpIp: null });
    const m = new ConnectivityManager({ deps });
    await m.start();
    const s = m.getStatus();
    expect(s.port).toBe(47821);
    expect(s.natpmp.error).toMatch(/no answer/);
    expect(s.publicAddress).toBe('unknown');
    expect(await m.getCandidateEndpoints()).toEqual(['192.168.1.20:47821', '[2401:db8::10]:47821']);
    await m.stop();
  });

  it('works before start() via a diagnostic probe, with default port 47821', async () => {
    const { deps, added } = makeDeps();
    const m = new ConnectivityManager({ deps });
    expect((await m.getCandidateEndpoints())[0]).toBe('192.168.1.20:47821');
    expect(added).toEqual([]);
  });

  it('stop() during start() removes a mapping that completes late', async () => {
    const { deps, deleted } = makeDeps();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const orig = deps.upnp.renewPortMapping;
    deps.upnp.renewPortMapping = async (g, r, h) => { await gate; return orig(g, r, h); };
    const m = new ConnectivityManager({ deps });
    const starting = m.start(47821);
    await new Promise((r) => setTimeout(r, 30));
    const stopping = m.stop();
    release();
    await starting;
    await stopping;
    expect(deleted).toEqual([['upnp', 47821]]);
  });

  it('renews before expiry (timer) and keeps timers unref-ed', async () => {
    vi.useFakeTimers();
    try {
      const { deps, added } = makeDeps();
      const m = new ConnectivityManager({ deps, leaseSeconds: 120 });
      const p = m.start(47821);
      await vi.advanceTimersByTimeAsync(10);
      await p;
      expect(added.length).toBe(1);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(added.length).toBe(2);
      await m.stop();
      await vi.advanceTimersByTimeAsync(200_000);
      expect(added.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});