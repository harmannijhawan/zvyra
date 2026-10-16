import type { IRuntime, RuntimeArtifact, RuntimeInfo, RuntimeType } from './types';

export class UnavailableRuntime implements IRuntime {
  constructor(readonly id: string, readonly projectId: string, readonly runId: string, readonly type: RuntimeType) {}
  getInfo(): RuntimeInfo { return { id: this.id, projectId: this.projectId, runId: this.runId, type: this.type, state: 'unavailable', error: 'iOS preview requires a macOS host with Xcode and Simulator; no Android substitution is performed.', supportsScreenshots: false, supportsInteraction: false, supportsReload: false }; }
  getCapabilities() { return { canStart: false, canStop: false, canRestart: false, canScreenshot: false, canInteract: false, reason: this.getInfo().error }; }
  async start(_artifact: RuntimeArtifact): Promise<void> { throw new Error(this.getInfo().error); }
  async stop() {}
  async restart(): Promise<void> { throw new Error(this.getInfo().error); }
  async healthCheck() { return { healthy: false, message: this.getInfo().error, timestamp: Date.now() }; }
  getLogs() { return { stdout: '', stderr: this.getInfo().error! }; }
  clearLogs() {}
  async dispose() {}
}
