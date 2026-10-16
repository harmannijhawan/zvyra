// API Runtime - Launch and monitor backend servers with health checks
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

export class ApiRuntime implements IRuntime {
  readonly type: RuntimeType = 'api';
  
  private process: ChildProcess | null = null;
  private state: RuntimeState = 'not_started';
  private artifact: RuntimeArtifact | null = null;
  private port: number | null = null;
  private url: string | null = null;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private exitCode: number | null = null;
  private error: string | null = null;
  
  private stdoutBuffer: string[] = [];
  private stderrBuffer: string[] = [];
  private readonly maxLogLines = 3000;
  
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
      port: this.port ?? undefined,
      url: this.url ?? undefined,
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
      canRestart: this.state === 'running',
      canScreenshot: false,
      canInteract: false,
    };
  }
  
  async start(artifact: RuntimeArtifact): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      throw new Error('Runtime already running');
    }
    
    // Resolve artifact path
    const serverPath = join(this.projectRoot, artifact.path);
    
    if (!existsSync(serverPath)) {
      this.state = 'failed';
      this.error = `Server file not found: ${serverPath}`;
      throw new Error(this.error);
    }
    
    this.artifact = artifact;
    this.state = 'starting';
    this.startedAt = Date.now();
    this.error = null;
    this.exitCode = null;
    
    try {
      // Detect server type and command
      const { command, args } = this.detectServerCommand(serverPath);
      
      // Find available port
      this.port = await this.findAvailablePort();
      
      // Set environment with PORT
      const env = {
        ...process.env,
        PORT: String(this.port),
        NODE_ENV: 'development',
      };
      
      // Spawn the server
      this.process = spawn(command, args, {
        cwd: this.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      
      // Capture stdout
      this.process.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        this.appendLog('stdout', text);
        
        // Try to detect URL from logs
        if (!this.url) {
          this.url = this.extractUrlFromLogs(text);
        }
        
        // Try to detect port from logs
        if (!this.port || this.port === 0) {
          const detectedPort = this.extractPortFromLogs(text);
          if (detectedPort) {
            this.port = detectedPort;
          }
        }
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
          this.error = `Server exited with code ${code}`;
        } else if (signal) {
          this.state = 'crashed';
          this.error = `Server killed by signal ${signal}`;
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
      
      // Wait for server to be ready
      await this.waitForServer();
      
      // Build URL if we have port
      if (this.port && !this.url) {
        this.url = `http://localhost:${this.port}`;
      }
      
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
      // Try graceful shutdown
      this.process.kill('SIGTERM');
      
      // Wait up to 5 seconds for graceful shutdown
      const timeout = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
      
      // Wait for exit
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
    await this.stop();
    
    if (!this.artifact) {
      throw new Error('No artifact to restart');
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    await this.start(this.artifact);
  }
  
  async healthCheck(): Promise<HealthCheck> {
    if (!this.process || this.state !== 'running') {
      return {
        healthy: false,
        message: `Server not running (state: ${this.state})`,
        timestamp: Date.now(),
      };
    }
    
    // Check process is alive
    try {
      process.kill(this.process.pid!, 0);
    } catch {
      return {
        healthy: false,
        message: 'Process not responding',
        timestamp: Date.now(),
      };
    }
    
    // Try HTTP health check if we have a URL
    if (this.url) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        
        const response = await fetch(this.url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'SWARM-Runtime-HealthCheck' },
        });
        
        clearTimeout(timeout);
        
        if (response.ok || response.status === 404) {
          // 404 is fine - server is responding
          return {
            healthy: true,
            timestamp: Date.now(),
          };
        } else {
          return {
            healthy: false,
            message: `Server responded with status ${response.status}`,
            timestamp: Date.now(),
          };
        }
      } catch (err: any) {
        if (err.name === 'AbortError') {
          return {
            healthy: false,
            message: 'Health check timeout',
            timestamp: Date.now(),
          };
        }
        return {
          healthy: false,
          message: `Health check failed: ${err.message}`,
          timestamp: Date.now(),
        };
      }
    }
    
    // No URL to check, just verify process
    return {
      healthy: true,
      message: 'Process running (no URL for health check)',
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
  
  private detectServerCommand(serverPath: string): { command: string; args: string[] } {
    if (serverPath.endsWith('.js') || serverPath.endsWith('.mjs')) {
      return { command: 'node', args: [serverPath] };
    }
    
    if (serverPath.endsWith('.ts')) {
      // Check for tsx or ts-node
      try {
        require.resolve('tsx');
        return { command: 'npx', args: ['tsx', serverPath] };
      } catch {
        return { command: 'npx', args: ['ts-node', serverPath] };
      }
    }
    
    if (serverPath.endsWith('.py')) {
      return { command: 'python', args: [serverPath] };
    }
    
    if (serverPath.endsWith('.go')) {
      return { command: 'go', args: ['run', serverPath] };
    }
    
    if (serverPath.endsWith('.rb')) {
      return { command: 'ruby', args: [serverPath] };
    }
    
    // Assume executable
    return { command: serverPath, args: [] };
  }
  
  private async findAvailablePort(): Promise<number> {
    // Try common development ports
    const portsToTry = [3000, 3001, 8000, 8080, 8081, 5000, 5001, 4000];
    
    for (const port of portsToTry) {
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    
    // Generate random port
    return 3000 + Math.floor(Math.random() * 7000);
  }
  
  private async isPortAvailable(port: number): Promise<boolean> {
    const net = await import('node:net');
    
    return new Promise((resolve) => {
      const server = net.createServer();
      
      server.once('error', () => {
        resolve(false);
      });
      
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      
      server.listen(port);
    });
  }
  
  private async waitForServer(): Promise<void> {
    const maxAttempts = 30; // 15 seconds
    
    for (let i = 0; i < maxAttempts; i++) {
      // Check if process crashed
      if (!this.process || this.state === 'crashed') {
        throw new Error('Server process crashed during startup');
      }
      
      // If we have a URL, try to connect
      if (this.url) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 500);
          
          const response = await fetch(this.url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'SWARM-Runtime-Startup' },
          });
          
          clearTimeout(timeout);
          
          if (response.ok || response.status === 404) {
            return; // Server is up
          }
        } catch {
          // Not ready yet
        }
      }
      
      // Look for startup indicators in logs
      const recentLogs = this.stdoutBuffer.slice(-10).join('\n').toLowerCase();
      if (
        recentLogs.includes('listening') ||
        recentLogs.includes('started') ||
        recentLogs.includes('ready') ||
        recentLogs.includes('running')
      ) {
        // Give it a moment more
        await new Promise(resolve => setTimeout(resolve, 500));
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Timeout - but don't fail if process is still running
    if (this.process && !this.process.killed) {
      console.warn('[api-runtime] Server startup timeout, but process is running');
    } else {
      throw new Error('Server failed to start within timeout');
    }
  }
  
  private extractUrlFromLogs(text: string): string | null {
    // Look for common URL patterns in logs
    const urlPatterns = [
      /https?:\/\/[^\s]+/i,
      /listening on[:\s]+([^\s]+)/i,
      /server[:\s]+([^\s]+)/i,
    ];
    
    for (const pattern of urlPatterns) {
      const match = text.match(pattern);
      if (match) {
        const url = match[1] || match[0];
        if (url.startsWith('http')) {
          return url.trim();
        }
      }
    }
    
    return null;
  }
  
  private extractPortFromLogs(text: string): number | null {
    // Look for port numbers in logs
    const portPatterns = [
      /port[:\s]+(\d+)/i,
      /listening on[:\s]+(?:.*:)?(\d+)/i,
      /:(\d{4,5})/,
    ];
    
    for (const pattern of portPatterns) {
      const match = text.match(pattern);
      if (match) {
        const port = parseInt(match[1], 10);
        if (port >= 1024 && port <= 65535) {
          return port;
        }
      }
    }
    
    return null;
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
