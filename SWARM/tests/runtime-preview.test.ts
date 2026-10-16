import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliRuntime } from '../electron/runtime/cli';
import { artifactPath } from '../electron/runtime/paths';
import { platformToRuntimeType, detectRuntimeType } from '../electron/runtime/types';

it('runs a real CLI, accepts stdin, captures both streams, stops and restarts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-cli-'));
  fs.writeFileSync(path.join(root, 'app.cjs'), "process.stdout.write('Name: '); process.stdin.on('data', d => {process.stdout.write('Hello ' + d); process.stderr.write('diagnostic\\n');});");
  const runtime = new CliRuntime('cli', 'p', 'r', root);
  try {
    await runtime.start({ path: 'app.cjs', type: 'binary' });
    expect(runtime.sendInput('Alice\n')).toBe(true);
    const wait = async (fn: () => boolean) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise(r => setTimeout(r, 20)); expect(fn()).toBe(true); };
    await wait(() => runtime.getLogs().stdout.includes('Hello Alice') && runtime.getLogs().stderr.includes('diagnostic'));
    expect(runtime.getLogs().stderr).toContain('diagnostic');
    const pid = runtime.getInfo().pid;
    await runtime.stop();
    expect(runtime.getInfo().state).toBe('stopped');
    expect(() => process.kill(pid!, 0)).toThrow();
    await runtime.restart();
    expect(runtime.getInfo().pid).not.toBe(pid);
    runtime.clearLogs();
    expect(runtime.getLogs()).toEqual({ stdout: '', stderr: '' });
  } finally { await runtime.dispose(); }
});
it('does not substitute another platform or mistake a CLI script for a website', () => {
  expect(platformToRuntimeType('ios')).toBe('ios');
  expect(platformToRuntimeType('macos')).toBe('macos');
  expect(platformToRuntimeType('linux')).toBe('linux');
  expect(detectRuntimeType('app.apk')).toBe('android');
  expect(detectRuntimeType('app.cjs')).toBe('cli');
  expect(detectRuntimeType('index.html')).toBe('web');
});
it('rejects artifacts outside the project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-scope-'));
  expect(() => artifactPath(root, '../')).toThrow(/outside/);
});
