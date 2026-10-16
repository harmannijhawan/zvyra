import { describe, expect, it } from 'vitest';
import os from 'node:os';
import { classifyWan, isNonPublicIPv4 } from '../../electron/remote/connectivity/wan';
import {
  isGlobalUnicastV6, fromOsInterfaces, parseNetIpAddressJson, listGlobalIPv6, preferredIPv6, buildAddRuleArgs, ensureFirewallRule,
  firewallRuleExists, removeFirewallRule, buildDeleteRuleArgs,
} from '../../electron/remote/connectivity/ipv6';
import { selfTestPort, startTestListener } from '../../electron/remote/connectivity/reachability';

describe('WAN classification table', () => {
  const cases: Array<[string | null, string | null, string]> = [
    ['192.168.0.5', '203.0.113.9', 'no'],
    ['10.1.2.3', null, 'no'],
    ['172.16.5.5', '203.0.113.9', 'no'],
    ['172.32.0.1', '172.32.0.1', 'yes'], // outside 172.16/12
    ['100.64.1.1', '203.0.113.9', 'no'],
    ['100.127.255.255', null, 'no'],
    ['100.128.0.1', '100.128.0.1', 'yes'],
    ['203.0.113.9', '203.0.113.9', 'yes'],
    ['203.0.113.9', '198.51.100.4', 'no'],
    ['203.0.113.9', null, 'unknown'],
    [null, '203.0.113.9', 'unknown'],
    [null, null, 'unknown'],
    ['0.0.0.0', '203.0.113.9', 'no'],
    ['169.254.1.1', null, 'no'],
  ];
  it.each(cases)('router=%s stun=%s -> %s', (router, stun, expected) => {
    expect(classifyWan({ routerWanIp: router, stunPublicIp: stun }).publicAddress).toBe(expected);
  });
  it('isNonPublicIPv4 edge cases', () => {
    expect(isNonPublicIPv4('8.8.8.8')).toBe(false);
    expect(isNonPublicIPv4('127.0.0.1')).toBe(true);
    expect(isNonPublicIPv4('not-an-ip')).toBe(true);
  });
});

const iface = (address: string, family: 'IPv4' | 'IPv6' = 'IPv6', internal = false): os.NetworkInterfaceInfo =>
  ({ address, family, internal, netmask: '', mac: '', cidr: null } as os.NetworkInterfaceInfo);

describe('IPv6 filtering', () => {
  it('accepts 2000::/3 only, drops link-local, ULA, loopback, 6to4, Teredo', () => {
    expect(isGlobalUnicastV6('2401:4900:1c2a::5')).toBe(true);
    expect(isGlobalUnicastV6('3fff::1')).toBe(true);
    expect(isGlobalUnicastV6('fe80::1%12')).toBe(false);
    expect(isGlobalUnicastV6('fd12:3456::1')).toBe(false);
    expect(isGlobalUnicastV6('fc00::1')).toBe(false);
    expect(isGlobalUnicastV6('::1')).toBe(false);
    expect(isGlobalUnicastV6('2002:c000:204::1')).toBe(false);
    expect(isGlobalUnicastV6('2001:0:4137:9e76::1')).toBe(false);
    expect(isGlobalUnicastV6('2001:db8::1')).toBe(true);
    expect(isGlobalUnicastV6('4000::1')).toBe(false);
  });
  it('filters os.networkInterfaces()', () => {
    const l = fromOsInterfaces({ Wi: [iface('fe80::1'), iface('2401:db8::5'), iface('fd00::2'), iface('192.168.1.2', 'IPv4')], lo: [iface('::1', 'IPv6', true)] });
    expect(l.map((x) => x.address)).toEqual(['2401:db8::5']);
  });
  it('parses Get-NetIPAddress JSON (array, single object, numeric enums)', () => {
    const arr = JSON.stringify([
      { IPAddress: '2401:db8::10', InterfaceAlias: 'Wi-Fi', SuffixOrigin: 'Link', AddressState: 'Preferred' },
      { IPAddress: '2401:db8::abcd', InterfaceAlias: 'Wi-Fi', SuffixOrigin: 'Random', AddressState: 'Preferred' },
      { IPAddress: '2401:db8::dead', InterfaceAlias: 'Wi-Fi', SuffixOrigin: 'Link', AddressState: 'Deprecated' },
      { IPAddress: 'fe80::1', InterfaceAlias: 'Wi-Fi', SuffixOrigin: 'Link', AddressState: 'Preferred' },
    ]);
    const r = parseNetIpAddressJson(arr);
    expect(r.map((x) => [x.address, x.temporary, x.deprecated])).toEqual([['2401:db8::10', false, false], ['2401:db8::abcd', true, false], ['2401:db8::dead', false, true]]);
    expect(parseNetIpAddressJson(JSON.stringify({ IPAddress: '2401:db8::1', SuffixOrigin: 5, AddressState: 4 }))[0].temporary).toBe(true);
    expect(parseNetIpAddressJson('')).toEqual([]);
  });
  it('merges PowerShell flags into the os list; falls back if PowerShell fails', async () => {
    const ifaces = { Wi: [iface('2401:db8::10'), iface('2401:db8::abcd')] };
    const json = JSON.stringify([{ IPAddress: '2401:db8::abcd', SuffixOrigin: 'Random', AddressState: 'Preferred' }]);
    const merged = await listGlobalIPv6({ platform: 'win32', ifaces, runner: async () => json });
    expect(merged.find((m) => m.address === '2401:db8::abcd')?.temporary).toBe(true);
    const fb = await listGlobalIPv6({ platform: 'win32', ifaces, runner: async () => { throw new Error('no ps'); } });
    expect(fb.length).toBe(2);
    expect(fb.every((x) => !x.temporary)).toBe(true);
  });
  it('preferredIPv6 drops deprecated, avoids temporary when a stable one exists', () => {
    const mk = (address: string, temporary: boolean, deprecated: boolean) => ({ address, interface: 'x', temporary, deprecated });
    expect(preferredIPv6([mk('a', true, false), mk('b', false, false), mk('c', false, true)])).toEqual(['b']);
    expect(preferredIPv6([mk('a', true, false), mk('c', false, true)])).toEqual(['a']);
  });
});

