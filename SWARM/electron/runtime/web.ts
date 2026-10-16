// Web Runtime - Browser-based preview for web applications
import type { 
  IRuntime, 
  RuntimeInfo, 
  RuntimeArtifact, 
  RuntimeCapabilities,
  HealthCheck,
} from './types';
import { uid } from '../core/util';

export class WebRuntime implements IRuntime {
  readonly type = 'web' as const;
  
  private state: RuntimeInfo['state'] = 'not_started';
  private url: string | null = null;
  private devServerProcess: any = null; // Process handle from staticServer
  private startedAt: number | null = null;
  private error: string | null = null;
  
  constructor(
    readonly id: string,
    readonly projectId: string,
    readonly runId: string,
    private projectRoot: string,
  ) {}
  
  getInfo(): RuntimeInfo {
    return {
      id: this.id,
      type: this.type,
      state: this.state,
      projectId: this.projectId,
      runId: this.runId,
      url: this.url ?? undefined,
      startedAt: this.startedAt ?? undefined,
      error: this.error ?? undefined,
      supportsScreenshots: true,
      supportsInteraction: true,
      supportsReload: true,
    };
  }
  
  getCapabilities(): RuntimeCapabilities {
    return {
      canStart: this.state === 'not_started' || this.state === 'stopped',
      canStop: this.state === 'running',
      canRestart: this.state === 'running',
      canScreenshot: this.state === 'running',
      canInteract: this.state === 'running',
    };
  }
  
  async start(artifact: RuntimeArtifact): Promise<void> {
    if (this.state === 'running') return;
    
    this.state = 'starting';
    this.error = null;
    
    try {
      // Import static server dynamically
      const { serveStatic } = await import('../tools/staticServer');

      // Start static server for the project
      const result = await serveStatic(
        `web-runtime:${this.projectId}`,
        this.projectRoot,
      );

      if (result) {
        this.url = result.url;
        this.devServerProcess = result;
        this.state = 'running';
        this.startedAt = Date.now();
      } else {
        throw new Error('Failed to start dev server');
      }
    } catch (err) {
      this.state = 'failed';
      this.error = String(err);
      throw err;
    }
  }
  
  async stop(): Promise<void> {
    if (this.state === 'not_started' || this.state === 'stopped') return;
    
    this.state = 'stopping';
    
    try {
      const { stopStatic } = await import('../tools/staticServer');

      // Stop dev server if running
      if (this.devServerProcess) {
        stopStatic(`web-runtime:${this.projectId}`);
        this.devServerProcess = null;
      }

      this.state = 'stopped';
      this.url = null;
    } catch (err) {
      this.error = String(err);
      throw err;
    }
  }
  
  async restart(): Promise<void> {
    await this.stop();
    // Re-fetch artifact info if needed
    const artifact: RuntimeArtifact = {
      path: this.projectRoot,
      type: 'web',
    };
    await this.start(artifact);
  }
  
  async healthCheck(): Promise<HealthCheck> {
    if (this.state !== 'running' || !this.url) {
      return {
        healthy: false,
        message: 'Server not running',
        timestamp: Date.now(),
      };
    }
    
    try {
      // Simple check - try to fetch the URL
      const response = await fetch(this.url, { 
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      
      return {
        healthy: response.ok,
        message: response.ok ? 'Server responding' : `Server returned ${response.status}`,
        timestamp: Date.now(),
      };
    } catch (err) {
      return {
        healthy: false,
        message: String(err),
        timestamp: Date.now(),
      };
    }
  }
  
  getLogs(): { stdout: string; stderr: string } {
    // Web runtime logs are typically in the browser console
    // which is captured separately in the UI
    return {
      stdout: '',
      stderr: this.error ?? '',
    };
  }
  
  clearLogs(): void {
    this.error = null;
  }
  
  async dispose(): Promise<void> {
    await this.stop();
  }
}
