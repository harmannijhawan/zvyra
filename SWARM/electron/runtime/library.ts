// Library Runtime - Run tests and show results for library projects
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { 
  IRuntime, 
  RuntimeType, 
  RuntimeInfo, 
  RuntimeArtifact,
  RuntimeCapabilities,
  RuntimeState,
  HealthCheck,
} from './types';

export class LibraryRuntime implements IRuntime {
  readonly type: RuntimeType = 'library';
  
  private process: ChildProcess | null = null;
  private state: RuntimeState = 'not_started';
  private artifact: RuntimeArtifact | null = null;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private exitCode: number | null = null;
  private error: string | null = null;
  
  private stdoutBuffer: string[] = [];
  private stderrBuffer: string[] = [];
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
      supportsInteraction: false,
      supportsReload: true,
      stdout: this.stdoutBuffer.slice(-100).join('\n'),
      stderr: this.stderrBuffer.slice(-100).join('\n'),
    };
  }
  
  getCapabilities(): RuntimeCapabilities {
    const canStart = this.state === 'not_started' || this.state === 'stopped' || this.state === 'crashed';
    const canStop = this.state === 'running' || this.state === 'starting';
    
    return {
      canStart,
      canStop,
      canRestart: this.state === 'stopped' || this.state === 'crashed',
      canScreenshot: false,
      canInteract: false,
    };
  }
  
  async start(artifact: RuntimeArtifact): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      throw new Error('Runtime already running');
    }
    
    this.artifact = artifact;
    this.state = 'starting';
    this.startedAt = Date.now();
    this.error = null;
    this.exitCode = null;
    
    try {
      // Detect test command from project
      const { command, args } = this.detectTestCommand();
      
      // Spawn the test process
      this.process = spawn(command, args, {
        cwd: this.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          CI: 'false', // Disable CI-specific behavior
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
        
        if (code === 0) {
          this.state = 'stopped';
          this.appendLog('stdout', '\n✓ All tests passed');
        } else if (code !== null) {
          this.state = 'crashed';
          this.error = `Tests failed with exit code ${code}`;
          this.appendLog('stderr', `\n✗ Tests failed (exit code ${code})`);
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
      
      this.state = 'running';
      
    } catch (err) {
      this.state = 'failed';
      this.error = String(err);
      
      if (this.process) {
        this.process.kill();
        this.process = null;
      }
      
      throw err;
    }
  }
  
  async stop(): Promise<void> {
    if (!this.process || this.state === 'stopped' || this.state === 'stopping') {
      return;
    }
    
    this.state = 'stopping';
    
    try {
      // Kill test process
      this.process.kill('SIGTERM');
      
      const timeout = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 3000);
      
      await new Promise<void>((resolve) => {
        if (!this.process) {
          resolve();
          return;
        }
        
        const onExit = () => {
          clearTimeout(timeout);
          resolve();
        };
        
        this.process.once('exit', onExit);
        
        if (this.process.killed) {
          this.process.removeListener('exit', onExit);
          clearTimeout(timeout);
          resolve();
        }
      });
      
      this.state = 'stopped';
      this.stoppedAt = Date.now();
      this.process = null;
      
    } catch (err) {
      this.error = String(err);
      throw err;
    }
  }
  
  async restart(): Promise<void> {
    // For tests, we want to wait for completion before restarting
    if (this.state === 'running') {
      await this.stop();
    }
    
    if (!this.artifact) {
      throw new Error('No artifact to restart');
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
    await this.start(this.artifact);
  }
  
  async healthCheck(): Promise<HealthCheck> {
    // For libraries, "healthy" means tests are running or completed successfully
    if (this.state === 'stopped' && this.exitCode === 0) {
      return {
        healthy: true,
        message: 'Tests completed successfully',
        timestamp: Date.now(),
      };
    }
    
    if (this.state === 'running' && this.process) {
      try {
        process.kill(this.process.pid!, 0);
        return {
          healthy: true,
          message: 'Tests running',
          timestamp: Date.now(),
        };
      } catch {
        return {
          healthy: false,
          message: 'Test process not responding',
          timestamp: Date.now(),
        };
      }
    }
    
    if (this.state === 'crashed') {
      return {
        healthy: false,
        message: this.error || 'Tests failed',
        timestamp: Date.now(),
      };
    }
    
    return {
      healthy: false,
      message: `Unexpected state: ${this.state}`,
      timestamp: Date.now(),
    };
  }
  
  getLogs(): { stdout: string; stderr: string } {
    return {
      stdout: this.stdoutBuffer.join(''),
      stderr: this.stderrBuffer.join(''),
    };
  }
  
  clearLogs(): void {
    this.stdoutBuffer = [];
    this.stderrBuffer = [];
  }
  
  async dispose(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      await this.stop();
    }
    
    this.stdoutBuffer = [];
    this.stderrBuffer = [];
  }
  
  // Private helpers
  
  private detectTestCommand(): { command: string; args: string[] } {
    // Check package.json for test script
    const packageJsonPath = join(this.projectRoot, 'package.json');
    
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        
        if (packageJson.scripts?.test) {
          // Use npm test
          return { command: 'npm', args: ['test'] };
        }
        
        // Check for specific test frameworks
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        
        if (deps.vitest) {
          return { command: 'npx', args: ['vitest', 'run'] };
        }
        
        if (deps.jest) {
          return { command: 'npx', args: ['jest'] };
        }
        
        if (deps.mocha) {
          return { command: 'npx', args: ['mocha'] };
        }
        
        if (deps.ava) {
          return { command: 'npx', args: ['ava'] };
        }
      } catch (err) {
        console.warn('[library-runtime] Could not parse package.json:', err);
      }
    }
    
    // Check for Python test files
    const pytestPath = join(this.projectRoot, 'pytest.ini');
    const testPyPath = join(this.projectRoot, 'test_*.py');
    
    if (existsSync(pytestPath) || existsSync(testPyPath)) {
      return { command: 'pytest', args: [] };
    }
    
    // Check for Go tests
    const goModPath = join(this.projectRoot, 'go.mod');
    if (existsSync(goModPath)) {
      return { command: 'go', args: ['test', './...'] };
    }
    
    // Check for Rust tests
    const cargoTomlPath = join(this.projectRoot, 'Cargo.toml');
    if (existsSync(cargoTomlPath)) {
      return { command: 'cargo', args: ['test'] };
    }
    
    // Check for Ruby tests
    const gemfilePath = join(this.projectRoot, 'Gemfile');
    if (existsSync(gemfilePath)) {
      return { command: 'bundle', args: ['exec', 'rspec'] };
    }
    
    // Default fallback
    return { command: 'npm', args: ['test'] };
  }
  
  private appendLog(type: 'stdout' | 'stderr', text: string): void {
    const buffer = type === 'stdout' ? this.stdoutBuffer : this.stderrBuffer;
    buffer.push(text);
    
    const totalLength = buffer.join('').length;
    if (totalLength > this.maxLogLines * 100) {
      const toRemove = Math.floor(buffer.length / 4);
      buffer.splice(0, toRemove);
    }
  }
}
