import fs from 'node:fs';
import path from 'node:path';
import { CliRuntime } from './cli';
import { artifactPath } from './paths';
import type { RuntimeArtifact, RuntimeType } from './types';

/** Host-native process adapter. Interaction remains in the native application window. */
export class DesktopRuntime extends CliRuntime {
  readonly type: RuntimeType;
  constructor(id: string, projectId: string, runId: string, private readonly root: string, platform: 'macos' | 'linux') {
    super(id, projectId, runId, root);
    this.type = platform;
  }
  async start(artifact: RuntimeArtifact) {
    if (process.platform !== (this.type === 'macos' ? 'darwin' : 'linux')) throw new Error(`${this.type} desktop preview requires its native host`);
    if (this.type === 'macos' && artifact.path.endsWith('.app')) {
      const bundle = artifactPath(this.root, artifact.path);
      const dir = path.join(bundle, 'Contents', 'MacOS');
      const binaries = fs.readdirSync(dir).filter(name => fs.statSync(path.join(dir, name)).isFile());
      if (binaries.length !== 1) throw new Error('App bundle must have one unambiguous executable');
      await super.start({ ...artifact, path: path.relative(this.root, path.join(dir, binaries[0])) });
    } else await super.start(artifact);
  }
  getInfo() { return { ...super.getInfo(), supportsInteraction: false }; }
  getCapabilities() { return { ...super.getCapabilities(), canInteract: false, reason: 'Interact in the native application window' }; }
}
