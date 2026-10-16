import fs from 'node:fs';
import path from 'node:path';
import type { Run } from '../../shared/types';
import { db } from '../core/db';
import { getProject } from '../projects/projects';
import { getSettings } from '../core/settings';
import { discoverArtifacts } from '../core/artifacts';
import { assessCommand, needsApproval } from '../tools/policy';
import { requestApproval } from '../tools/approvals';
import { runtimeManager } from './manager';
import { artifactPath } from './paths';
import type { RuntimeArtifact } from './types';

/** Resolve an unambiguous real artifact; never substitute a web app for a native target. */
export function previewArtifact(root: string, run: Run): RuntimeArtifact {
  const target = run.target ?? run.brief?.platform;
  const kind = target === 'windows' ? 'exe' : target === 'android' ? 'apk' : null;
  if (kind) {
    const artifacts = discoverArtifacts(root, run.startedAt).filter(a => a.kind === kind && !/setup|install|uninstall/i.test(a.path));
    if (artifacts.length !== 1) throw new Error(`Expected one ${kind.toUpperCase()} application artifact; found ${artifacts.length}. Check build results and Files.`);
    return { path: artifacts[0].path, type: kind };
  }
  if (target === 'cli') {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && Object.values(pkg.bin).length === 1 ? Object.values(pkg.bin)[0] : null;
    const start = pkg.scripts?.start?.match(/^(?:node|python(?:3)?)\s+(?:"([^"]+)"|([^\s]+))$/);
    const file = bin ?? start?.[1] ?? start?.[2];
    if (typeof file !== 'string') throw new Error('CLI preview requires a bin entry or a simple node/python start script.');
    artifactPath(root, file);
    return { path: file, type: 'binary' };
  }
  throw new Error(`${target} preview requires its host platform and a supported artifact. Web previews start through the existing test/dev-server flow.`);
}

const launches = new Map<string, Promise<unknown>>();
export async function launchPreview(runId: string) {
  const pending = launches.get(runId);
  if (pending) return pending;
  const operation = (async () => {
    const run = db().get<Run>('runs', runId);
    const project = run && getProject(run.projectId);
    if (!run || !project) throw new Error('Run or project not found');
    const settings = getSettings();
    if (!settings.computer.terminal) throw new Error('Process execution is disabled in Settings');
    if (run.target === 'windows' && !settings.computer.native) throw new Error('Enable native interaction in Settings for Windows preview');
    const artifact = previewArtifact(project.path, run);
    const absolute = artifactPath(project.path, artifact.path);
    const assessment = assessCommand('"' + absolute + '"', project.path, settings.execution.blocked, settings.security.blockDangerous);
    if (assessment.risk === 'blocked') throw new Error(assessment.reason);
    if (needsApproval(assessment.risk, run.options.autonomy) && !await requestApproval({ projectId: project.id, runId, agent: null, kind: 'command', title: 'Launch application preview', detail: absolute, risk: assessment.risk })) throw new Error('Preview launch denied');
    const runtime = await runtimeManager.createRuntime(project.id, runId, run.target!, project.path);
    if (runtime.getInfo().state === 'running') return runtime.getInfo();
    await runtimeManager.startRuntime(runtime.id, artifact);
    return runtime.getInfo();
  })();
  launches.set(runId, operation);
  try { return await operation; } finally { launches.delete(runId); }
}