describe('Windows Firewall helpers (mocked, never real)', () => {
  it('dry run only returns the command', async () => {
    const calls: string[][] = [];
    const r = await ensureFirewallRule(47821, { dryRun: true, runner: async (f, a) => { calls.push([f, ...a]); return ''; } });
    expect(calls).toEqual([]);
    expect(r.command).toBe('netsh advfirewall firewall add rule "name=SWARM Bridge" dir=in action=allow protocol=TCP localport=47821 profile=private,public,domain');
  });
  it('builds exact args and validates the port', () => {
    expect(buildAddRuleArgs(47821)).toContain('localport=47821');
    expect(() => buildAddRuleArgs(0)).toThrow();
    expect(() => buildAddRuleArgs(70000)).toThrow();
    expect(buildDeleteRuleArgs()).toEqual(['advfirewall', 'firewall', 'delete', 'rule', 'name=SWARM Bridge']);
  });
  it('ensure adds when missing, skips when present; reports failures', async () => {
    const calls: string[] = [];
    const missing = async (_f: string, a: string[]): Promise<string> => { calls.push(a[2]); if (a[2] === 'show') throw new Error('No rules match'); return 'Ok.'; };
    expect((await ensureFirewallRule(47821, { runner: missing })).ok).toBe(true);
    expect(calls).toEqual(['show', 'add']);
    const present = async (_f: string, a: string[]): Promise<string> => { calls.push('p' + a[2]); return 'LocalPort: 47821'; };
    calls.length = 0;
    expect((await ensureFirewallRule(47821, { runner: present })).command).toMatch(/already present/);
    expect(calls).toEqual(['pshow']);
    const denied = async (_f: string, a: string[]): Promise<string> => { if (a[2] === 'show') throw new Error('x'); throw new Error('requires elevation'); };
    const f = await ensureFirewallRule(47821, { runner: denied });
    expect(f.ok).toBe(false);
    expect(f.error).toMatch(/administrator/);
  });
  it('exists checks the port; remove dry-run does nothing', async () => {
    expect(await firewallRuleExists(47821, { runner: async () => 'LocalPort: 47821' })).toBe(true);
    expect(await firewallRuleExists(47821, { runner: async () => 'LocalPort: 5000' })).toBe(false);
    expect(await firewallRuleExists(undefined, { runner: async () => { throw new Error('none'); } })).toBe(false);
    const r = await removeFirewallRule({ dryRun: true, runner: async () => { throw new Error('must not run'); } });
    expect(r.dryRun).toBe(true);
  });
});

describe('reachability helpers', () => {
  it('connects to a local test listener and reports failures', async () => {
    const l = await startTestListener(0, '127.0.0.1');
    try {
      const ok = await selfTestPort({ host: '127.0.0.1', port: l.port, via: 'lan' });
      expect(ok.ok).toBe(true);
    } finally {
      await l.close();
    }
    const bad = await selfTestPort({ host: '127.0.0.1', port: l.port, timeoutMs: 500 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
  });
});