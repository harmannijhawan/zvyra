import { describe, expect, it } from 'vitest';
import {
  ensureFirewallRuleElevated, removeFirewallRuleElevated, elevatedAddRuleArgs, elevatedDeleteRuleArgs, buildElevationScript, isElevationDenied,
} from '../../electron/remote/connectivity/firewall';

/** Fake machine: tracks whether the rule exists; "elevated" calls go through powershell.exe. */
function fakeMachine(opts: { present?: boolean; deny?: boolean; fail?: string; noEffect?: boolean } = {}) {
  let present = opts.present ?? false;
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner = async (file: string, args: string[]): Promise<string> => {
    calls.push({ file, args });
    if (file === 'netsh') {
      if (args[2] === 'show') { if (!present) throw new Error('No rules match the specified criteria.'); return 'Rule Name: SWARM Bridge\nLocalPort: 47821\n'; }
      throw new Error('real netsh mutation must never run in tests');
    }
    if (file === 'powershell.exe') {
      const script = args[args.length - 1];
      if (opts.deny) throw new Error('Command failed: The operation was canceled by the user.');
      if (opts.fail) throw new Error(opts.fail);
      if (!opts.noEffect) present = script.includes("'add'");
      return '';
    }
    throw new Error(`unexpected ${file}`);
  };
  return { runner, calls, isPresent: () => present };
}

describe('elevated firewall helpers (fully mocked)', () => {
  it('builds the expected netsh arguments', () => {
    expect(elevatedAddRuleArgs(47821).join(' ')).toBe('advfirewall firewall add rule name="SWARM Bridge" dir=in action=allow protocol=TCP localport=47821 profile=private,public remoteip=any');
    expect(elevatedDeleteRuleArgs(47821).join(' ')).toBe('advfirewall firewall delete rule name="SWARM Bridge" protocol=TCP localport=47821');
    expect(() => elevatedAddRuleArgs(0)).toThrow();
    expect(() => elevatedAddRuleArgs(1.5)).toThrow();
  });
  it('script uses Start-Process -Verb RunAs -Wait and quotes args', () => {
    const s = buildElevationScript(elevatedAddRuleArgs(47821));
    expect(s).toContain('Start-Process -FilePath netsh -Verb RunAs -Wait');
    expect(s).toContain(`'name="SWARM Bridge"'`);
    expect(s).toContain("'localport=47821'");
  });
  it('detects UAC denial messages', () => {
    expect(isElevationDenied('The operation was canceled by the user.')).toBe(true);
    expect(isElevationDenied('Access is denied')).toBe(false);
  });

  it('returns already:true without elevating when the rule exists', async () => {
    const m = fakeMachine({ present: true });
    expect(await ensureFirewallRuleElevated(47821, { runner: m.runner, platform: 'win32' })).toEqual({ ok: true, already: true });
    expect(m.calls.some((c) => c.file === 'powershell.exe')).toBe(false);
  });
  it('elevates once, then re-checks', async () => {
    const m = fakeMachine();
    expect(await ensureFirewallRuleElevated(47821, { runner: m.runner, platform: 'win32' })).toEqual({ ok: true });
    expect(m.calls.filter((c) => c.file === 'powershell.exe').length).toBe(1);
    expect(m.isPresent()).toBe(true);
  });
  it('reports denial when the UAC prompt is cancelled', async () => {
    const m = fakeMachine({ deny: true });
    const r = await ensureFirewallRuleElevated(47821, { runner: m.runner, platform: 'win32' });
    expect(r.ok).toBe(false);
    expect(r.denied).toBe(true);
    expect(r.error).not.toMatch(/ISP|CGNAT/i);
  });
  it('reports other failures and unconfirmed changes without throwing', async () => {
    expect((await ensureFirewallRuleElevated(47821, { runner: fakeMachine({ fail: 'boom' }).runner, platform: 'win32' })).error).toMatch(/boom/);
    const r = await ensureFirewallRuleElevated(47821, { runner: fakeMachine({ noEffect: true }).runner, platform: 'win32' });
    expect(r.ok).toBe(false);
    expect(r.denied).toBeUndefined();
    expect((await ensureFirewallRuleElevated(-1, { runner: fakeMachine().runner, platform: 'win32' })).ok).toBe(false);
  });
  it('is Windows-only', async () => {
    const m = fakeMachine();
    expect((await ensureFirewallRuleElevated(47821, { runner: m.runner, platform: 'linux' })).ok).toBe(false);
    expect(m.calls).toEqual([]);
  });
  it('removal: already absent, success, denial', async () => {
    expect(await removeFirewallRuleElevated(47821, { runner: fakeMachine().runner, platform: 'win32' })).toEqual({ ok: true, already: true });
    const m = fakeMachine({ present: true });
    expect(await removeFirewallRuleElevated(47821, { runner: m.runner, platform: 'win32' })).toEqual({ ok: true });
    expect(m.isPresent()).toBe(false);
    const d = await removeFirewallRuleElevated(47821, { runner: fakeMachine({ present: true, deny: true }).runner, platform: 'win32' });
    expect(d).toMatchObject({ ok: false, denied: true });
  });
});