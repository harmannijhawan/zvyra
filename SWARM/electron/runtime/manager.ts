// Runtime Manager - Lifecycle management for all runtime types
import { timeOperation } from '../core/performance';
import { EventEmitter } from 'node:events';
import type { PlatformType } from '../../shared/types';
import { emit } from '../core/bus';
import { uid } from '../core/util';
import type { 
  IRuntime, 
  RuntimeType, 
  RuntimeInfo, 
  RuntimeArtifact,
  RuntimeCapabilities,
  HealthCheck,
} from './types';
import { platformToRuntimeType } from './types';

class RuntimeManager extends EventEmitter {
  private runtimes = new Map<string, IRuntime>();
  private checkingHealth = new Set<string>();
  private healthCheckIntervals = new Map<string, NodeJS.Timeout>();
  
  /**
   * Create a runtime for the given project and platform
   */
  async createRuntime(
    projectId: string,
    runId: string,
    platform: PlatformType,
    projectRoot: string,
  ): Promise<IRuntime> {
    const existing = this.findByRunId(runId);
    if (existing) return existing;
    const type = platformToRuntimeType(platform);
    const id = uid('rt_');
    
    // Lazy load runtime implementation
    let runtime: IRuntime;
    
    try {
      switch (type) {
        case 'web': {
          const { WebRuntime } = await import('./web');
          runtime = new WebRuntime(id, projectId, runId, projectRoot);
          break;
        }
        case 'windows': {
          const { WindowsRuntime } = await import('./windows');
          runtime = new WindowsRuntime(id, projectId, runId, projectRoot);
          break;
        }
        case 'android': {
          const { AndroidRuntime } = await import('./android');
          runtime = new AndroidRuntime(id, projectId, runId, projectRoot);
          break;
        }
        case 'macos':
        case 'linux': {
          const { DesktopRuntime } = await import('./desktop');
          runtime = new DesktopRuntime(id, projectId, runId, projectRoot, type);
          break;
        }
        case 'ios': {
          const { UnavailableRuntime } = await import('./unavailable');
          runtime = new UnavailableRuntime(id, projectId, runId, type);
          break;
        }
        case 'cli': {
          const { CliRuntime } = await import('./cli');
          runtime = new CliRuntime(id, projectId, runId, projectRoot);
          break;
        }
        case 'api': {
          const { ApiRuntime } = await import('./api');
          runtime = new ApiRuntime(id, projectId, runId, projectRoot);
          break;
        }
        case 'library': {
          const { LibraryRuntime } = await import('./library');
          runtime = new LibraryRuntime(id, projectId, runId, projectRoot);
          break;
        }
        default:
          throw new Error(`Unsupported runtime type: ${type}`);
      }
      
      this.runtimes.set(id, runtime);
      
      emit('RUNTIME_CREATED', `${type} runtime created`, 
        { projectId, runId }, 'info', { runtimeId: id, type });
      
      return runtime;
    } catch (err) {
      emit('RUNTIME_FAILED', `Failed to create ${type} runtime: ${String(err)}`, 
        { projectId, runId }, 'error', { type });
      throw err;
    }
  }
  
  /**
   * Start a runtime with the given artifact
   */
  async startRuntime(
    runtimeId: string,
    artifact: RuntimeArtifact,
  ): Promise<void> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error(`Runtime ${runtimeId} not found`);
    
