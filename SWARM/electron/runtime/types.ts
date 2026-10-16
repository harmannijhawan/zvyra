// Runtime type system for universal preview/execution across platforms
import type { PlatformType } from '../../shared/types';

export type RuntimeType = 
  | 'web'
  | 'windows'
  | 'macos'
  | 'linux'
  | 'ios'
  | 'android'
  | 'cli'
  | 'api'
  | 'library';

export type RuntimeState = 
  | 'not_started'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'failed'
  | 'unavailable';

export interface RuntimeInfo {
  id: string;
  type: RuntimeType;
  state: RuntimeState;
  projectId: string;
  runId: string;
  
  // Artifact information
  artifact?: string;
  artifactType?: string;
  
  // Process information
  pid?: number;
  port?: number;
  url?: string;
  
  // Status
  startedAt?: number;
  stoppedAt?: number;
  exitCode?: number;
  error?: string;
  
  // Capabilities
  supportsScreenshots: boolean;
  supportsInteraction: boolean;
  supportsReload: boolean;
  
  // Logs
  stdout?: string;
  stderr?: string;
}

export interface RuntimeCapabilities {
  canStart: boolean;
  canStop: boolean;
  canRestart: boolean;
  canScreenshot: boolean;
  canInteract: boolean;
  reason?: string; // If capability is unavailable
}

export interface RuntimeArtifact {
  path: string;
  type: 'exe' | 'apk' | 'app' | 'ipa' | 'binary' | 'web' | 'server';
  size?: number;
  created?: number;
}

export interface HealthCheck {
  healthy: boolean;
  message?: string;
  timestamp: number;
}

/**
 * Base interface for all runtime implementations
 */
export interface IRuntime {
  readonly id: string;
  readonly type: RuntimeType;
  readonly projectId: string;
  readonly runId: string;
  
  getInfo(): RuntimeInfo;
  getCapabilities(): RuntimeCapabilities;
  
  start(artifact: RuntimeArtifact): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  
  healthCheck(): Promise<HealthCheck>;
  
  sendInput?(input: string): boolean;
  screenshot?(): Promise<string>; // Returns base64 or file path
  
  getLogs(): { stdout: string; stderr: string };
  clearLogs(): void;
  
  dispose(): Promise<void>;
}

/**
 * Map platform type to runtime type
 */
export function platformToRuntimeType(platform: PlatformType): RuntimeType {
  const mapping: Record<PlatformType, RuntimeType> = {
    web: 'web',
    windows: 'windows',
    android: 'android',
    macos: 'macos',
    linux: 'linux',
    desktop: 'windows',
    ios: 'ios',
    mobile: 'android',
    cli: 'cli',
    backend: 'api',
    api: 'api',
    library: 'library',
  };
  return mapping[platform] ?? 'web';
}

/**
 * Detect runtime type from artifact
 */
export function detectRuntimeType(artifactPath: string): RuntimeType | null {
  const ext = artifactPath.split('.').pop()?.toLowerCase();
  
  if (ext === 'exe') return 'windows';
  if (ext === 'app') return 'macos';
  if (ext === 'apk') return 'android';
  if (ext === 'ipa') return 'ios';
  if (['html', 'css'].includes(ext ?? '')) return 'web';
  if (['js', 'cjs', 'mjs', 'py', 'sh', 'cmd', 'bat'].includes(ext ?? '')) return 'cli';
  
  // Check if it's a binary/executable
  if (!ext || ext === 'out' || ext === 'bin') return 'cli';
  
  return null;
}
