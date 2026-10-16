/**
 * One-time UAC-elevated Windows Firewall helpers for the bridge port.
 *
 * Nothing here runs automatically: call these from an explicit user action (e.g. an
 * "Allow connections from other networks" button). The elevated process is `netsh` only, with
 * arguments built from a validated integer port, so no user text reaches the command line.
 *
 * Wiring from IPC (main process):
 *   ipcMain.handle('remote:allow-other-networks', () => ensureFirewallRuleElevated(bridgePort));
 *   ipcMain.handle('remote:disallow-other-networks', () => removeFirewallRuleElevated(bridgePort));
 * Both resolve (never throw) with { ok, already?, denied?, error? }.
 */
import { defaultRunner, type CommandRunner } from './natpmp';
import { FIREWALL_RULE_NAME, firewallRuleExists } from './ipv6';

export interface ElevatedFirewallResult {
  ok: boolean;
  /** the rule was already in the requested state, nothing was changed */
  already?: boolean;
  /** the user dismissed the Windows permission prompt */
  denied?: boolean;
  error?: string;
}

export interface ElevatedFirewallOptions {
  /** runs a command and resolves with stdout; rejects (with stderr in the message) on failure. Injectable for tests. */
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  /** override the non-elevated rule check (tests) */
  exists?: (port: number) => Promise<boolean>;
  name?: string;
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${port}`);
}

/** netsh arguments (as the elevated process will see them) for adding the inbound allow rule. */
export function elevatedAddRuleArgs(port: number, name = FIREWALL_RULE_NAME): string[] {
  assertPort(port);
  return ['advfirewall', 'firewall', 'add', 'rule', `name="${name}"`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`, 'profile=private,public', 'remoteip=any'];
}

export function elevatedDeleteRuleArgs(port: number, name = FIREWALL_RULE_NAME): string[] {
  assertPort(port);
  return ['advfirewall', 'firewall', 'delete', 'rule', `name="${name}"`, 'protocol=TCP', `localport=${port}`];
}

/** PowerShell script that elevates netsh once via UAC. Port-derived args only. */
export function buildElevationScript(netshArgs: string[]): string {
  const list = netshArgs.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  return (
    `try { Start-Process -FilePath netsh -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction Stop -ArgumentList @(${list}) } ` +
    'catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }'
  );
}

export function isElevationDenied(message: string): boolean {
  return /cancel+ed by the user|1223|operation was canceled/i.test(message);
}

async function runElevated(netshArgs: string[], runner: CommandRunner): Promise<{ ok: boolean; denied?: boolean; error?: string }> {
  try {
    await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildElevationScript(netshArgs)], 120_000);
    return { ok: true };
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const msg = `${err.message} ${err.stderr ?? ''}`;
    if (isElevationDenied(msg)) return { ok: false, denied: true, error: 'Permission to allow connections from other networks was not granted.' };
    return { ok: false, error: `Could not change the firewall setting: ${err.message.split('\n')[0]}` };
  }
}

/** Add the inbound allow rule for `port` (one UAC prompt). Idempotent; never throws. */
export async function ensureFirewallRuleElevated(port: number, opts: ElevatedFirewallOptions = {}): Promise<ElevatedFirewallResult> {
  try {
    assertPort(port);
    if ((opts.platform ?? process.platform) !== 'win32') return { ok: false, error: 'Only available on Windows.' };
    const runner = opts.runner ?? defaultRunner;
    const exists = opts.exists ?? ((p: number) => firewallRuleExists(p, { runner, name: opts.name }));
    if (await exists(port)) return { ok: true, already: true };
    const r = await runElevated(elevatedAddRuleArgs(port, opts.name), runner);
    if (!r.ok) return r;
    if (await exists(port)) return { ok: true };
    return { ok: false, error: 'The firewall setting could not be confirmed after the change (administrator rights may be required).' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Remove the rule for `port` (one UAC prompt). Idempotent; never throws. */
export async function removeFirewallRuleElevated(port: number, opts: ElevatedFirewallOptions = {}): Promise<ElevatedFirewallResult> {
  try {
    assertPort(port);
    if ((opts.platform ?? process.platform) !== 'win32') return { ok: false, error: 'Only available on Windows.' };
    const runner = opts.runner ?? defaultRunner;
    const exists = opts.exists ?? ((p: number) => firewallRuleExists(p, { runner, name: opts.name }));
    if (!(await exists(port))) return { ok: true, already: true };
    const r = await runElevated(elevatedDeleteRuleArgs(port, opts.name), runner);
    if (!r.ok) return r;
    if (!(await exists(port))) return { ok: true };
    return { ok: false, error: 'The firewall setting could not be confirmed after the change (administrator rights may be required).' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}