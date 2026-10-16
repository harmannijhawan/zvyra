/**
 * Global-unicast IPv6 enumeration and (explicit, never automatic) Windows Firewall helpers.
 */
import os from 'node:os';
import { defaultRunner, type CommandRunner } from './natpmp';

export interface Ipv6Address {
  address: string;
  interface: string;
  /** SLAAC privacy/temporary address (rotates, poor for a QR code) */
  temporary: boolean;
  /** deprecated (preferred lifetime expired) addresses should not be advertised */
  deprecated: boolean;
}

function firstGroup(addr: string): number | null {
  const a = addr.split('%')[0].toLowerCase();
  if (a.startsWith('::')) return 0;
  const g = a.split(':')[0];
  if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  return parseInt(g, 16);
}

/** True for global unicast 2000::/3, excluding tunnel transition prefixes (6to4 2002::/16, Teredo 2001:0::/32). */
export function isGlobalUnicastV6(addr: string): boolean {
  const a = addr.split('%')[0].toLowerCase();
  const g = firstGroup(a);
  if (g === null || g < 0x2000 || g > 0x3fff) return false;
  if (g === 0x2002) return false;
  if (/^2001:0{0,4}:/.test(a)) return false; // Teredo 2001::/32
  return true;
}

/** Filter + shape the output of os.networkInterfaces(). */
export function fromOsInterfaces(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): Ipv6Address[] {
  const out: Ipv6Address[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv6' || i.internal) continue;
      if (!isGlobalUnicastV6(i.address)) continue;
      out.push({ address: i.address.split('%')[0].toLowerCase(), interface: name, temporary: false, deprecated: false });
    }
  }
  return out;
}

interface NetIpRow {
  IPAddress?: string;
  InterfaceAlias?: string;
  PrefixOrigin?: number | string;
  SuffixOrigin?: number | string;
  AddressState?: number | string;
}

/** Parse `Get-NetIPAddress -AddressFamily IPv6 | ConvertTo-Json` output (object or array; numeric or string enums). */
export function parseNetIpAddressJson(json: string): Ipv6Address[] {
  const text = json.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as NetIpRow | NetIpRow[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: Ipv6Address[] = [];
  for (const r of rows) {
    if (!r.IPAddress || !isGlobalUnicastV6(r.IPAddress)) continue;
    // SuffixOrigin enum: Other=0 Manual=1 WellKnown=2 DHCP=3 Link=4 Random=5 ; AddressState: Deprecated=3, Preferred=4
    const suffix = String(r.SuffixOrigin ?? '').toLowerCase();
    const state = String(r.AddressState ?? '').toLowerCase();
    out.push({
      address: r.IPAddress.split('%')[0].toLowerCase(),
      interface: r.InterfaceAlias ?? '',
      temporary: suffix === 'random' || suffix === '5' || suffix === 'temporary',
      deprecated: state === 'deprecated' || state === '3',
    });
  }
  return out;
}

export const NET_IP_COMMAND =
  'Get-NetIPAddress -AddressFamily IPv6 | Select-Object IPAddress,InterfaceAlias,PrefixOrigin,SuffixOrigin,AddressState | ConvertTo-Json -Compress';

/**
 * List global IPv6 addresses. On Windows, PowerShell is used to learn temporary/deprecated flags;
 * on failure (or elsewhere) the os API result is used.
 */
export async function listGlobalIPv6(opts: { runner?: CommandRunner; platform?: NodeJS.Platform; ifaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]> } = {}): Promise<Ipv6Address[]> {
  const base = fromOsInterfaces(opts.ifaces);
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32' || base.length === 0) return base;
  try {
    const out = await (opts.runner ?? defaultRunner)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', NET_IP_COMMAND], 10000);
    const detailed = parseNetIpAddressJson(out);
    const flags = new Map(detailed.map((d) => [d.address, d]));
    return base.map((b) => {
      const d = flags.get(b.address);
      return d ? { ...b, temporary: d.temporary, deprecated: d.deprecated } : b;
    });
  } catch {
    return base;
  }
}

/**
 * Addresses worth advertising: stable ones first; deprecated are dropped; temporary only when
 * no stable address exists.
 */
export function preferredIPv6(list: Ipv6Address[]): string[] {
  const live = list.filter((a) => !a.deprecated);
  const stable = live.filter((a) => !a.temporary);
  const chosen = stable.length > 0 ? stable : live;
  return [...new Set(chosen.map((a) => a.address))];
}

// ---------- Windows Firewall (NOT called automatically) ----------

export const FIREWALL_RULE_NAME = 'SWARM Bridge';

export function buildAddRuleArgs(port: number, name = FIREWALL_RULE_NAME, profile = 'private,public,domain'): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${port}`);
  return ['advfirewall', 'firewall', 'add', 'rule', `name=${name}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`, `profile=${profile}`];
}

export function buildShowRuleArgs(name = FIREWALL_RULE_NAME): string[] {
  return ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`];
}

export function buildDeleteRuleArgs(name = FIREWALL_RULE_NAME): string[] {
  return ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`];
}

export interface FirewallOptions {
  runner?: CommandRunner;
  name?: string;
  /** when true the netsh command is NOT executed; the command line is only returned */
  dryRun?: boolean;
}

export interface FirewallResult {
  ok: boolean;
  command: string;
  dryRun: boolean;
  error?: string;
}

const cmdLine = (args: string[]): string => `netsh ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;

/** Is there an inbound rule with this name (and, when `port` is given, mentioning that local port)? Read-only, no admin needed. */
export async function firewallRuleExists(port?: number, opts: FirewallOptions = {}): Promise<boolean> {
  const run = opts.runner ?? defaultRunner;
  try {
    const out = await run('netsh', buildShowRuleArgs(opts.name));
    if (port === undefined) return true;
    return new RegExp(`(^|[^0-9])${port}([^0-9]|$)`).test(out);
  } catch {
    return false; // netsh exits 1 when no rule matches
  }
}

/**
 * Add the inbound allow rule. Requires an elevated process and the user's consent: call this only
 * from an explicit user action. It is never invoked by ConnectivityManager.
 */
export async function ensureFirewallRule(port: number, opts: FirewallOptions = {}): Promise<FirewallResult> {
  const args = buildAddRuleArgs(port, opts.name);
  const command = cmdLine(args);
  if (opts.dryRun) return { ok: true, command, dryRun: true };
  if (await firewallRuleExists(port, opts)) return { ok: true, command: '(rule already present)', dryRun: false };
  try {
    await (opts.runner ?? defaultRunner)('netsh', args);
    return { ok: true, command, dryRun: false };
  } catch (e) {
    return { ok: false, command, dryRun: false, error: `netsh failed (administrator rights required?): ${(e as Error).message}` };
  }
}

export async function removeFirewallRule(opts: FirewallOptions = {}): Promise<FirewallResult> {
  const args = buildDeleteRuleArgs(opts.name);
  const command = cmdLine(args);
  if (opts.dryRun) return { ok: true, command, dryRun: true };
  try {
    await (opts.runner ?? defaultRunner)('netsh', args);
    return { ok: true, command, dryRun: false };
  } catch (e) {
    return { ok: false, command, dryRun: false, error: `netsh failed (rule missing or administrator rights required): ${(e as Error).message}` };
  }
}