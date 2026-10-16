// Projects are first-class: folder on disk + metadata, memory and history in SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import type { Project, ProjectMemory, Run } from '../../shared/types';
import { db } from '../core/db';
import { emit } from '../core/bus';
import { getSettings, updateSettings } from '../core/settings';
import { uid } from '../core/util';

export function workspaceRoot(): string {
  const s = getSettings();
  const root = s.workspace.root || path.join(app.getPath('documents'), 'SWARM Projects');
  if (!s.workspace.root) updateSettings({ workspace: { root } });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function emptyMemory(objective = ''): ProjectMemory {
  return { objective, summary: '', completedTasks: [], unresolved: [], decisions: [], architecture: '', lastRunOutcome: '', commands: {} };
}

function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'project';
}

function uniqueDir(base: string): string {
  let dir = base; let i = 2;
  while (fs.existsSync(dir)) dir = `${base}-${i++}`;
  return dir;
}

export function saveProject(p: Project): Project {
  p.updatedAt = Date.now();
  db().put('projects', p.id, p, { updated_at: p.updatedAt });
  emit('PROJECT_UPDATED', p.name, { projectId: p.id }, 'debug', { project: p });
  return p;
}

export function getProject(id: string): Project | null { return db().get<Project>('projects', id); }

export function listProjects(opts: { archived?: boolean; query?: string } = {}): Project[] {
  let list = db().list<Project>('projects', '', [], 'updated_at DESC');
  if (opts.archived !== undefined) list = list.filter((p) => p.archived === opts.archived);
  if (opts.query) {
    const q = opts.query.toLowerCase();
    list = list.filter((p) => p.name.toLowerCase().includes(q) || p.objective.toLowerCase().includes(q) || p.memory.summary.toLowerCase().includes(q));
  }
  return list;
}

export function createProject(input: { name?: string; objective?: string; path?: string; isDemo?: boolean }): Project {
  const name = (input.name || input.objective?.split(/[.\n]/)[0]?.slice(0, 60) || 'Untitled project').trim();
  const external = !!input.path;
  const dir = input.path ? path.resolve(input.path) : uniqueDir(path.join(workspaceRoot(), slug(name)));
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const p: Project = {
    id: uid('pr_'), name, path: dir, objective: input.objective ?? '', status: 'idle', favorite: false, archived: false,
    isDemo: !!input.isDemo, external, createdAt: now, updatedAt: now, lastOpenedAt: now, lastRunId: null,
    memory: emptyMemory(input.objective ?? ''), settings: { webResearch: getSettings().research.defaultOn, autonomy: null, stack: null },
  };
  db().put('projects', p.id, p, { updated_at: now });
  emit('PROJECT_CREATED', `Project created: ${name}`, { projectId: p.id }, 'success', { project: p, path: dir });
  return p;
}

export function updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'favorite' | 'archived' | 'objective' | 'settings' | 'status' | 'lastOpenedAt'>>): Project {
  const p = getProject(id);
  if (!p) throw new Error('Project not found');
  Object.assign(p, patch);
  return saveProject(p);
}

export function duplicateProject(id: string): Project {
  const src = getProject(id);
  if (!src) throw new Error('Project not found');
  const copy = createProject({ name: `${src.name} copy`, objective: src.objective });
  fs.cpSync(src.path, copy.path, { recursive: true, filter: (s) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(s.slice(src.path.length)) });
  copy.memory = structuredClone(src.memory);
  return saveProject(copy);
}

/** Deletes project metadata. Files are moved to the OS trash (recoverable) unless keepFiles. */
export async function deleteProject(id: string, keepFiles: boolean) {
  const p = getProject(id);
  if (!p) return;
  if (!keepFiles && !p.external && fs.existsSync(p.path)) {
    try { await shell.trashItem(p.path); } catch { /* leave files if trash fails */ }
  }
  const d = db();
  d.tx(() => {
    for (const t of ['runs', 'sources', 'findings', 'file_changes', 'commands', 'screenshots', 'artifacts'] as const) d.delete(t, 'project_id = ?', [id]);
    d.prepare('DELETE FROM events WHERE project_id = ?').run(id);
    d.delete('projects', 'id = ?', [id]);
  });
  emit('PROJECT_DELETED', `Project deleted: ${p.name}`, {}, 'info', { projectId: id });
}

export function listRuns(projectId?: string, limit = 100): Run[] {
  return projectId
    ? db().list<Run>('runs', 'project_id = ?', [projectId], 'started_at DESC', limit)
    : db().list<Run>('runs', '', [], 'started_at DESC', limit);
}

export const DEMO_OBJECTIVE = 'Build me a modern full-stack sneaker store for Delhi called "Delhi Sneaker Store". Research current publicly available information from the web (popular sneaker brands and price ranges in India, sneaker culture and stores in Delhi), use the findings in the site, create the UI, implement a frontend and a Node.js backend with a products API and cart, run it locally, test it in a browser, visually inspect it, fix issues, and provide the finished project.';

export function ensureDemoProject(): Project {
  const existing = listProjects().find((p) => p.isDemo);
  if (existing) return existing;
  return createProject({ name: 'Delhi Sneaker Store', objective: DEMO_OBJECTIVE, isDemo: true });
}
