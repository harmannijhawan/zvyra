// Android preview always targets a real authorized device and application process.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { androidTool, artifactPath } from './paths';
import type { IRuntime, RuntimeType, RuntimeState, RuntimeArtifact, RuntimeInfo, RuntimeCapabilities, HealthCheck } from './types';
const execute = promisify(execFile);
export class AndroidRuntime implements IRuntime {
  readonly type: RuntimeType = 'android';
  private state: RuntimeState = 'not_started';
  private artifact: RuntimeArtifact | null = null;
  private deviceId: string | null = null;
  private packageName: string | null = null;
  private startedAt: number | null = null;
  private error: string | null = null;
  private logcat: ChildProcess | null = null;
  private stdout = '';
  private stderr = '';
  constructor(readonly id: string, readonly projectId: string, readonly runId: string, private readonly projectRoot: string) {}
  getInfo(): RuntimeInfo {
    return { id: this.id, type: this.type, state: this.state, projectId: this.projectId, runId: this.runId,
      artifact: this.artifact?.path, artifactType: this.artifact?.type, startedAt: this.startedAt ?? undefined,
      error: this.error ?? undefined, supportsScreenshots: this.state === 'running', supportsInteraction: this.state === 'running', supportsReload: true,
      stdout: this.stdout, stderr: this.stderr };
  }
  getCapabilities(): RuntimeCapabilities {
    return { canStart: !['running', 'starting', 'stopping'].includes(this.state), canStop: this.state === 'running',
      canRestart: !!this.artifact, canScreenshot: this.state === 'running', canInteract: this.state === 'running' };
  }
  private async adb(args: string[], timeout = 15000): Promise<string> {
    const result = await execute(androidTool('adb'), args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
    if (result.stderr) this.stderr = (this.stderr + result.stderr).slice(-200000);
    return result.stdout.trim();
  }
  private deviceArgs(...args: string[]) {
    if (!this.deviceId) throw new Error('No Android device');
    return ['-s', this.deviceId, ...args];
  }
  async start(artifact: RuntimeArtifact): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') throw new Error('Runtime already running');
    const apk = artifactPath(this.projectRoot, artifact.path);
    this.artifact = artifact; this.state = 'starting'; this.error = null;
    try {
      const output = await this.adb(['devices']);
      const devices = output.split(/\r?\n/).map(line => line.trim().match(/^(\S+)\s+device$/)?.[1]).filter((id): id is string => !!id);
      if (devices.length !== 1) { this.state = 'unavailable'; throw new Error(devices.length ? 'Multiple Android devices connected; connect one device for controlled preview.' : 'No authorized Android emulator/device connected. Start an emulator or authorize a USB device.'); }
      this.deviceId = devices[0];
      const { stdout } = await execute(androidTool('aapt'), ['dump', 'badging', apk], { timeout: 15000, windowsHide: true });
      this.packageName = stdout.match(/package: name='([^']+)'/)?.[1] ?? null;
      if (!this.packageName || !/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(this.packageName)) throw new Error('Could not read a valid application package from APK (aapt required).');
      const installed = await this.adb(this.deviceArgs('install', '-r', apk), 120000);
      this.stdout = (this.stdout + installed + '\n').slice(-200000);
      if (!installed.includes('Success')) throw new Error('APK installation failed: ' + installed);
      await this.adb(this.deviceArgs('shell', 'monkey', '-p', this.packageName, '-c', 'android.intent.category.LAUNCHER', '1'));
      let pid = '';
      for (let i = 0; i < 10 && !pid; i++) {
        pid = await this.adb(this.deviceArgs('shell', 'pidof', '-s', this.packageName)).catch(() => '');
        if (!pid) await new Promise(r => setTimeout(r, 200));
      }
      if (!/^\d+$/.test(pid)) throw new Error('Application did not remain running after launch');
      this.stopLogcat();
      this.logcat = spawn(androidTool('adb'), this.deviceArgs('logcat', '-v', 'time', '--pid', pid), { windowsHide: true });
      this.logcat.stdout?.on('data', d => { this.stdout = (this.stdout + d.toString()).slice(-200000); });
      this.logcat.stderr?.on('data', d => { this.stderr = (this.stderr + d.toString()).slice(-200000); });
      this.logcat.on('error', e => { this.stderr = (this.stderr + e.message).slice(-200000); });
      this.state = 'running'; this.startedAt = Date.now();
    } catch (e) {
      if (this.state !== 'unavailable') this.state = 'failed';
      this.error = String(e); this.stopLogcat(); throw e;
    }
  }
  async stop() {
    if (this.packageName && this.deviceId) await this.adb(this.deviceArgs('shell', 'am', 'force-stop', this.packageName));
    this.stopLogcat(); this.state = 'stopped';
  }
  async restart() { await this.stop(); if (!this.artifact) throw new Error('No APK to restart'); await this.start(this.artifact); }
  async healthCheck(): Promise<HealthCheck> {
    const pid = this.packageName && this.state === 'running' ? await this.adb(this.deviceArgs('shell', 'pidof', '-s', this.packageName)).catch(() => '') : '';
    const healthy = /^\d+$/.test(pid);
    if (!healthy && this.state === 'running') { this.state = 'crashed'; this.stopLogcat(); }
    return { healthy, message: healthy ? undefined : this.error ?? 'Application is not running', timestamp: Date.now() };
  }
  async screenshot(): Promise<string> {
    if (this.state !== 'running') throw new Error('Android app is not running');
    const result = await execute(androidTool('adb'), this.deviceArgs('exec-out', 'screencap', '-p'), { encoding: 'buffer', timeout: 15000, windowsHide: true, maxBuffer: 12 * 1024 * 1024 });
    if (!result.stdout.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Device returned an invalid PNG screenshot');
    return 'data:image/png;base64,' + result.stdout.toString('base64');
  }
  async tap(x: number, y: number) {
    if (this.state !== 'running' || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 10000 || y > 10000) throw new Error('Invalid Android tap');
    await this.adb(this.deviceArgs('shell', 'input', 'tap', String(x), String(y)));
  }
  getLogs() { return { stdout: this.stdout, stderr: this.stderr }; }
  clearLogs() { this.stdout = ''; this.stderr = ''; }
  private stopLogcat() { this.logcat?.kill(); this.logcat = null; }
  async dispose() { await this.stop(); this.clearLogs(); }
}
