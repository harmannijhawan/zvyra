import type { PlatformType, ManagerBrief } from '../../shared/types';
import { detectPlatform } from './platform';
import { classifyIntent } from './intent';
import fs from 'node:fs';
import path from 'node:path';

export function projectTarget(root: string): PlatformType | null {
  const has = (name: string) => fs.existsSync(path.join(root, name));
  if (has('app/src/main/AndroidManifest.xml')) return 'android';
  const entries = fs.readdirSync(root);
  if (entries.some(f => f.endsWith('.xcodeproj'))) return 'ios';
  if (entries.some(f => f.endsWith('.csproj') && /<UseWPF>true|<UseWindowsForms>true/i.test(fs.readFileSync(path.join(root, f), 'utf8')))) return 'windows';
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.electron) return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
      if (pkg.bin) return 'cli';
      if (deps.react || deps.vue || deps.next || deps.vite) return 'web';
      if (deps.express || deps.fastify) return 'api';
    } catch { /* Let execution report invalid project metadata. */ }
  }
  return null;
}

export function resolveTarget(objective: string, previous?: PlatformType | null): PlatformType {
  const instruction = objective.split('\n\nConversation requirements and context:')[0].trim();
  const intent = classifyIntent(instruction, true);
  if (intent.intent === 'RESEARCH') throw new Error('Research belongs in Chat. It does not create a Build project.');
  if (!intent.shouldStartRun) throw new Error('Use Chat for this request. To execute, describe what to build and its target platform.');
  // Explicit operating systems outrank framework keywords (React Native is not Web).
  const explicit = instruction.match(/\b(android|windows|macos|linux|ios|iphone|ipad|cli|api|library|backend)\b/i)?.[1]?.toLowerCase();
  let platform = (explicit ? ({ iphone: 'ios', ipad: 'ios' } as Record<string, string>)[explicit] ?? explicit : detectPlatform(instruction)?.platform ?? previous) as PlatformType | undefined;
  if (platform === 'desktop') platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  if (platform === 'mobile') throw new Error('Choose Android or iOS in your build objective.');
  if (!platform) throw new Error('Choose a target: Web, Windows, Android, macOS, Linux, iOS, CLI, Backend, API, or Library.');
  return platform;
}
export function projectTypeFor(platform: PlatformType): ManagerBrief['projectType'] {
  return ({ web: 'web_app', windows: 'desktop_app', macos: 'desktop_app', linux: 'desktop_app', desktop: 'desktop_app', android: 'mobile_app', ios: 'mobile_app', mobile: 'mobile_app', cli: 'cli_tool', backend: 'backend_service', api: 'api_service', library: 'library' } as const)[platform];
}
