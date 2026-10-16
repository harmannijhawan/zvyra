// Toolchain Discovery: detect available development tools on the system
import { timeOperation } from './performance';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execAsync = promisify(exec);

export interface ToolchainInfo {
  tool: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  usable: boolean;
  error: string | null;
}

export interface ToolchainRegistry {
  node: ToolchainInfo;
  npm: ToolchainInfo;
  pnpm: ToolchainInfo;
  python: ToolchainInfo;
  java: ToolchainInfo;
  gradle: ToolchainInfo;
  androidSdk: ToolchainInfo;
  adb: ToolchainInfo;
  dotnet: ToolchainInfo;
  msbuild: ToolchainInfo;
  rust: ToolchainInfo;
  cargo: ToolchainInfo;
  flutter: ToolchainInfo;
  xcode: ToolchainInfo;
  swift: ToolchainInfo;
  gcc: ToolchainInfo;
  make: ToolchainInfo;
  javac: ToolchainInfo;
  git: ToolchainInfo;
  docker: ToolchainInfo;
  emulator: ToolchainInfo;
}

const defaultToolchainInfo = (tool: string): ToolchainInfo => ({
  tool,
  installed: false,
  version: null,
  path: null,
  usable: false,
  error: null,
});

/**
 * Check if a command exists and get its version
 */
async function checkCommand(
  command: string,
  versionFlag: string = '--version',
  versionRegex: RegExp = /(\d+\.\d+[\.\d]*)/
): Promise<Omit<ToolchainInfo, 'tool'>> {
  try {
    const { stdout, stderr } = await execAsync(`${command} ${versionFlag}`, {
      timeout: 5000,
      windowsHide: true,
    });
    const output = stdout + stderr;
    const versionMatch = output.match(versionRegex);
    const version = versionMatch ? versionMatch[1] : output.split('\n')[0].slice(0, 50);
    
    return {
      installed: true,
      version,
      path: null, // Could use 'which' or 'where' to get path
      usable: true,
      error: null,
    };
  } catch (error) {
    return {
      installed: false,
      version: null,
      path: null,
      usable: false,
      error: (error as Error).message,
    };
  }
}

/**
 * Check if a directory exists
 */
function checkDirectory(dirPath: string): boolean {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Discover Android SDK
 */
async function discoverAndroidSdk(): Promise<Omit<ToolchainInfo, 'tool'>> {
  // Common Android SDK locations
  const possiblePaths = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Android', 'Sdk'),
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
    'C:\\Android\\sdk',
    '/usr/local/android-sdk',
    '/opt/android-sdk',
  ].filter(Boolean) as string[];
  
  for (const sdkPath of possiblePaths) {
    if (checkDirectory(sdkPath)) {
      // Check for platform-tools (adb)
      const platformTools = path.join(sdkPath, 'platform-tools');
      const buildTools = path.join(sdkPath, 'build-tools');
      
      if (checkDirectory(platformTools) && checkDirectory(buildTools)) {
        // Try to get version from build-tools
        const buildToolVersions = fs.readdirSync(buildTools).filter(v => /^\d+\.\d/.test(v));
        const version = buildToolVersions.length > 0 ? buildToolVersions.sort().reverse()[0] : 'detected';
        
        return {
          installed: true,
          version,
          path: sdkPath,
          usable: true,
          error: null,
        };
      }
    }
  }
  
  return {
    installed: false,
    version: null,
    path: null,
    usable: false,
    error: 'Android SDK not found in common locations',
  };
}

/**
 * Discover .NET SDK
 */
async function discoverDotnet(): Promise<Omit<ToolchainInfo, 'tool'>> {
  try {
    const { stdout } = await execAsync('dotnet --list-sdks', { timeout: 5000, windowsHide: true });
    const sdks = stdout.trim().split('\n');
    if (sdks.length > 0 && sdks[0]) {
      const latestSdk = sdks[sdks.length - 1];
      const versionMatch = latestSdk.match(/^(\d+\.\d+\.\d+)/);
      const version = versionMatch ? versionMatch[1] : 'detected';
      
      return {
        installed: true,
        version,
        path: null,
        usable: true,
        error: null,
      };
    }
  } catch {
    // Fall through to not installed
  }
  
  return {
    installed: false,
    version: null,
    path: null,
    usable: false,
    error: '.NET SDK not installed or not in PATH',
  };
}

/**
 * Discover MSBuild (Windows)
 */
async function discoverMsbuild(): Promise<Omit<ToolchainInfo, 'tool'>> {
  if (process.platform !== 'win32') {
    return {
      installed: false,
      version: null,
      path: null,
      usable: false,
      error: 'MSBuild is Windows-only',
    };
  }
  
  // Try common MSBuild locations
  const programFiles = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const possiblePaths = [
    path.join(programFiles, 'Microsoft Visual Studio', '2022', 'Community', 'MSBuild', 'Current', 'Bin', 'MSBuild.exe'),
    path.join(programFiles, 'Microsoft Visual Studio', '2022', 'Professional', 'MSBuild', 'Current', 'Bin', 'MSBuild.exe'),
    path.join(programFiles, 'Microsoft Visual Studio', '2022', 'Enterprise', 'MSBuild', 'Current', 'Bin', 'MSBuild.exe'),
    path.join(programFiles, 'Microsoft Visual Studio', '2019', 'Community', 'MSBuild', 'Current', 'Bin', 'MSBuild.exe'),
  ];
  
  for (const msbuildPath of possiblePaths) {
    if (fs.existsSync(msbuildPath)) {
      try {
        const { stdout } = await execAsync(`"${msbuildPath}" /version`, { timeout: 5000, windowsHide: true });
        const versionMatch = stdout.match(/(\d+\.\d+\.\d+)/);
        const version = versionMatch ? versionMatch[1] : 'detected';
        
        return {
          installed: true,
          version,
          path: msbuildPath,
          usable: true,
          error: null,
        };
      } catch {
        continue;
      }
    }
  }
  
  // Try PATH
  return await checkCommand('msbuild', '/version');
}

