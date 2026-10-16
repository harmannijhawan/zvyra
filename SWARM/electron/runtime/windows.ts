// Windows Desktop Runtime - Launch and monitor Windows executables
import { artifactPath } from './paths';
import { killTree } from '../tools/process';
import { scrubbedEnv } from '../tools/policy';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { 
  IRuntime, 
  RuntimeType, 
  RuntimeInfo, 
  RuntimeArtifact,
  RuntimeCapabilities,
  RuntimeState,
  HealthCheck,
} from './types';

export class WindowsRuntime implements IRuntime {
  readonly type: RuntimeType = 'windows';
  
  private process: ChildProcess | null = null;
  private state: RuntimeState = 'not_started';
  private artifact: RuntimeArtifact | null = null;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private exitCode: number | null = null;
  private error: string | null = null;
  
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private readonly maxLogLines = 1000;
  
  constructor(
    readonly id: string,
    readonly projectId: string,
    readonly runId: string,
    private readonly projectRoot: string,
  ) {}
  
  getInfo(): RuntimeInfo {
    return {
      id: this.id,
      type: this.type,
      state: this.state,
      projectId: this.projectId,
      runId: this.runId,
      artifact: this.artifact?.path,
      artifactType: this.artifact?.type,
      pid: this.process?.pid,
      startedAt: this.startedAt ?? undefined,
      stoppedAt: this.stoppedAt ?? undefined,
      exitCode: this.exitCode ?? undefined,
      error: this.error ?? undefined,
      supportsScreenshots: this.state === 'running',
      supportsInteraction: true,
      supportsReload: true,
      stdout: this.stdoutBuffer,
      stderr: this.stderrBuffer,
    };
  }
  
  getCapabilities(): RuntimeCapabilities {
    // Check if we can run Windows executables
    if (process.platform !== 'win32') {
      return {
        canStart: false,
        canStop: false,
        canRestart: false,
        canScreenshot: false,
        canInteract: false,
        reason: 'Windows runtime only available on Windows',
      };
    }
    
    const canStart = this.state === 'not_started' || this.state === 'stopped' || this.state === 'crashed';
    const canStop = this.state === 'running' || this.state === 'starting';
    
    return {
      canStart,
      canStop,
      canRestart: !!this.artifact && !['starting', 'stopping'].includes(this.state),
      canScreenshot: this.state === 'running',
      canInteract: this.state === 'running',
    };
  }
  
  async start(artifact: RuntimeArtifact): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      throw new Error('Runtime already running');
    }
    
    if (process.platform !== 'win32') {
      this.state = 'unavailable';
      this.error = 'Windows runtime only available on Windows';
      throw new Error(this.error);
    }
    
    // Resolve artifact path
    const exePath = artifactPath(this.projectRoot, artifact.path);
    
    if (!existsSync(exePath)) {
      this.state = 'failed';
      this.error = `Executable not found: ${exePath}`;
      throw new Error(this.error);
    }
    
    this.artifact = artifact;
    this.state = 'starting';
    this.startedAt = Date.now();
    this.error = null;
    this.exitCode = null;
    
    try {
      // Spawn the Windows executable
      this.process = spawn(exePath, [], {
        cwd: this.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false, // Show the window
      });
      
      // Capture stdout
      this.process.stdout?.on('data', (data: Buffer) => {
        this.stdoutBuffer = (this.stdoutBuffer + data.toString()).slice(-200000);
      });
      
      // Capture stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        this.stderrBuffer = (this.stderrBuffer + data.toString()).slice(-200000);
      });
      
      // Handle process exit
      this.process.on('exit', (code, signal) => {
        this.exitCode = code;
        this.stoppedAt = Date.now();
        
        if (code !== 0 && code !== null) {
          this.state = 'crashed';
          this.error = `Process exited with code ${code}`;
        } else if (signal) {
          this.state = 'crashed';
          this.error = `Process killed by signal ${signal}`;
        } else {
          this.state = 'stopped';
        }
        
        this.process = null;
      });
      
      // Handle process errors
      this.process.on('error', (err) => {
        this.state = 'crashed';
        this.error = err.message;
        this.stoppedAt = Date.now();
        this.process = null;
      });
      
      // Resolve on the OS spawn event, without an arbitrary startup sleep.
      await new Promise<void>((resolve, reject) => { this.process!.once('spawn', resolve); this.process!.once('error', reject); });
      
      // Check if still running
      if (this.process && !this.process.killed) {
        this.state = 'running';
      } else {
        throw new Error(this.error || 'Process failed to start');
      }
      
    } catch (err) {
      this.state = 'failed';
      this.error = String(err);
      throw err;
    }
  }
  
  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.state = 'stopping';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { killTree(child.pid); }, 1500);
      const deadline = setTimeout(() => { cleanup(); reject(new Error('Process did not exit after termination')); }, 5000);
      const cleanup = () => { clearTimeout(timer); clearTimeout(deadline); child.removeListener('close', closed); };
      const closed = () => { cleanup(); resolve(); };
      child.once('close', closed);
      if (child.exitCode !== null || child.signalCode !== null) closed();
      else if (process.platform === 'win32') killTree(child.pid); else child.kill('SIGTERM');
    });
    this.state = 'stopped';
    this.stoppedAt = Date.now();
    this.process = null;
  }
  
  async restart(): Promise<void> {
    await this.stop();
    
    if (!this.artifact) {
      throw new Error('No artifact to restart');
    }
    

    
    await this.start(this.artifact);
  }
  
  async healthCheck(): Promise<HealthCheck> {
    // Check if process is still running
    if (!this.process || this.state !== 'running') {
      return {
        healthy: false,
        message: `Process not running (state: ${this.state})`,
        timestamp: Date.now(),
      };
    }
    
    // Check if process is responsive (has PID and hasn't exited)
    try {
      // Sending signal 0 checks if process exists without killing it
      process.kill(this.process.pid!, 0);
      
      return {
        healthy: true,
        timestamp: Date.now(),
      };
    } catch (err) {
      return {
        healthy: false,
        message: 'Process not responding',
        timestamp: Date.now(),
      };
    }
  }
  
  async screenshot(): Promise<string> {
    if (!this.process?.pid || this.state !== 'running') throw new Error('Desktop application is not running');
    const { nativeWindowsAction } = await import('../computer/windows');
    const observation = JSON.parse(await nativeWindowsAction({ action: 'observe', pid: this.process.pid }, new AbortController().signal));
    const { desktopCapturer } = await import('electron');
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1280, height: 800 } });
    const matches = sources.filter(s => s.name === observation.title);
    if (matches.length !== 1 || matches[0].thumbnail.isEmpty()) throw new Error('Application window cannot be uniquely captured; interact in the native window.');
    return matches[0].thumbnail.toDataURL();
  }
  getLogs(): { stdout: string; stderr: string } {
    return {
      stdout: this.stdoutBuffer,
      stderr: this.stderrBuffer,
    };
  }
  
  clearLogs(): void {
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
  }
  
  async dispose(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      await this.stop();
    }
    
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
  }
}
