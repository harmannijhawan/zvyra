import fs from 'node:fs';
import path from 'node:path';

export function artifactPath(root: string, relative: string): string {
  const base = fs.realpathSync(root);
  const target = fs.realpathSync(path.resolve(base, relative));
  const rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Artifact is outside the project');
  return target;
}

export function androidTool(name: 'adb' | 'aapt'): string {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const exe = name + (process.platform === 'win32' ? '.exe' : '');
  if (name === 'adb') {
    const file = path.join(sdk, 'platform-tools', exe);
    return fs.existsSync(file) ? file : name;
  }
  const builds = path.join(sdk, 'build-tools');
  if (fs.existsSync(builds)) {
    for (const version of fs.readdirSync(builds).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const file = path.join(builds, version, exe);
      if (fs.existsSync(file)) return file;
    }
  }
  return name;
}