/**
 * Discover Xcode (macOS)
 */
async function discoverXcode(): Promise<Omit<ToolchainInfo, 'tool'>> {
  if (process.platform !== 'darwin') {
    return {
      installed: false,
      version: null,
      path: null,
      usable: false,
      error: 'Xcode is macOS-only',
    };
  }
  
  try {
    const { stdout } = await execAsync('xcodebuild -version', { timeout: 5000 });
    const versionMatch = stdout.match(/Xcode (\d+\.\d+)/);
    const version = versionMatch ? versionMatch[1] : 'detected';
    
    return {
      installed: true,
      version,
      path: '/Applications/Xcode.app',
      usable: true,
      error: null,
    };
  } catch {
    return {
      installed: false,
      version: null,
      path: null,
      usable: false,
      error: 'Xcode not installed',
    };
  }
}

/**
 * Discover all available toolchains
 */
export async function discoverToolchains(): Promise<ToolchainRegistry> {
  const android = await discoverAndroidSdk();
  const sdkCommand = (folder: string, name: string) => android.path ? `"${path.join(android.path, folder, name + (process.platform === 'win32' ? '.exe' : ''))}"` : name;
  const extra = Promise.all([checkCommand('javac', '-version'), checkCommand('git'), checkCommand('docker'), checkCommand(sdkCommand('emulator', 'emulator'), '-version')]);
  const [
    node,
    npm,
    pnpm,
    python,
    java,
    gradle,
    androidSdk,
    adb,
    dotnet,
    msbuild,
    rust,
    cargo,
    flutter,
    xcode,
    swift,
    gcc,
    make,
  ] = await Promise.all([
    checkCommand('node', '--version'),
    checkCommand('npm', '--version'),
    checkCommand('pnpm', '--version'),
    checkCommand('python', '--version'),
    checkCommand('java', '-version', /version "?(\d+[\.\d]*)/),
    checkCommand('gradle', '--version'),
    Promise.resolve(android),
    checkCommand(sdkCommand('platform-tools', 'adb'), 'version'),
    discoverDotnet(),
    discoverMsbuild(),
    checkCommand('rustc', '--version'),
    checkCommand('cargo', '--version'),
    checkCommand('flutter', '--version'),
    discoverXcode(),
    checkCommand('swift', '--version'),
    checkCommand('gcc', '--version'),
    checkCommand('make', '--version'),
  ]);
  
  const [javac, git, docker, emulator] = await extra;
  if (android.path && adb.usable) adb.path = path.join(android.path, 'platform-tools', 'adb' + (process.platform === 'win32' ? '.exe' : ''));
  return {
    javac: { tool: 'javac', ...javac }, git: { tool: 'git', ...git }, docker: { tool: 'docker', ...docker }, emulator: { tool: 'emulator', ...emulator },
    node: { tool: 'node', ...node },
    npm: { tool: 'npm', ...npm },
    pnpm: { tool: 'pnpm', ...pnpm },
    python: { tool: 'python', ...python },
    java: { tool: 'java', ...java },
    gradle: { tool: 'gradle', ...gradle },
    androidSdk: { tool: 'androidSdk', ...androidSdk },
    adb: { tool: 'adb', ...adb },
    dotnet: { tool: 'dotnet', ...dotnet },
    msbuild: { tool: 'msbuild', ...msbuild },
    rust: { tool: 'rust', ...rust },
    cargo: { tool: 'cargo', ...cargo },
    flutter: { tool: 'flutter', ...flutter },
    xcode: { tool: 'xcode', ...xcode },
    swift: { tool: 'swift', ...swift },
    gcc: { tool: 'gcc', ...gcc },
    make: { tool: 'make', ...make },
  };
}

/**
 * Get available toolchains as a simple list
 */
export function getAvailableToolchains(registry: ToolchainRegistry): string[] {
  return Object.entries(registry)
    .filter(([_, info]) => info.installed && info.usable)
    .map(([name]) => name);
}

/**
 * Check if required toolchains are available
 */
export function checkRequiredToolchains(
  required: string[],
  registry: ToolchainRegistry
): { available: string[]; missing: string[] } {
  const available: string[] = [];
  const missing: string[] = [];
  
  for (const tool of required) {
    const info = registry[tool as keyof ToolchainRegistry];
    if (info && info.installed && info.usable) {
      available.push(tool);
    } else {
      missing.push(tool);
    }
  }
  
  return { available, missing };
}

/**
 * Cache for toolchain discovery (expires after 5 minutes)
 */
let cachedRegistry: { registry: ToolchainRegistry; timestamp: number } | null = null;
let discovery: Promise<ToolchainRegistry> | null = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Get toolchains with caching
 */
export async function getCachedToolchains(): Promise<ToolchainRegistry> {
  const now = Date.now();
  
  if (cachedRegistry && (now - cachedRegistry.timestamp) < CACHE_DURATION) {
    return cachedRegistry.registry;
  }
  
  const end = timeOperation('toolchain');
  const registry = await (discovery ??= discoverToolchains().finally(() => { discovery = null; })).finally(end);
  cachedRegistry = { registry, timestamp: now };
  
  return registry;
}

/**
 * Invalidate toolchain cache (force rediscovery)
 */
export function peekToolchains() { return cachedRegistry?.registry ?? null; }

export function invalidateToolchainCache(): void {
  cachedRegistry = null;
}
