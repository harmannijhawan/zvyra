// CLI Runtime - Launch command-line applications with interactive terminal
import { artifactPath } from './paths';
import { killTree } from '../tools/process';
import { scrubbedEnv } from '../tools/policy';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, chmodSync, constants } from 'node:fs';
import type { 
  IRuntime, 
  RuntimeType, 
  RuntimeInfo, 
  RuntimeArtifact,
  RuntimeCapabilities,
  RuntimeState,
  HealthCheck,
} from './types';

export class CliRuntime implements IRuntime {
  readonly type: RuntimeType = 'cli';
  
  private process: ChildProcess | null = null;
  private state: RuntimeState = 'not_started';
  private artifact: RuntimeArtifact | null = null;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private exitCode: number | null = null;
  private error: string | null = null;
  
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private readonly maxLogLines = 2000;
  
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
      supportsScreenshots: false,
      supportsInteraction: true, // Can send stdin
      supportsReload: true,
      stdout: this.stdoutBuffer,
      stderr: this.stderrBuffer,
    };
  }
  
  getCapabilities(): RuntimeCapabilities {
    const canStart = this.state === 'not_started' || this.state === 'stopped' || this.state === 'crashed';
    const canStop = this.state === 'running' || this.state === 'starting';
    
    return {
      canStart,
      canStop,
      canRestart: !!this.artifact && !['starting', 'stopping'].includes(this.state),
      canScreenshot: false,
      canInteract: this.state === 'running',
    };
  }
  
  async start(artifact: RuntimeArtifact): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      throw new Error('Runtime already running');
    }
    
    // Resolve artifact path
    const binaryPath = artifactPath(this.projectRoot, artifact.path);
    
    if (!existsSync(binaryPath)) {
      this.state = 'failed';
      this.error = `Binary not found: ${binaryPath}`;
      throw new Error(this.error);
    }
    
    this.artifact = artifact;
    this.state = 'starting';
    this.startedAt = Date.now();
    this.error = null;
    this.exitCode = null;
    
    try {
      // Make executable on Unix-like systems
      if (process.platform !== 'win32') {
        try {
          chmodSync(binaryPath, constants.S_IRWXU | constants.S_IRGRP | constants.S_IXGRP | constants.S_IROTH | constants.S_IXOTH);
        } catch (err) {
          console.warn('[cli-runtime] Could not chmod binary:', err);
        }
      }
      
      // Determine how to execute
      let command: string;
      let args: string[];
      
      if (binaryPath.endsWith('.py')) {
        command = 'python';
        args = [binaryPath];
      } else if (/\.(?:cjs|mjs|js)$/i.test(binaryPath)) {
        command = 'node';
        args = [binaryPath];
      } else if (binaryPath.endsWith('.sh')) {
        command = 'bash';
        args = [binaryPath];
      } else if (binaryPath.endsWith('.bat') || binaryPath.endsWith('.cmd')) {
        command = 'cmd';
        args = ['/c', binaryPath];
      } else {
        // Assume it's an executable binary
        command = binaryPath;
        args = [];
      }
      
      // Spawn with PTY-like behavior for interactive CLI apps
      this.process = spawn(command, args, {
        cwd: this.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...scrubbedEnv(true),
          TERM: 'xterm-256color',
          FORCE_COLOR: '1',
        },
      });
      
      // Capture stdout
      this.process.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        this.appendLog('stdout', text);
      });
      
      // Capture stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        this.appendLog('stderr', text);
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
    
    // Check if process is responsive
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
  
  /**
   * Send input to the CLI (like typing in terminal)
   */
  sendInput(input: string): boolean {
    if (!this.process || !this.process.stdin || this.state !== 'running') {
      return false;
    }
    
    try {
      this.process.stdin.write(input);
      return true;
    } catch {
      return false;
    }
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
  
  // Private helpers
  
  private appendLog(type: 'stdout' | 'stderr', text: string): void {
    if (type === 'stdout') this.stdoutBuffer = (this.stdoutBuffer + text).slice(-200000);
    else this.stderrBuffer = (this.stderrBuffer + text).slice(-200000);
  }
}