    const endTiming = timeOperation('preview', runtime.runId);
    try {
      emit('RUNTIME_STARTING', `Starting ${runtime.type} runtime`, 
        { projectId: runtime.projectId, runId: runtime.runId }, 'info', 
        { runtimeId, artifact: artifact.path });
      
      await runtime.start(artifact);
      
      // Start health monitoring
      this.startHealthMonitoring(runtimeId);
      
      emit('RUNTIME_STARTED', `${runtime.type} runtime started`, 
        { projectId: runtime.projectId, runId: runtime.runId }, 'success', 
        { runtimeId, info: runtime.getInfo() });
      
      this.emit('runtime:started', runtime.getInfo());
    } catch (err) {
      emit('RUNTIME_FAILED', `Failed to start runtime: ${String(err)}`, 
        { projectId: runtime.projectId, runId: runtime.runId }, 'error', 
        { runtimeId });
      throw err;
    } finally { endTiming(); }
  }
  
  /**
   * Stop a runtime
   */
  async stopRuntime(runtimeId: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) return;
    
    this.stopHealthMonitoring(runtimeId);
    
    try {
      await runtime.stop();
      
      emit('RUNTIME_STOPPED', `${runtime.type} runtime stopped`, 
        { projectId: runtime.projectId, runId: runtime.runId }, 'info', 
        { runtimeId });
      
      this.emit('runtime:stopped', runtime.getInfo());
    } catch (err) {
      emit('RUNTIME_ERROR', `Error stopping runtime: ${String(err)}`, 
        { projectId: runtime.projectId, runId: runtime.runId }, 'warning', 
        { runtimeId });
    }
  }
  
  /**
   * Restart a runtime
   */
  async restartRuntime(runtimeId: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error(`Runtime ${runtimeId} not found`);
    
    try {
      await runtime.restart();
      
      emit('RUNTIME_RESTARTED', `${runtime.type} runtime restarted`, 
        { projectId: runtime.projectId, runId: runtime.runId }, 'info', 
        { runtimeId });
      
      this.emit('runtime:restarted', runtime.getInfo());
    } catch (err) {
      emit('RUNTIME_ERROR', `Error restarting runtime: ${String(err)}`, 
        { projectId: runtime.projectId, runId: runtime.runId }, 'error', 
        { runtimeId });
      throw err;
    }
  }
  
  /**
   * Get runtime info
   */
  getRuntimeInfo(runtimeId: string): RuntimeInfo | null {
    const runtime = this.runtimes.get(runtimeId);
    return runtime ? runtime.getInfo() : null;
  }
  
  /**
   * Get runtime capabilities
   */
  getRuntimeCapabilities(runtimeId: string): RuntimeCapabilities | null {
    const runtime = this.runtimes.get(runtimeId);
    return runtime ? runtime.getCapabilities() : null;
  }
  
  /**
   * Take a screenshot if supported
   */
  async screenshot(runtimeId: string): Promise<string | null> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime?.screenshot) return null;
    
    try {
      return await runtime.screenshot();
    } catch (err) {
      emit('RUNTIME_ERROR', `Screenshot failed: ${String(err)}`, 
        { projectId: runtime.projectId, runId: runtime.runId }, 'warning', 
        { runtimeId });
      throw err;
    }
  }
  
  /**
   * Get runtime logs
   */
  async tap(runtimeId: string, x: number, y: number) {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime || !('tap' in runtime) || typeof runtime.tap !== 'function') throw new Error('Runtime does not support taps');
    await runtime.tap(x, y);
  }
  sendInput(runtimeId: string, input: string) {
    if (typeof input !== 'string' || input.length > 65536) throw new Error('Invalid terminal input');
    return this.runtimes.get(runtimeId)?.sendInput?.(input) ?? false;
  }
  clearLogs(runtimeId: string) { this.runtimes.get(runtimeId)?.clearLogs(); }
  getLogs(runtimeId: string): { stdout: string; stderr: string } | null {
    const runtime = this.runtimes.get(runtimeId);
    return runtime ? runtime.getLogs() : null;
  }
  
  /**
   * Find runtime by run ID
   */
  findByRunId(runId: string): IRuntime | null {
    for (const runtime of this.runtimes.values()) {
      if (runtime.runId === runId) return runtime;
    }
    return null;
  }
  
  /**
   * Get all active runtimes
   */
  getActiveRuntimes(): RuntimeInfo[] {
    return Array.from(this.runtimes.values())
      .map(r => r.getInfo())
      .filter(info => info.state === 'running' || info.state === 'starting');
  }
  
  /**
   * Dispose a runtime and clean up resources
   */
  async disposeRuntime(runtimeId: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) return;
    
    this.stopHealthMonitoring(runtimeId);
    
    try {
      await runtime.dispose();
    } catch (err) {
      console.error('[runtime] Dispose error:', err);
    }
    
    this.runtimes.delete(runtimeId);
    
    emit('RUNTIME_DISPOSED', `${runtime.type} runtime disposed`, 
      { projectId: runtime.projectId, runId: runtime.runId }, 'debug', 
      { runtimeId });
  }
  
  /**
   * Dispose all runtimes for a run
   */
  async disposeRun(runId: string): Promise<void> {
    const toDispose = Array.from(this.runtimes.entries())
      .filter(([, runtime]) => runtime.runId === runId)
      .map(([id]) => id);
    
    await Promise.all(toDispose.map(id => this.disposeRuntime(id)));
  }
  
  /**
   * Start health check monitoring for a runtime
   */
  private startHealthMonitoring(runtimeId: string): void {
    this.stopHealthMonitoring(runtimeId);
    
    const interval = setInterval(async () => {
      const runtime = this.runtimes.get(runtimeId);
      if (!runtime) {
        this.stopHealthMonitoring(runtimeId);
        return;
      }
      
      if (this.checkingHealth.has(runtimeId)) return;
      if (['stopped', 'crashed', 'failed', 'unavailable'].includes(runtime.getInfo().state)) { this.stopHealthMonitoring(runtimeId); return; }
      this.checkingHealth.add(runtimeId);
      try {
        const health = await runtime.healthCheck();
        
        if (!health.healthy) {
          emit('RUNTIME_UNHEALTHY', `${runtime.type} runtime unhealthy: ${health.message}`, 
            { projectId: runtime.projectId, runId: runtime.runId }, 'warning', 
            { runtimeId, health });
          
          this.emit('runtime:unhealthy', runtime.getInfo(), health);
        }
      } catch (err) {
        // Health check error - might be crashed
        const info = runtime.getInfo();
        if (info.state === 'running') {
          emit('RUNTIME_CRASHED', `${runtime.type} runtime appears crashed`, 
            { projectId: runtime.projectId, runId: runtime.runId }, 'error', 
            { runtimeId });
          
          this.emit('runtime:crashed', info);
        }
      }
      finally { this.checkingHealth.delete(runtimeId); }
    }, 10000); // Check every 10 seconds
    
    this.healthCheckIntervals.set(runtimeId, interval);
  }
  
  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(runtimeId: string): void {
    const interval = this.healthCheckIntervals.get(runtimeId);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(runtimeId);
    }
  }
  
  /**
   * Clean up all runtimes
   */
  async dispose(): Promise<void> {
    const runtimeIds = Array.from(this.runtimes.keys());
    await Promise.all(runtimeIds.map(id => this.disposeRuntime(id)));
  }
}

export const runtimeManager = new RuntimeManager();
runtimeManager.setMaxListeners(50);
